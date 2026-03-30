const express = require('express');
const router = express.Router();
const axios = require('axios');
const liveTvManager = require('../livetv-manager');

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const LIVETV_PLEX_URL   = process.env.LIVETV_PLEX_HOST  || PLEX_URL;
const LIVETV_PLEX_TOKEN = process.env.LIVETV_PLEX_TOKEN || PLEX_TOKEN;
const CLIENT_ID = process.env.PLEX_CLIENT_ID || 'movienight-app';

// Map to track LiveTV channelId per room (needed for retune on bust)
const livetvChannelIds = new Map(); // roomId → channelId

// Map to track LiveTV subKey per room (needed to stop subscription on retune)
const livetvSubKeys = new Map(); // roomId → subKey

// Map to track the current LiveTV ratingKey per room (for redirecting stale requests)
const livetvCurrentRatingKeys = new Map(); // roomId → currentRatingKey

// Cache the master manifest per room+movie so only the first viewer
// calls start.m3u8. Latecomers get the cached manifest and share
// the already-running Plex session — no restart, no 400 errors.
// manifestPending holds in-flight fetch Promises so concurrent requests
// (e.g. host + guests all loading after a movie change) coalesce into one
// Plex call rather than racing to start.m3u8 simultaneously.
const manifestCache    = new Map(); // cacheKey → { manifest: string, cachedAt: number }
const manifestPending  = new Map(); // cacheKey → Promise<string>
const activeSessions   = new Map(); // cacheKey → { sessionId, ratingKey, isLive }
const keepaliveTimers  = new Map(); // cacheKey → intervalId
const MANIFEST_TTL_MS  = 4 * 60 * 60 * 1000; // 4 hours — evict stale manifests
const KEEPALIVE_MS     = 3000; // ping Plex every 3s for LiveTV to prevent session cleanup

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
function startKeepalive(cacheKey, sessionId, ratingKey, isLive, plexBaseUrl, plexToken) {
  stopKeepalive(cacheKey);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    const elapsedMs = Date.now() - startedAt;
    // Timeline ping — send advancing time so Plex knows the client is actively
    // consuming the stream. Sending time:0 forever causes Plex to treat the
    // session as inactive and terminate it after ~3 minutes (observed for live TV).
    axios.get(`${plexBaseUrl}/:/timeline`, {
      params: {
        'X-Plex-Token': plexToken,
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Session-Identifier': sessionId,
        ratingKey,
        key: `/library/metadata/${ratingKey}`,
        state: 'playing',
        time: elapsedMs,
        duration: isLive ? 0 : undefined,
        hasMDE: 1
      }
    }).catch(() => {});
    // For live TV, also hit the transcode ping endpoint as belt-and-suspenders
    if (isLive) {
      axios.get(`${plexBaseUrl}/video/:/transcode/universal/ping`, {
        params: { 'X-Plex-Token': plexToken, session: sessionId }
      }).catch(() => {});
    }
  }, KEEPALIVE_MS);
  // Use distinct keys to avoid overwriting - one for main timer, one for live timer
  keepaliveTimers.set(cacheKey + '-main', timer);

  // For LiveTV, proactively refresh the session at 3 minutes to prevent
  // Plex from killing it (~4 min timeout). This creates a new session BEFORE
  // the old one dies, making the transition seamless to clients.
  if (isLive) {
    const PROACTIVE_REFRESH_MS = 3 * 60 * 1000; // 3 minutes
    const proactiveTimer = setTimeout(async () => {
      console.log(`[HLS] Proactive session refresh for ${cacheKey} (3 min mark)`);
      // Get the subKey for this room to stop old subscription
      const roomId = cacheKey.split('-')[0];
      const subKey = livetvSubKeys.get(roomId);
      const oldSubKey = subKey;

      // Stop old subscription and clean stale sessions
      if (oldSubKey) {
        const liveTvManager = require('../livetv-manager');
        await liveTvManager.stopSubscription(oldSubKey).catch(() => {});
      }

      // Clear caches so next request creates fresh session
      stopKeepalive(cacheKey);
      manifestCache.delete(cacheKey);
      activeSessions.delete(cacheKey);

      // Clear the subKey so next tune gets a fresh one
      if (roomId) {
        livetvSubKeys.delete(roomId);
        livetvCurrentRatingKeys.delete(roomId);
      }

      console.log(`[HLS] Proactive refresh complete for ${cacheKey}`);
    }, PROACTIVE_REFRESH_MS);
    keepaliveTimers.set(cacheKey + '-proactive', proactiveTimer);

    // Also use a separate more aggressive keepalive timer (every 1.5s)
    // to ensure Plex doesn't kill the session due to inactivity
    const liveKeepalive = setInterval(() => {
      // Additional transcode ping endpoint for LiveTV
      axios.get(`${plexBaseUrl}/video/:/transcode/universal/ping`, {
        params: { 'X-Plex-Token': plexToken, session: sessionId }
      }).catch(() => {});
      // Also hit the timeline with current time to keep session alive
      const nowMs = Date.now() - startedAt;
      axios.get(`${plexBaseUrl}/:/timeline`, {
        params: {
          'X-Plex-Token': plexToken,
          'X-Plex-Client-Identifier': CLIENT_ID,
          'X-Plex-Session-Identifier': sessionId,
          ratingKey,
          key: `/library/metadata/${ratingKey}`,
          state: 'playing',
          time: nowMs,
          duration: 0,
          hasMDE: 1
        }
      }).catch(() => {});
    }, 1500);
    keepaliveTimers.set(cacheKey + '-live', liveKeepalive);
  }
}

function stopKeepalive(cacheKey) {
  // Clear main keepalive timer
  const timer = keepaliveTimers.get(cacheKey + '-main');
  if (timer) { clearInterval(timer); keepaliveTimers.delete(cacheKey + '-main'); }
  // Clear LiveTV keepalive timer (both old '-live' key and legacy keys for backward compat)
  const liveTimer = keepaliveTimers.get(cacheKey + '-live');
  if (liveTimer) { clearInterval(liveTimer); keepaliveTimers.delete(cacheKey + '-live'); }
  // Clear proactive refresh timer (uses setTimeout, not setInterval)
  const proactiveTimer = keepaliveTimers.get(cacheKey + '-proactive');
  if (proactiveTimer) { clearTimeout(proactiveTimer); keepaliveTimers.delete(cacheKey + '-proactive'); }
  // Clear any remaining timer at the base key (legacy, shouldn't happen but safe to clear)
  const legacyTimer = keepaliveTimers.get(cacheKey);
  if (legacyTimer) { clearInterval(legacyTimer); keepaliveTimers.delete(cacheKey); }
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
        axios.get(`${session.plexBaseUrl}/video/:/transcode/universal/stop`, {
          params: { 'X-Plex-Token': session.plexToken, session: session.sessionId }
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

function rewritePlexUrl(url, baseDir, proxyPrefix = '/api/stream/proxy') {
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
    return `${proxyPrefix}${plexPath}`;
  } catch {
    return url;
  }
}

function rewriteM3u8(content, baseDir, proxyPrefix = '/api/stream/proxy') {
  return content
    .replace(/URI="([^"]+)"/g, (_, url) => `URI="${rewritePlexUrl(url, baseDir, proxyPrefix)}"`)
    .split('\n')
    .map(line => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      return rewritePlexUrl(t, baseDir, proxyPrefix);
    })
    .join('\n');
}

// ── Shared Plex transcode helper ───────────────────────────
// Extracted so the route handler and prewarmManifest share the same logic.
async function callPlexStartM3u8({ plexBaseUrl, plexToken, sessionId, ratingKey, proxyPrefix, offsetMs = 0 }) {
  const params = {
    'X-Plex-Token': plexToken,
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
  const transcodeUrl = `${plexBaseUrl}/video/:/transcode/universal/start.m3u8?${qs}`;
  console.log('[HLS] Starting session:', transcodeUrl.replace(
    new RegExp(plexToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'REDACTED'
  ));
  const plexRes = await axios.get(transcodeUrl, {
    headers: {
      Accept: 'application/x-mpegURL',
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Product': 'Movie Night',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Device-Name': 'Movie Night',
      'X-Plex-Token': plexToken
    }
  });
  return rewriteM3u8(plexRes.data, '/video/:/transcode/universal/', proxyPrefix);
}

// ── HLS transcode start ────────────────────────────────────
router.get('/hls/:roomId/:ratingKey/master.m3u8', async (req, res) => {
  const { roomId, ratingKey } = req.params;
  if (!/^[\w-]+$/.test(ratingKey)) return res.status(400).send('Invalid ratingKey');
  const sessionId = `mn-${roomId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-${ratingKey.slice(0, 24)}`;
  let cacheKey    = `${roomId}-${ratingKey}`;

  // ?bust=1 signals that the client detected a broken stream and needs a fresh
  // Plex session. Evict the stale manifest so we start over below.
  // ?offset=<ms> tells Plex where to begin transcoding so the client can seek
  // straight to the current playback position after reconnecting.
  const bust        = !!req.query.bust;
  const offsetMs    = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const isLive      = !!req.query.live;
  const plexBaseUrl = isLive ? LIVETV_PLEX_URL   : PLEX_URL;
  const plexToken   = isLive ? LIVETV_PLEX_TOKEN  : PLEX_TOKEN;
  const proxyPrefix = isLive ? '/api/stream/proxy-live' : '/api/stream/proxy';

  // For LiveTV: check if client is using a stale ratingKey (e.g., after retune).
  // If so, redirect them to the current one to avoid 400 errors from Plex.
  if (isLive && !bust) {
    const currentRatingKey = livetvCurrentRatingKeys.get(roomId);
    if (currentRatingKey && currentRatingKey !== ratingKey) {
      console.log(`[HLS] Redirecting stale ratingKey ${ratingKey} → ${currentRatingKey} for room ${roomId}`);
      return res.redirect(`/api/stream/hls/${roomId}/${currentRatingKey}/master.m3u8?live=1`);
    }
  }

  // For LiveTV with bust=1, we need to retune to get a fresh Plex session
  // because the old session has expired (~3-4 min for LiveTV)
  let actualRatingKey = ratingKey;
  if (bust && isLive) {
    const channelId = livetvChannelIds.get(roomId);
    if (channelId) {
      console.log(`[HLS] LiveTV bust - retuning to channel ${channelId}`);
      // Delete old subscription first to force a fresh session
      // Get subKey from our map (set by prewarmManifest or select-livetv-channel)
      const oldSubKey = livetvSubKeys.get(roomId);
      if (oldSubKey) {
        console.log(`[HLS] Stopping old subscription ${oldSubKey}`);
        await liveTvManager.stopSubscription(oldSubKey).catch(() => {});
      }
      // Tune to get fresh ratingKey
      const tuneResult = await liveTvManager.tuneChannel(channelId);
      actualRatingKey = tuneResult.ratingKey;
      // Update the subKey map with the new subscription key
      livetvSubKeys.set(roomId, tuneResult.subKey);
      // Track the current ratingKey so stale requests get redirected
      livetvCurrentRatingKeys.set(roomId, actualRatingKey);
      // Update cache key with new ratingKey
      const newCacheKey = `${roomId}-${actualRatingKey}`;
      // Clear old keys
      stopKeepalive(cacheKey);
      manifestCache.delete(cacheKey);
      activeSessions.delete(cacheKey);
      // Update for new session
      cacheKey = newCacheKey;
      console.log(`[HLS] LiveTV retuned to ratingKey=${actualRatingKey}, sub=${tuneResult.subKey}`);
    }
  } else if (bust) {
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

  const fetchManifest = () => callPlexStartM3u8({ plexBaseUrl, plexToken, sessionId, ratingKey: actualRatingKey, proxyPrefix, offsetMs });

  const promise = fetchManifest();
  manifestPending.set(cacheKey, promise);

  try {
    const manifest = await promise;
    manifestCache.set(cacheKey, { manifest, cachedAt: Date.now() });
    activeSessions.set(cacheKey, { sessionId, ratingKey: actualRatingKey, isLive, plexBaseUrl, plexToken });
    startKeepalive(cacheKey, sessionId, actualRatingKey, isLive, plexBaseUrl, plexToken);
    manifestPending.delete(cacheKey);
    res.send(manifest);
  } catch (err) {
    manifestPending.delete(cacheKey);
    console.error('[HLS] Start error:', err.response?.status, err.message);
    res.status(500).send('HLS error');
  }
});

// Pre-start a Plex transcode session and cache its manifest server-side.
// Called by doRetune in sync.js so the manifest is already cached by the time
// clients receive livetv-reload — reducing black-screen time on retune from ~7s to ~2s.
async function prewarmManifest(roomId, ratingKey, isLive, channelId = null, subKey = null) {
  const cacheKey    = `${roomId}-${ratingKey}`;

  // Early return if already cached/pending - but still store channel/sub info first
  if (manifestCache.has(cacheKey) || manifestPending.has(cacheKey)) {
    // Still store LiveTV metadata even if manifest is cached
    if (isLive && channelId) {
      livetvChannelIds.set(roomId, channelId);
    }
    if (isLive && subKey) {
      livetvSubKeys.set(roomId, subKey);
    }
    if (isLive) {
      livetvCurrentRatingKeys.set(roomId, ratingKey);
    }
    return;
  }

  // Store channelId for LiveTV so we can retune on bust=1
  if (isLive && channelId) {
    livetvChannelIds.set(roomId, channelId);
  }
  // Store subKey for LiveTV so we can stop the subscription on retune
  if (isLive && subKey) {
    livetvSubKeys.set(roomId, subKey);
  }
  // Track the current ratingKey for LiveTV rooms
  if (isLive) {
    livetvCurrentRatingKeys.set(roomId, ratingKey);
  }

  const plexBaseUrl = isLive ? LIVETV_PLEX_URL   : PLEX_URL;
  const plexToken   = isLive ? LIVETV_PLEX_TOKEN  : PLEX_TOKEN;
  const proxyPrefix = isLive ? '/api/stream/proxy-live' : '/api/stream/proxy';
  const sessionId   = `mn-${roomId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-${ratingKey.slice(0, 24)}`;
  const promise     = callPlexStartM3u8({ plexBaseUrl, plexToken, sessionId, ratingKey, proxyPrefix });
  manifestPending.set(cacheKey, promise);
  try {
    const manifest = await promise;
    manifestCache.set(cacheKey, { manifest, cachedAt: Date.now() });
    activeSessions.set(cacheKey, { sessionId, ratingKey, isLive, plexBaseUrl, plexToken });
    startKeepalive(cacheKey, sessionId, ratingKey, isLive, plexBaseUrl, plexToken);
    manifestPending.delete(cacheKey);
  } catch (err) {
    manifestPending.delete(cacheKey);
    throw err;
  }
}

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
async function handleProxy(req, res, plexBaseUrl, plexToken, proxyPrefix) {
  const plexPath = '/' + req.params[0];

  if (!ALLOWED_PROXY_PATH.test(plexPath)) {
    return res.status(403).send('Forbidden');
  }

  const looksLikeM3u8 =
    plexPath.endsWith('.m3u8') || plexPath.includes('/index.m3u8');

  try {
    const response = await axios({
      method: 'GET',
      url: `${plexBaseUrl}${plexPath}`,
      params: { ...filterProxyParams(req.query), 'X-Plex-Token': plexToken },
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
      const baseDir = plexPath.substring(0, plexPath.lastIndexOf('/') + 1);
      const chunks = [];
      response.data.on('data', c => chunks.push(c));
      response.data.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        res.send(rewriteM3u8(text, baseDir, proxyPrefix));
      });
    } else {
      // Stream directly (TS, m4s segments, etc.)
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
}

router.get('/proxy/*',      (req, res) => handleProxy(req, res, PLEX_URL,        PLEX_TOKEN,        '/api/stream/proxy'));
router.get('/proxy-live/*', (req, res) => handleProxy(req, res, LIVETV_PLEX_URL, LIVETV_PLEX_TOKEN, '/api/stream/proxy-live'));

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

module.exports = { router, clearRoomManifest, prewarmManifest };
