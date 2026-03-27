'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const axios      = require('axios');
const mediasoup  = require('mediasoup');

const HLS_DIR          = process.env.LIVETV_HLS_DIR || path.join(os.tmpdir(), 'livetv-hls');
const HDHR_IP          = process.env.HDHR_IP || '';
const HDHR_PORT        = process.env.HDHR_PORT || '5004';
const IDLE_TIMEOUT_MS  = 60_000;
const PLEX_HOST        = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN       = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const GUIDE_TTL_MS       = 300_000;
const NOW_PLAYING_TTL_MS = 120_000;

// Resolved at initMediasoup time and refreshed periodically; used by createWebRtcTransport
let resolvedAnnouncedIp = null;
let ipResolvedAt        = 0;
const IP_REFRESH_MS     = 300_000; // re-check public IP every 5 minutes

async function resolveAnnouncedIp() {
  // Static override — never auto-refresh
  if (process.env.WEBRTC_ANNOUNCED_IP) {
    resolvedAnnouncedIp = process.env.WEBRTC_ANNOUNCED_IP;
    ipResolvedAt = Date.now();
    console.log(`[LiveTV] WebRTC announced IP: ${resolvedAnnouncedIp} (from WEBRTC_ANNOUNCED_IP)`);
    return;
  }
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    const newIp = res.data.ip;
    if (newIp !== resolvedAnnouncedIp) {
      console.log(`[LiveTV] WebRTC announced IP: ${newIp} (auto-detected${resolvedAnnouncedIp ? `, was ${resolvedAnnouncedIp}` : ''})`);
    }
    resolvedAnnouncedIp = newIp;
    ipResolvedAt = Date.now();
  } catch {
    // Keep existing IP if we have one; only fall back if this is the first resolve
    if (resolvedAnnouncedIp) {
      console.warn('[LiveTV] Public IP refresh failed — keeping current:', resolvedAnnouncedIp);
      return;
    }
    try {
      resolvedAnnouncedIp = new URL(process.env.APP_URL || 'http://localhost').hostname;
    } catch {
      resolvedAnnouncedIp = '127.0.0.1';
    }
    ipResolvedAt = Date.now();
    console.warn(`[LiveTV] Could not auto-detect public IP — falling back to "${resolvedAnnouncedIp}". ` +
      'Set WEBRTC_ANNOUNCED_IP to your public IP if WebRTC fails for external viewers.');
  }
}

async function getAnnouncedIp() {
  if (!resolvedAnnouncedIp || (Date.now() - ipResolvedAt >= IP_REFRESH_MS && !process.env.WEBRTC_ANNOUNCED_IP)) {
    await resolveAnnouncedIp();
  }
  return resolvedAnnouncedIp || '127.0.0.1';
}

const MEDIA_CODECS = [
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
    },
  },
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
];

let ffmpegProc    = null;
let currentChan   = null;
let idleTimer     = null;

// mediasoup state
let worker        = null;
let router        = null;
let videoPlainTransport = null;
let audioPlainTransport = null;
let videoProducer = null;
let audioProducer = null;

// Per-socket WebRtcTransport  socketId → WebRtcTransport
const clientTransports = new Map();

let channelsCache     = null;
let channelsFetchedAt = 0;
let cachedEpgId       = null;
let nowPlayingCache     = null;
let nowPlayingFetchedAt = 0;

// ── mediasoup init ──────────────────────────────────────────

async function initMediasoup() {
  await resolveAnnouncedIp();
  const rtcMinPort = parseInt(process.env.WEBRTC_PORT_MIN) || 30000;
  const rtcMaxPort = parseInt(process.env.WEBRTC_PORT_MAX) || 30100;
  worker = await mediasoup.createWorker({ logLevel: 'warn', rtcMinPort, rtcMaxPort });
  worker.on('died', () => {
    console.error('[LiveTV] mediasoup worker died — restarting');
    worker = null; router = null;
    videoPlainTransport = null; audioPlainTransport = null;
    videoProducer = null; audioProducer = null;
    initMediasoup().then(() => {
      if (currentChan) startFfmpeg(currentChan);
    }).catch(err => console.error('[LiveTV] mediasoup reinit failed:', err));
  });
  router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  console.log('[LiveTV] mediasoup worker+router ready');
}

// ── HLS dir (kept for compat, not actively used) ────────────

fs.mkdirSync(HLS_DIR, { recursive: true });
function getHlsDir() { return HLS_DIR; }

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
      // Parse resolution: e.g. "1920x1080" or "1280x720"
      const resMatch = stderr.match(/(\d{3,4})x(\d{3,4})/);
      if (resMatch) { info.width = parseInt(resMatch[1]); info.height = parseInt(resMatch[2]); }
      // Parse fps: e.g. "29.97 fps" or "59.94 fps"
      const fpsMatch = stderr.match(/([\d.]+)\s*fps/);
      if (fpsMatch) info.fps = parseFloat(fpsMatch[1]);
      // Detect interlaced: "top first" or "bottom first" in stream info
      info.interlaced = /top first|bottom first|tff|bff/i.test(stderr);
      resolve(info);
    });
    // Timeout after 10 seconds
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 10000);
  });
}

async function startFfmpeg(channel) {
  stopFfmpeg();
  currentChan = channel;

  if (!router) {
    console.error('[LiveTV] mediasoup not ready — cannot start stream');
    return;
  }

  // Close existing plain transports + producers
  if (videoProducer) { try { videoProducer.close(); } catch {} videoProducer = null; }
  if (audioProducer) { try { audioProducer.close(); } catch {} audioProducer = null; }
  if (videoPlainTransport) { try { videoPlainTransport.close(); } catch {} videoPlainTransport = null; }
  if (audioPlainTransport) { try { audioPlainTransport.close(); } catch {} audioPlainTransport = null; }

  // Close all existing client WebRtcTransports so they reconnect
  for (const [sid, t] of clientTransports) {
    try { t.close(); } catch {}
    clientTransports.delete(sid);
  }

  // Create plain transports — comedia:true means mediasoup learns the SSRC from first packet
  videoPlainTransport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: true,
    comedia: true,
  });
  audioPlainTransport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: true,
    comedia: true,
  });

  const videoPort = videoPlainTransport.tuple.localPort;
  const audioPort = audioPlainTransport.tuple.localPort;

  videoProducer = await videoPlainTransport.produce({
    kind: 'video',
    rtpParameters: {
      codecs: [{
        mimeType: 'video/H264',
        payloadType: 97,
        clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
      }],
      encodings: [{ ssrc: 1111 }],
    },
  });

  audioProducer = await audioPlainTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{
        mimeType: 'audio/opus',
        payloadType: 100,
        clockRate: 48000,
        channels: 2,
        parameters: { 'sprop-stereo': 1 },
      }],
      encodings: [{ ssrc: 2222 }],
    },
  });

  const url = `http://${HDHR_IP}:${HDHR_PORT}/auto/v${channel}`;
  const useHw = process.env.LIVETV_HW_ACCEL !== 'none';

  // Probe stream to detect interlacing, resolution, framerate
  const probe = await probeChannel(url);
  // Cap output at ~30fps — WebRTC/browsers drop 30%+ frames at 60fps
  const outputFps = probe.fps > 40 ? probe.fps / 2 : probe.fps;
  const gopSize = Math.round(outputFps) || 30; // ~1 keyframe per second
  console.log(`[LiveTV] Probe: ${probe.width}x${probe.height} ${probe.fps}fps ${probe.interlaced ? 'interlaced' : 'progressive'} → output ${outputFps.toFixed(2)}fps`);
  console.log(`[LiveTV] Starting ffmpeg for channel ${channel} — ${url} (video:${videoPort} audio:${audioPort}, encoder:${useHw ? 'h264_vaapi' : 'libx264'}, gop:${gopSize})`);

  // Build video filter chain based on probe results
  const needFpsDrop = probe.fps > 40;
  const fpsFilterVal = `${Math.round(outputFps * 1000)}/1001`;
  let vfArg = null;

  if (useHw) {
    const parts = [];
    if (probe.interlaced) parts.push('deinterlace_vaapi');
    if (needFpsDrop) {
      // Download from GPU → fps filter on CPU → upload back to GPU
      parts.push('hwdownload', 'format=nv12', `fps=fps=${fpsFilterVal}`, 'hwupload');
    }
    if (parts.length) vfArg = parts.join(',');
  } else {
    const parts = [];
    if (probe.interlaced) parts.push('yadif');
    if (needFpsDrop) parts.push(`fps=fps=${fpsFilterVal}`);
    if (parts.length) vfArg = parts.join(',');
  }

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '5M', '-probesize', '5M',
    '-thread_queue_size', '4096',
    ...(useHw ? ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi'] : []),
    '-i', url,
    // Video output
    '-map', '0:v:0',
    ...(vfArg ? ['-vf', vfArg] : []),
    ...(useHw
      ? ['-c:v', 'h264_vaapi']
      : ['-c:v', 'libx264', '-preset', 'veryfast']),
    '-b:v', '6M', '-maxrate', '6M', '-bufsize', '6M',
    '-g', String(gopSize),
    '-bsf:v', 'dump_extra',
    '-ssrc', '1111', '-payload_type', '97',
    '-f', 'rtp', `rtp://127.0.0.1:${videoPort}`,
    // Audio output
    '-map', '0:a:0',
    '-c:a', 'libopus', '-b:a', '128k', '-ac', '2',
    '-af', 'aresample=async=1000',
    '-ssrc', '2222', '-payload_type', '100',
    '-f', 'rtp', `rtp://127.0.0.1:${audioPort}`,
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

let switchLock = null;
async function switchChannel(channel) {
  if (channel === currentChan && ffmpegProc) return;
  // Serialize — if a switch is already in progress, wait for it then check again
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

// ── WebRTC signaling helpers ────────────────────────────────

function getRouterCapabilities() {
  if (!router) throw new Error('mediasoup not ready');
  return router.rtpCapabilities;
}

async function createWebRtcTransport(socketId) {
  if (!router) throw new Error('mediasoup not ready');

  // Close any previous transport for this socket
  const existing = clientTransports.get(socketId);
  if (existing) { try { existing.close(); } catch {} }

  const listenIps = [];
  // LAN IP first — ICE will prefer it for local clients, reducing latency
  if (process.env.WEBRTC_LAN_IP) {
    listenIps.push({ ip: '0.0.0.0', announcedIp: process.env.WEBRTC_LAN_IP });
  }
  listenIps.push({ ip: '0.0.0.0', announcedIp: await getAnnouncedIp() });

  const transport = await router.createWebRtcTransport({
    listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  clientTransports.set(socketId, transport);

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectWebRtcTransport(socketId, dtlsParameters) {
  const transport = clientTransports.get(socketId);
  if (!transport) throw new Error('No transport for socket ' + socketId);
  await transport.connect({ dtlsParameters });
}

async function createConsumers(socketId, rtpCapabilities) {
  const transport = clientTransports.get(socketId);
  if (!transport) throw new Error('No transport for socket ' + socketId);
  if (!videoProducer || !audioProducer) throw new Error('No producers — channel not started');

  const results = [];
  for (const producer of [videoProducer, audioProducer]) {
    if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
      console.warn(`[LiveTV] Cannot consume ${producer.kind} for socket ${socketId}`);
      continue;
    }
    const consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: false,
    });
    results.push({
      id: consumer.id,
      producerId: producer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });
  }
  return results;
}

function closeConsumer(socketId) {
  const transport = clientTransports.get(socketId);
  if (transport) {
    try { transport.close(); } catch {}
    clientTransports.delete(socketId);
  }
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
  initMediasoup,
  switchChannel,
  heartbeat,
  getGuide,
  stopFfmpeg,
  getHlsDir,
  getRouterCapabilities,
  createWebRtcTransport,
  connectWebRtcTransport,
  createConsumers,
  closeConsumer,
};
