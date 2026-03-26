const express = require('express');
const router = express.Router();
const axios = require('axios');

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const CLIENT_ID = process.env.PLEX_CLIENT_ID || 'movienight-app';

// Cache the master manifest per room+movie so only the first viewer
// calls start.m3u8. Latecomers get the cached manifest and share
// the already-running Plex session — no restart, no 400 errors.
// manifestPending holds in-flight fetch Promises so concurrent requests
// (e.g. host + guests all loading after a movie change) coalesce into one
// Plex call rather than racing to start.m3u8 simultaneously.
const manifestCache    = new Map(); // cacheKey → { manifest: string, cachedAt: number }
const manifestPending  = new Map(); // cacheKey → Promise<string>
const activeSessions   = new Map(); // cacheKey → { sessionId, ratingKey }
const keepaliveTimers  = new Map(); // cacheKey → intervalId
const MANIFEST_TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours — evict stale manifests
const KEEPALIVE_MS     = 8000; // ping Plex every 8s to prevent session cleanup

// Periodically evict manifests that haven't been used for MANIFEST_TTL_MS
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of manifestCache.entries()) {
    if (now - entry.cachedAt > MANIFEST_TTL_MS) {
      stopKeepalive(key);
      manifestCache.delete(key);
      activeSessions.delete(key);
    }
  }
}, 30 * 60 * 1000); // run every 30 minutes

// Send periodic timeline pings so Plex doesn't clean up the transcode session.
// Without these, Plex kills the session after ~60s of perceived inactivity,
// causing 404s on segment requests and forcing a full session restart.
function startKeepalive(cacheKey, sessionId, ratingKey) {
  stopKeepalive(cacheKey);
  const timer = setInterval(() => {
    axios.get(`${PLEX_URL}/:/timeline`, {
      params: {
        'X-Plex-Token': PLEX_TOKEN,
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Session-Identifier': sessionId,
        ratingKey,
        key: `/library/metadata/${ratingKey}`,
        state: 'playing',
        time: 0,
        duration: 0,
        hasMDE: 1
      }
    }).catch(() => {}); // ignore errors — best effort
  }, KEEPALIVE_MS);
  keepaliveTimers.set(cacheKey, timer);
}

function stopKeepalive(cacheKey) {
  const timer = keepaliveTimers.get(cacheKey);
  if (timer) { clearInterval(timer); keepaliveTimers.delete(cacheKey); }
}

function clearRoomManifest(roomId) {
  for (const key of manifestCache.keys()) {
    if (key.startsWith(roomId + '-')) {
      stopKeepalive(key);
      // Fire-and-forget: stop the Plex transcode session so the next
      // fetchManifest() starts a clean session rather than reusing a
      // potentially stuck/terminating one with the same session ID.
      const session = activeSessions.get(key);
      if (session) {
        axios.get(`${PLEX_URL}/video/:/transcode/universal/stop`, {
          params: { 'X-Plex-Token': PLEX_TOKEN, session: session.sessionId }
        }).catch(() => {}); // ignore errors — best effort
      }
      manifestCache.delete(key);
      activeSessions.delete(key);
    }
  }
  for (const key of manifestPending.keys()) {
    if (key.startsWith(roomId + '-')) manifestPending.delete(key);
  }
}


// ── M3U8 URL rewriting ─────────────────────────────────────
// Rewrites Plex-internal URLs so all HLS traffic routes through
// our proxy. baseDir is the directory of the m3u8 being rewritten,
// needed to resolve relative segment paths (no leading slash).

function rewritePlexUrl(url, baseDir) {
  try {
    let plexPath;
    if (url.startsWith('http')) {
      const u = new URL(url);
      u.searchParams.delete('X-Plex-Token');
      plexPath = u.pathname + (u.search && u.search !== '?' ? u.search : '');
    } else if (url.startsWith('/')) {
      const u = new URL(`http://x${url}`);
      u.searchParams.delete('X-Plex-Token');
      plexPath = u.pathname + (u.search && u.search !== '?' ? u.search : '');
    } else if (baseDir) {
      // Relative path — resolve against the directory of the parent m3u8
      plexPath = baseDir + url;
    } else {
      return url;
    }
    return `/api/stream/proxy${plexPath}`;
  } catch {
    return url;
  }
}

function rewriteM3u8(content, baseDir) {
  return content
    .replace(/URI="([^"]+)"/g, (_, url) => `URI="${rewritePlexUrl(url, baseDir)}"`)
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return rewritePlexUrl(t, baseDir);
    })
    .join('\n');
}

// ── HLS transcode start ────────────────────────────────────
router.get('/hls/:roomId/:ratingKey/master.m3u8', async (req, res) => {
  const { roomId, ratingKey } = req.params;
  if (!/^\d+$/.test(ratingKey)) return res.status(400).send('Invalid ratingKey');
  const sessionId = `mn-${roomId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-${ratingKey}`;
  const cacheKey  = `${roomId}-${ratingKey}`;

  // ?bust=1 signals that the client detected a broken stream and needs a fresh
  // Plex session. Evict the stale manifest so we start over below.
  // ?offset=<ms> tells Plex where to begin transcoding so the client can seek
  // straight to the current playback position after reconnecting.
  const bust     = !!req.query.bust;
  const offsetMs = Math.max(0, parseInt(req.query.offset, 10) || 0);
  if (bust) {
    stopKeepalive(cacheKey);
    manifestCache.delete(cacheKey);
    activeSessions.delete(cacheKey);
    console.log(`[HLS] Cache busted for ${cacheKey} — starting fresh session at offset ${offsetMs}ms`);
  }

  res.setHeader('Content-Type', 'application/x-mpegURL');
  res.setHeader('Cache-Control', 'no-cache');

  // Serve cached manifest to latecomers — avoids calling start.m3u8 again
  // which would restart the Plex session and kick other viewers.
  // Expired entries are treated as missing so a fresh Plex session is started.
  const cached = manifestCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.cachedAt < MANIFEST_TTL_MS) return res.send(cached.manifest);
    // Stale — evict and fall through to start a fresh session
    stopKeepalive(cacheKey);
    manifestCache.delete(cacheKey);
    activeSessions.delete(cacheKey);
    console.log(`[HLS] Manifest expired for ${cacheKey}, starting fresh session`);
  }

  // If another request is already fetching this manifest (e.g. host + guests
  // all load simultaneously after a movie change), wait for that same Promise
  // rather than firing a second start.m3u8 call which would restart the session.
  if (manifestPending.has(cacheKey)) {
    try {
      return res.send(await manifestPending.get(cacheKey));
    } catch {
      return res.status(500).send('HLS error');
    }
  }

  const fetchManifest = async () => {
    const params = {
      'X-Plex-Token': PLEX_TOKEN,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Session-Identifier': sessionId,
      'X-Plex-Product': 'Movie Night',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Platform-Version': '120.0',
      'X-Plex-Device': 'Windows',
      'X-Plex-Device-Name': 'Movie Night',
      'X-Plex-Version': '1.0.0',
      hasMDE: '1',
      path: `/library/metadata/${ratingKey}`,
      videoResolution: '1920x1080',
      maxVideoBitrate: '8000',
      videoCodec: 'h264',
      audioCodec: 'aac',
      protocol: 'hls',
      copyts: '1',
      mediaIndex: '0',
      partIndex: '0',
      fastSeek: '1',
      ...(offsetMs > 0 ? { offset: offsetMs } : {})
    };

    // Build query string manually — axios encodes '/' as '%2F' in param values,
    // but Plex requires literal slashes in the 'path' parameter.
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${k === 'path' ? v : encodeURIComponent(v)}`)
      .join('&');

    const transcodeUrl = `${PLEX_URL}/video/:/transcode/universal/start.m3u8?${qs}`;
    console.log('[HLS] Starting session:', transcodeUrl.replace(
      new RegExp(PLEX_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'REDACTED'
    ));

    const plexRes = await axios.get(transcodeUrl, {
      headers: {
        Accept: 'application/x-mpegURL',
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Product': 'Movie Night',
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Device-Name': 'Movie Night',
        'X-Plex-Token': PLEX_TOKEN
      }
    });

    const baseDir  = '/video/:/transcode/universal/';
    return rewriteM3u8(plexRes.data, baseDir);
  };

  const promise = fetchManifest();
  manifestPending.set(cacheKey, promise);

  try {
    const manifest = await promise;
    manifestCache.set(cacheKey, { manifest, cachedAt: Date.now() });
    activeSessions.set(cacheKey, { sessionId, ratingKey });
    startKeepalive(cacheKey, sessionId, ratingKey);
    manifestPending.delete(cacheKey);
    res.send(manifest);
  } catch (err) {
    manifestPending.delete(cacheKey);
    console.error('[HLS] Start error:', err.response?.status, err.message);
    res.status(500).send('HLS error');
  }
});

// Only transcode segments/manifests and direct-play part files are valid proxy targets.
const ALLOWED_PROXY_PATH = /^\/(video\/:\/transcode\/universal\/|library\/parts\/)/;

// Strip any query params that could be used for open redirect or SSRF manipulation
const BLOCKED_PROXY_PARAMS = new Set(['redirect', 'url', 'callback', 'next', 'forward', 'dest', 'destination', 'return', 'returnurl', 'returnto']);

function filterProxyParams(query) {
  const filtered = {};
  for (const [k, v] of Object.entries(query)) {
    if (!BLOCKED_PROXY_PARAMS.has(k.toLowerCase())) filtered[k] = v;
  }
  return filtered;
}

// ── General Plex proxy (HLS segments & sub-manifests) ──────
router.get('/proxy/*', async (req, res) => {
  const plexPath = '/' + req.params[0];

  if (!ALLOWED_PROXY_PATH.test(plexPath)) {
    return res.status(403).send('Forbidden');
  }

  const looksLikeM3u8 =
    plexPath.endsWith('.m3u8') || plexPath.includes('/index.m3u8');

  try {
    const response = await axios({
      method: 'GET',
      url: `${PLEX_URL}${plexPath}`,
      params: { ...filterProxyParams(req.query), 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'stream',
      timeout: 5 * 60 * 1000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const ct = response.headers['content-type'] || '';
    const isM3u8 =
      looksLikeM3u8 || ct.includes('mpegURL') || ct.includes('m3u8');

    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');

    if (isM3u8) {
      // Buffer, rewrite internal URLs, send
      // Base dir = directory of this m3u8 path, for resolving relative segment URLs
      const baseDir = plexPath.substring(0, plexPath.lastIndexOf('/') + 1);
      const chunks = [];
      response.data.on('data', c => chunks.push(c));
      response.data.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        res.send(rewriteM3u8(text, baseDir));
      });
    } else {
      // Stream directly (TS segments, etc.)
      response.data.pipe(res);
      req.on('close', () => response.data.destroy());
    }
  } catch (err) {
    const status = err.response?.status || 500;
    console.error(`[HLS] Proxy error ${status} for ${plexPath.substring(0, 80)}:`, err.message);
    if (!res.headersSent) {
      res.status(status).send('Proxy error');
    }
  }
});

// ── Thumbnail proxy ────────────────────────────────────────
router.get('/thumb/:ratingKey', async (req, res) => {
  if (!/^\d+$/.test(req.params.ratingKey)) return res.status(400).send('Invalid ratingKey');
  try {
    const detailRes = await axios.get(
      `${PLEX_URL}/library/metadata/${req.params.ratingKey}`,
      {
        params: { 'X-Plex-Token': PLEX_TOKEN },
        headers: { Accept: 'application/json' }
      }
    );
    const thumb = detailRes.data.MediaContainer.Metadata[0]?.thumb;
    if (!thumb) return res.status(404).send('No thumbnail');

    const imgRes = await axios({
      method: 'GET',
      url: `${PLEX_URL}/photo/:/transcode`,
      params: { url: thumb, width: 300, height: 450, 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'stream',
      timeout: 10000
    });

    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    imgRes.data.pipe(res);
  } catch {
    res.status(404).send('Thumbnail not found');
  }
});

module.exports = { router, clearRoomManifest };
