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
const GUIDE_TTL_MS     = 60_000;

let ffmpegProc    = null;
let currentChan   = null;
let idleTimer     = null;
let guideCache    = null;
let guideFetchedAt = 0;

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
    ffmpegProc.kill('SIGTERM');
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-tune', 'zerolatency',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-af', 'aresample=async=1000',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '20',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(HLS_DIR, 'seg%05d.ts'),
    path.join(HLS_DIR, 'index.m3u8'),
  ];

  ffmpegProc = spawn('ffmpeg', args, { stdio: 'inherit' });
  ffmpegProc.on('exit', (code) => {
    console.log(`[LiveTV] ffmpeg exited (code=${code})`);
    if (ffmpegProc) { // not a deliberate stop
      ffmpegProc = null;
      // Auto-restart after brief delay if we still have a current channel
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

async function getGuide() {
  const now = Date.now();
  if (guideCache && now - guideFetchedAt < GUIDE_TTL_MS) return guideCache;

  try {
    const headers = { Accept: 'application/json' };
    if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;

    // Step 1: get the EPG provider identifier from the first DVR entry
    const dvrsRes = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
    const epgId = dvrsRes.data?.MediaContainer?.Dvr?.[0]?.epgIdentifier;
    if (!epgId) throw new Error('No DVR/EPG identifier found');

    // Step 2: fetch the channel list from the EPG provider
    const { data } = await axios.get(`${PLEX_HOST}/${epgId}/lineups/dvr/channels`, { headers, timeout: 10000 });
    const channels = (data?.MediaContainer?.Channel || []).map(ch => ({
      number: ch.vcn   || '',
      title:  ch.title || ch.callSign || '',
      thumb:  ch.thumb || null,
    }));
    guideCache     = { channels };
    guideFetchedAt = now;
    return guideCache;
  } catch (err) {
    console.error('[LiveTV] guide fetch error:', err.message);
    return guideCache || { channels: [] };
  }
}

module.exports = { switchChannel, heartbeat, getGuide, stopFfmpeg, getHlsDir };
