'use strict';

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const livetv   = require('../livetv-manager');

const router = express.Router();
const VALID_HLS_FILE = /^(index\.m3u8|seg\d+\.ts)$/;

const DELAY_SEGMENTS  = parseInt(process.env.LIVETV_DELAY_SEGMENTS  ?? '3',  10); // 6s delay (3 × 2s)
const WINDOW_SEGMENTS = parseInt(process.env.LIVETV_WINDOW_SEGMENTS ?? '30', 10); // 60s window (30 × 2s)

// GET /api/livetv/guide
router.get('/guide', async (req, res) => {
  try {
    res.json(await livetv.getGuide());
  } catch {
    res.status(500).json({ error: 'Failed to fetch guide', channels: [] });
  }
});

// POST /api/livetv/channel — called internally from sync.js
router.post('/channel', (req, res) => {
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  livetv.switchChannel(String(channel));
  res.json({ channel });
});

// GET /api/livetv/hls/index.m3u8 — rewritten sliding-window manifest
router.get('/hls/index.m3u8', (req, res) => {
  const manifestPath = path.join(livetv.getHlsDir(), 'index.m3u8');
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch { return res.status(503).json({ error: 'Stream not ready' }); }

  const lines = raw.split('\n');
  const seqMatch = raw.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  if (!seqMatch) return res.status(503).json({ error: 'Stream not ready' });
  const baseSeq = parseInt(seqMatch[1], 10);

  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      segments.push({ inf: lines[i], file: lines[i + 1] });
    }
  }

  if (segments.length < DELAY_SEGMENTS + 3) {
    return res.status(503).json({ error: 'Stream not ready' });
  }

  const end    = segments.length - DELAY_SEGMENTS;
  const start  = Math.max(0, end - WINDOW_SEGMENTS);
  const window = segments.slice(start, end);
  const newSeq = baseSeq + start;

  const header = lines
    .filter(l => l.startsWith('#EXT') && !l.startsWith('#EXTINF') && !l.startsWith('#EXT-X-MEDIA-SEQUENCE'))
    .join('\n');

  const body     = window.map(s => `${s.inf}\n${s.file}`).join('\n');
  const manifest = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${newSeq}\n${header}\n${body}\n`;

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(manifest);
});

// GET /api/livetv/hls/:file — serve .ts segments directly
router.get('/hls/:file', (req, res) => {
  const file = req.params.file;
  if (!VALID_HLS_FILE.test(file)) return res.status(400).json({ error: 'Invalid file' });
  res.sendFile(path.join(livetv.getHlsDir(), file), (err) => {
    if (err && !res.headersSent) {
      res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'File not found' });
    }
  });
});

/**
 * Compute the target video.currentTime for the delayed live edge.
 * All clients should sync to this value so they converge on the same position.
 * Returns null if the stream isn't ready.
 */
function getLiveEdgeTime() {
  const manifestPath = path.join(livetv.getHlsDir(), 'index.m3u8');
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); } catch { return null; }

  const seqMatch = raw.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
  if (!seqMatch) return null;
  const baseSeq = parseInt(seqMatch[1], 10);

  const lines = raw.split('\n');
  const durations = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXTINF:')) {
      durations.push(parseFloat(lines[i].split(':')[1]));
    }
  }

  if (durations.length < DELAY_SEGMENTS + 3) return null;

  const end = durations.length - DELAY_SEGMENTS;

  // Estimate PTS offset for segments pruned from the manifest
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  const prunedTime = baseSeq * avgDur;

  // Sum durations of visible segments up to the delayed live edge
  let windowTime = 0;
  for (let i = 0; i < end; i++) windowTime += durations[i];

  // Subtract liveSyncDuration (2s) to match HLS.js target position
  return prunedTime + windowTime - 2;
}

module.exports = router;
module.exports.getLiveEdgeTime = getLiveEdgeTime;
