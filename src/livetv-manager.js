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

function startFfmpeg(channel) {
  stopFfmpeg();
  clearHls();
  currentChan = channel;

  const url = `http://${HDHR_IP}:${HDHR_PORT}/auto/v${channel}`;
  console.log(`[LiveTV] Starting ffmpeg for channel ${channel} — ${url}`);

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '10M', '-probesize', '10M',
    '-i', url,
    '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', 'aresample=async=1000',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', '300',
    '-hls_flags', 'append_list+omit_endlist',
    '-hls_segment_filename', path.join(HLS_DIR, 'seg%05d.ts'),
    path.join(HLS_DIR, 'index.m3u8'),
  ];

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
