'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const axios      = require('axios');

const HLS_DIR          = process.env.LIVETV_HLS_DIR || path.join(os.tmpdir(), 'livetv-hls');
const HDHR_IP          = process.env.HDHR_IP || '';
const HDHR_PORT        = process.env.HDHR_PORT || '5004';
const IDLE_TIMEOUT_MS  = 60_000; // stop ffmpeg after 60s with no heartbeat
const PLEX_HOST        = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN       = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const GUIDE_TTL_MS       = 300_000; // 5 min — channel lineup is stable
const NOW_PLAYING_TTL_MS = 120_000; // 2 min — refresh program info frequently

let ffmpegProc    = null;
let currentChan   = null;
let idleTimer     = null;

let channelsCache     = null;
let channelsFetchedAt = 0;
let cachedEpgId       = null;
let nowPlayingCache     = null;
let nowPlayingFetchedAt = 0;

// Ensure HLS directory exists on module load
fs.mkdirSync(HLS_DIR, { recursive: true });

function getHlsDir() { return HLS_DIR; }

function clearHls() {
  try {
    for (const f of fs.readdirSync(HLS_DIR)) {
      fs.unlinkSync(path.join(HLS_DIR, f));
    }
  } catch {}
}

function stopFfmpeg() {
  if (ffmpegProc) {
    ffmpegProc.kill('SIGKILL');
    ffmpegProc = null;
  }
}

async function probeSource(url) {
  const runProbe = (url, selectStreams, readSeconds) => new Promise((resolve) => {
    const args = [
      '-v', 'quiet', '-print_format', 'json', '-show_streams',
      '-select_streams', selectStreams,
      '-read_intervals', `%+${readSeconds}`,
      '-analyzeduration', `${readSeconds * 1_000_000}`,
      '-probesize', `${readSeconds * 1_000_000}`,
      url,
    ];
    let stdout = '';
    let settled = false;
    const proc = spawn('ffprobe', args);
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      proc.kill('SIGKILL'); resolve(null);
    }, (readSeconds + 1) * 1000);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('close', () => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { resolve(JSON.parse(stdout).streams?.[0] || null); } catch { resolve(null); }
    });
    proc.on('error', () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null); } });
  });

  const vs = await runProbe(url, 'v:0', 5);
  const as = await runProbe(url, 'a:0', 3);
  if (!vs) return null;

  const [fn, fd] = (vs.avg_frame_rate || vs.r_frame_rate || '0/1').split('/');
  const fps = fd && fd !== '0' ? parseFloat(fn) / parseFloat(fd) : 0;
  const isInterlaced = vs.field_order ? !['progressive', 'unknown', ''].includes(vs.field_order) : false;

  return {
    videoCodec:  vs.codec_name || '',
    fps,
    isInterlaced,
    audioCodec:  as?.codec_name || '',
  };
}

function buildFfmpegArgs(url, probe) {
  const SEG_DURATION = 2;

  // ── Video ────────────────────────────────────────────────────────────────────
  let videoArgs;
  if (probe?.videoCodec === 'h264') {
    // Direct passthrough: zero CPU, no quality loss, perfect A/V sync
    videoArgs = ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb'];
  } else {
    const fps     = probe?.fps > 0 ? probe.fps : 29.97;
    const gopSize = Math.ceil(fps * SEG_DURATION); // keyframe every segment boundary
    videoArgs = [
      ...(probe?.isInterlaced ? ['-vf', 'yadif=mode=0'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-tune', 'zerolatency',
      '-g', String(gopSize), '-sc_threshold', '0', '-keyint_min', String(gopSize),
    ];
  }

  // ── Audio ────────────────────────────────────────────────────────────────────
  const audioArgs = probe?.audioCodec === 'aac'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', 'aresample=async=1000'];

  return [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '10M', '-probesize', '10M',
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:0',
    ...videoArgs,
    ...audioArgs,
    '-f', 'hls',
    '-hls_time', String(SEG_DURATION),
    '-hls_list_size', '300',
    '-hls_flags', 'append_list+omit_endlist',
    '-hls_segment_filename', path.join(HLS_DIR, 'seg%05d.ts'),
    path.join(HLS_DIR, 'index.m3u8'),
  ];
}

async function startFfmpeg(channel) {
  stopFfmpeg();
  clearHls();
  currentChan = channel;

  const url = `http://${HDHR_IP}:${HDHR_PORT}/auto/v${channel}`;
  console.log(`[LiveTV] Probing channel ${channel}…`);
  const probe = await probeSource(url);
  console.log(`[LiveTV] Strategy: video=${probe?.videoCodec ?? 'unknown'} fps=${probe?.fps?.toFixed(2) ?? '?'} interlaced=${probe?.isInterlaced ?? '?'} audio=${probe?.audioCodec ?? 'unknown'}`);

  const args = buildFfmpegArgs(url, probe);
  ffmpegProc = spawn('ffmpeg', args, { stdio: 'inherit' });
  ffmpegProc.on('exit', (code) => {
    console.log(`[LiveTV] ffmpeg exited (code=${code})`);
    if (ffmpegProc) {
      ffmpegProc = null;
      setTimeout(() => { if (currentChan) startFfmpeg(currentChan); }, 3000);
    }
  });
}

function switchChannel(channel) {
  if (channel === currentChan && ffmpegProc) return; // already on this channel
  startFfmpeg(channel);
}

function heartbeat() {
  // Reset idle timer — if no heartbeat for IDLE_TIMEOUT_MS, stop ffmpeg
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('[LiveTV] No heartbeat — stopping stream');
    stopFfmpeg();
    currentChan = null;
  }, IDLE_TIMEOUT_MS);

  // If there's a current channel but ffmpeg died, restart it
  if (currentChan && !ffmpegProc) {
    startFfmpeg(currentChan);
  }
}

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
    // For series episodes show "Show: Episode"; for movies/specials just the title
    programs[key] = v.grandparentTitle ? `${v.grandparentTitle}: ${v.title}` : (v.title || '');
  }
  return programs;
}

async function getGuide() {
  const now     = Date.now();
  const headers = buildHeaders();

  // Refresh channel list if stale
  if (!channelsCache || now - channelsFetchedAt >= GUIDE_TTL_MS) {
    try {
      channelsCache     = await fetchChannels(headers);
      channelsFetchedAt = now;
      nowPlayingCache   = null; // invalidate so callSign map re-resolves
    } catch (err) {
      console.error('[LiveTV] guide fetch error:', err.message);
      if (!channelsCache) return { channels: [] };
    }
  }

  // Refresh now-playing if stale
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

module.exports = { switchChannel, heartbeat, getGuide, stopFfmpeg, getHlsDir };
