'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const axios      = require('axios');

const HLS_DIR          = process.env.LIVETV_HLS_DIR || path.join(os.tmpdir(), 'livetv-hls');
const HDHR_IP          = process.env.HDHR_IP || '';
const HDHR_PORT        = process.env.HDHR_PORT || '5004';
const IDLE_TIMEOUT_MS  = 60_000;
const PLEX_HOST        = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN       = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const GUIDE_TTL_MS       = 300_000;
const NOW_PLAYING_TTL_MS = 120_000;

let ffmpegProc    = null;
let currentChan   = null;
let idleTimer     = null;

// fMP4 broadcast state
let initSegment   = null;   // Buffer: ftyp + moov
const clients     = new Set(); // Set of Socket.io sockets

let channelsCache     = null;
let channelsFetchedAt = 0;
let cachedEpgId       = null;
let nowPlayingCache     = null;
let nowPlayingFetchedAt = 0;

// ── HLS dir (kept for compat) ────────────────────────────────
fs.mkdirSync(HLS_DIR, { recursive: true });
function getHlsDir() { return HLS_DIR; }

// ── fMP4 box parser ──────────────────────────────────────────

function createBoxParser(onInit, onFragment) {
  let buf = Buffer.alloc(0);
  let ftypBuf = null;

  return function feed(data) {
    buf = Buffer.concat([buf, data]);

    while (buf.length >= 8) {
      const size = buf.readUInt32BE(0);
      if (size < 8 || size > 50_000_000) {
        // Corrupt — skip a byte and try to recover
        buf = buf.subarray(1);
        continue;
      }
      if (buf.length < size) break; // wait for more data

      const type = buf.toString('ascii', 4, 8);
      const box  = buf.subarray(0, size);
      buf = buf.subarray(size);

      if (type === 'ftyp') {
        ftypBuf = Buffer.from(box);
      } else if (type === 'moov') {
        // Init segment = ftyp + moov
        const moov = Buffer.from(box);
        initSegment = ftypBuf ? Buffer.concat([ftypBuf, moov]) : moov;
        ftypBuf = null;
        onInit(initSegment);
      } else if (type === 'moof') {
        // Fragment = moof + following mdat
        // Peek ahead for mdat
        if (buf.length >= 8) {
          const mdatSize = buf.readUInt32BE(0);
          const mdatType = buf.toString('ascii', 4, 8);
          if (mdatType === 'mdat' && buf.length >= mdatSize) {
            const mdat = buf.subarray(0, mdatSize);
            buf = buf.subarray(mdatSize);
            const fragment = Buffer.concat([box, mdat]);
            onFragment(fragment);
          } else {
            // mdat not complete yet — put moof back and wait
            buf = Buffer.concat([box, buf]);
            break;
          }
        } else {
          // Not enough data for mdat header — put moof back
          buf = Buffer.concat([box, buf]);
          break;
        }
      }
      // Other box types (styp, sidx, etc.) — skip silently
    }
  };
}

// ── ffmpeg ──────────────────────────────────────────────────

function stopFfmpeg() {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGKILL');
    ffmpegProc = null;
  }
}

// Probe a channel URL and return { interlaced, width, height, fps }
function probeChannel(url) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-i', url,
      '-frames:v', '1', '-f', 'null', '/dev/null',
    ];
    let stderr = '';
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      const info = { interlaced: false, width: 0, height: 0, fps: 30 };
      const resMatch = stderr.match(/(\d{3,4})x(\d{3,4})/);
      if (resMatch) { info.width = parseInt(resMatch[1]); info.height = parseInt(resMatch[2]); }
      const fpsMatch = stderr.match(/([\d.]+)\s*fps/);
      if (fpsMatch) info.fps = parseFloat(fpsMatch[1]);
      info.interlaced = /top first|bottom first|tff|bff/i.test(stderr);
      resolve(info);
    });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 10000);
  });
}

async function startFfmpeg(channel) {
  stopFfmpeg();
  currentChan = channel;
  initSegment = null;

  // Signal all clients to reset their MSE
  for (const sock of clients) {
    try { sock.emit('livetv-reset'); } catch {}
  }

  const url = `http://${HDHR_IP}:${HDHR_PORT}/auto/v${channel}`;
  const useHw = process.env.LIVETV_HW_ACCEL !== 'none';

  // Probe stream to detect interlacing, resolution, framerate
  const probe = await probeChannel(url);
  const gopSize = Math.round(probe.fps) || 30;
  console.log(`[LiveTV] Probe: ${probe.width}x${probe.height} ${probe.fps}fps ${probe.interlaced ? 'interlaced' : 'progressive'}`);
  console.log(`[LiveTV] Starting ffmpeg for channel ${channel} — ${url} (encoder:${useHw ? 'h264_vaapi' : 'libx264'}, gop:${gopSize})`);

  // Build video filter chain based on probe results
  const vfFilters = [];
  if (useHw) {
    if (probe.interlaced) vfFilters.push('deinterlace_vaapi');
  } else {
    if (probe.interlaced) vfFilters.push('yadif');
  }

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '5M', '-probesize', '5M',
    '-thread_queue_size', '4096',
    ...(useHw ? ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi'] : []),
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:0',
    ...(vfFilters.length ? ['-vf', vfFilters.join(',')] : []),
    ...(useHw
      ? ['-c:v', 'h264_vaapi']
      : ['-c:v', 'libx264', '-preset', 'veryfast']),
    '-b:v', '6M', '-maxrate', '6M', '-bufsize', '6M',
    '-g', String(gopSize),
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-af', 'aresample=async=1000',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    '-f', 'mp4',
    'pipe:1',
  ];

  ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });

  const parser = createBoxParser(
    // onInit — new init segment ready
    (init) => {
      console.log(`[LiveTV] Init segment ready (${init.length} bytes), ${clients.size} client(s)`);
      for (const sock of clients) {
        try { sock.emit('livetv-init', init); } catch {}
      }
    },
    // onFragment — new media fragment
    (fragment) => {
      for (const sock of clients) {
        try { sock.emit('livetv-fragment', fragment); } catch {}
      }
    },
  );

  ffmpegProc.stdout.on('data', parser);

  ffmpegProc.on('exit', (code) => {
    console.log(`[LiveTV] ffmpeg exited (code=${code})`);
    if (ffmpegProc) {
      ffmpegProc = null;
      setTimeout(() => { if (currentChan) startFfmpeg(currentChan); }, 3000);
    }
  });
}

let switchLock = null;
async function switchChannel(channel) {
  if (channel === currentChan && ffmpegProc) return;
  if (switchLock) await switchLock;
  if (channel === currentChan && ffmpegProc) return;
  switchLock = startFfmpeg(channel);
  await switchLock;
  switchLock = null;
}

function heartbeat() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('[LiveTV] No heartbeat — stopping stream');
    stopFfmpeg();
    currentChan = null;
  }, IDLE_TIMEOUT_MS);

  if (currentChan && !ffmpegProc) {
    startFfmpeg(currentChan);
  }
}

// ── Client management ────────────────────────────────────────

function addClient(socket) {
  clients.add(socket);
  // Send init segment immediately if we have one
  if (initSegment) {
    socket.emit('livetv-init', initSegment);
  }
  console.log(`[LiveTV] Client added (${clients.size} total)`);
}

function removeClient(socket) {
  clients.delete(socket);
  console.log(`[LiveTV] Client removed (${clients.size} total)`);
}

// ── Guide / EPG ─────────────────────────────────────────────

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;
  return headers;
}

async function fetchChannels(headers) {
  if (!cachedEpgId) {
    const dvrsRes = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
    cachedEpgId = dvrsRes.data?.MediaContainer?.Dvr?.[0]?.epgIdentifier;
    if (!cachedEpgId) throw new Error('No DVR/EPG identifier found');
  }
  const { data } = await axios.get(`${PLEX_HOST}/${cachedEpgId}/lineups/dvr/channels`, { headers, timeout: 10000 });
  return (data?.MediaContainer?.Channel || []).map(ch => ({
    number:   ch.vcn || '',
    title:    ch.title || ch.callSign || '',
    thumb:    ch.thumb || null,
    callSign: ch.callSign || ch.vcn || '',
  }));
}

async function fetchNowPlaying(headers) {
  const nowSec = Math.floor(Date.now() / 1000);
  const { data } = await axios.get(`${PLEX_HOST}/livetv/grid`, {
    headers,
    params: { type: 1, begintime: nowSec, endtime: nowSec + 1 },
    timeout: 10000,
  });
  const programs = {};
  for (const v of (data?.MediaContainer?.Video || [])) {
    const key = v.channelCallSign || v.channelID;
    if (!key) continue;
    programs[key] = v.grandparentTitle ? `${v.grandparentTitle}: ${v.title}` : (v.title || '');
  }
  return programs;
}

async function getGuide() {
  const now     = Date.now();
  const headers = buildHeaders();

  if (!channelsCache || now - channelsFetchedAt >= GUIDE_TTL_MS) {
    try {
      channelsCache     = await fetchChannels(headers);
      channelsFetchedAt = now;
      nowPlayingCache   = null;
    } catch (err) {
      console.error('[LiveTV] guide fetch error:', err.message);
      if (!channelsCache) return { channels: [] };
    }
  }

  if (!nowPlayingCache || now - nowPlayingFetchedAt >= NOW_PLAYING_TTL_MS) {
    try {
      nowPlayingCache     = await fetchNowPlaying(headers);
      nowPlayingFetchedAt = now;
    } catch (err) {
      console.error('[LiveTV] now-playing fetch error:', err.message);
      nowPlayingCache = nowPlayingCache || {};
    }
  }

  return {
    channels: channelsCache.map(ch => {
      const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
      const result = { number: ch.number, title: ch.title, thumb: ch.thumb };
      if (prog) result.nowPlaying = prog;
      return result;
    }),
  };
}

module.exports = {
  switchChannel,
  heartbeat,
  getGuide,
  stopFfmpeg,
  getHlsDir,
  addClient,
  removeClient,
};
