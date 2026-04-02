'use strict';

/**
 * Server-side HLS relay for live TV.
 *
 * Instead of proxying Plex directly to clients (which causes session expiry
 * at ~4 min), the server fetches HLS segments from Plex continuously and
 * buffers them in memory. Clients connect to /api/stream/live/:roomId/index.m3u8
 * and receive segments from this buffer.
 *
 * Benefits:
 *   • Plex sees constant active segment consumption → session never expires
 *   • Keepalive pings + segment fetching together prevent DVR subscription TTL
 *   • Client URL is stable across retuning (same /live/:roomId/index.m3u8)
 *   • Room is the only Plex client — no per-viewer session management
 */

const axios  = require('axios');
const crypto = require('crypto');

const PLEX_BASE_URL = process.env.LIVETV_PLEX_HOST  || process.env.PLEX_URL   || '';
const PLEX_TOKEN    = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const CLIENT_ID     = process.env.PLEX_CLIENT_ID    || 'movienight-app';

const POLL_MS      = 500;   // variant playlist poll interval (reduced for faster segment fetching)
const KEEPALIVE_MS = 3000;   // DVR subscription keepalive interval (~2.6s in native Plex)
const SEG_TIMEOUT  = 15000;  // max ms to wait for a segment download
const MAX_SEGS     = 10;     // segments kept in memory (circular buffer)
const READY_SEGS   = 1;      // segments needed before relay is considered ready (reduced for faster swap)
const STALL_THRESH        = 2;       // consecutive poll errors before triggering onStall (fallback)
const PROACTIVE_RETUNE_MS = 200_000; // 3:20 — proactive retune before 4-min DVR session expiry

class LiveRelay {
  constructor(roomId, { ratingKey, liveSessionKey, clientId, onStall }) {
    this.roomId       = roomId;
    this.ratingKey    = String(ratingKey);
    this.liveSessionKey = liveSessionKey || null; // /livetv/sessions/{uuid}
    this.clientId     = clientId || CLIENT_ID;
    this.onStall      = onStall || null;          // called after STALL_THRESH consecutive errors

    // Unique IDs for this relay's Plex session.
    // sessionId must be unique per relay instance — reusing the same ID across a
    // warm-swap causes Plex to treat the new relay as a duplicate client and
    // kill the shared transcode session, breaking both old and new relays.
    this.sessionId  = `mn-relay-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.playbackId = crypto.randomUUID();
    this.bgId       = crypto.randomUUID();
    this.segPrefix  = `r${Date.now().toString(36)}`; // unique prefix to avoid segment name collisions across retunes

    this.variantUrl = null;
    this.segments   = new Map();   // segmentName → Buffer
    this.order      = [];          // segment names in current window (oldest first)
    this.sequence   = 0;           // EXT-X-MEDIA-SEQUENCE for current window start
    this.targetDur  = 3;           // EXT-X-TARGETDURATION (updated from playlist)
    this.running        = false;
    this.pollTimer      = null;
    this.kaTimer        = null;
    this.proactiveTimer = null;
    this.startMs        = Date.now();
    this.consecErrors   = 0;       // consecutive poll errors (reset on success)
  }

  // ── Start ──────────────────────────────────────────────────
  async start() {
    this.running = true;
    const masterUrl  = this._buildMasterUrl();
    console.log(`[Relay] ${this.roomId}: masterUrl = ${masterUrl.slice(0,200)}`);
    const masterText = await this._fetchText(masterUrl);
    const baseDir    = `${PLEX_BASE_URL}/video/:/transcode/universal/`;
    this.variantUrl  = this._pickVariant(masterText, baseDir);
    console.log(`[Relay] ${this.roomId}: started (ratingKey=${this.ratingKey})`);
    this._poll();
    this._startKeepalive();
    // Disabled proactive retune - it causes 400 errors from Plex
    // The keepalive + polling should keep the session alive
  }

  // Build start.m3u8 URL with all required Plex params
  _buildMasterUrl() {
    const params = {
      'X-Plex-Token'              : PLEX_TOKEN,
      'X-Plex-Client-Identifier'  : this.clientId,
      'X-Plex-Session-Identifier' : this.sessionId,
      'X-Plex-Product'            : 'Movie Night',
      'X-Plex-Platform'           : 'Chrome',
      'X-Plex-Platform-Version'   : '120.0',
      'X-Plex-Device'             : 'Windows',
      'X-Plex-Device-Name'        : 'Movie Night',
      'X-Plex-Playback-Session-Id': this.playbackId,
      'X-Plex-Session-Id'         : this.bgId,
      hasMDE                      : '1',
      path                        : `/library/metadata/${this.ratingKey}`,
      videoResolution             : '1920x1080',
      maxVideoBitrate             : '8000',
      videoCodec                  : 'h264',
      audioCodec                  : 'aac',
      protocol                    : 'hls',
      copyts                      : '1',
      mediaIndex                  : '0',
      partIndex                   : '0',
      fastSeek                    : '1',
    };
    // Build query string manually — axios encodes '/' as '%2F' in query params,
    // but Plex requires literal slashes in the 'path' parameter.
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${k === 'path' ? v : encodeURIComponent(v)}`)
      .join('&');
    return `${PLEX_BASE_URL}/video/:/transcode/universal/start.m3u8?${qs}`;
  }

  // ── Segment polling loop ───────────────────────────────────
  _poll() {
    if (!this.running) return;
    this._doOnePoll()
      .then(() => { this.consecErrors = 0; })
      .catch(err => {
        this.consecErrors++;
        console.warn(`[Relay] ${this.roomId}: poll error (${this.consecErrors}/${STALL_THRESH}) — ${err.message}`);
        if (this.consecErrors === STALL_THRESH && this.onStall) {
          console.warn(`[Relay] ${this.roomId}: stall threshold reached — triggering retune`);
          this.onStall();
        }
      })
      .finally(() => {
        if (this.running) this.pollTimer = setTimeout(() => this._poll(), POLL_MS);
      });
  }

  async _doOnePoll() {
    const text = await this._fetchText(this.variantUrl);
    const segs = this._parseSegs(text, this.variantUrl);

    for (const { name, url } of segs) {
      // Only fetch if not already in buffer - don't use seen set since Plex
      // reuses segment names in its rolling window
      if (this.segments.has(name)) continue;
      try {
        const buf = await this._fetchBin(url);
        this.segments.set(name, buf);
        this.order.push(name);
        // Evict oldest to stay within buffer limit
        if (this.order.length > MAX_SEGS) {
          this.segments.delete(this.order.shift());
          this.sequence++;
        }
      } catch (e) {
        console.warn(`[Relay] ${this.roomId}: segment ${name} failed — ${e.message}`);
      }
    }
  }

  // ── DVR subscription keepalive ─────────────────────────────
  // Mirrors what the native Plex web client sends to prevent the ~4 min
  // DVR subscription TTL from expiring.
  _startKeepalive() {
    this.kaTimer = setInterval(() => {
      const elapsed = Date.now() - this.startMs;
      const key = this.liveSessionKey || `/library/metadata/${this.ratingKey}`;

      axios.get(`${PLEX_BASE_URL}/:/timeline`, {
        params: {
          'X-Plex-Token'              : PLEX_TOKEN,
          'X-Plex-Client-Identifier'  : this.clientId,
          'X-Plex-Session-Identifier' : this.sessionId,
          'X-Plex-Session-Id'         : this.bgId,
          'X-Plex-Playback-Session-Id': this.playbackId,
          ratingKey: this.ratingKey,
          key,
          state   : 'playing',
          time    : elapsed,
          hasMDE  : 1,
        }
      }).catch(() => {});

      axios.get(`${PLEX_BASE_URL}/status/sessions/background`, {
        params: {
          'X-Plex-Token'              : PLEX_TOKEN,
          'X-Plex-Client-Identifier'  : this.clientId,
          'X-Plex-Session-Id'         : this.bgId,
          'X-Plex-Playback-Session-Id': this.playbackId,
        }
      }).catch(() => {});
    }, KEEPALIVE_MS);
  }

  // ── Switch to a different channel ───────────────────────────
  // Called when user changes channels. Keeps same Plex session IDs so
  // we maintain a single persistent connection to Plex.
  async switchChannel(newRatingKey, newLiveSessionKey, newOnStall) {
    if (!this.running) throw new Error('Relay not running');
    const oldRatingKey = this.ratingKey;
    this.ratingKey = String(newRatingKey);
    this.liveSessionKey = newLiveSessionKey || null;
    if (newOnStall !== undefined) this.onStall = newOnStall;
    this.segments.clear();
    this.order = [];
    this.sequence = 0;
    this.consecErrors = 0;
    this.startMs = Date.now();
    // Fetch new variant playlist
    const masterUrl = this._buildMasterUrl();
    const masterText = await this._fetchText(masterUrl);
    const baseDir = `${PLEX_BASE_URL}/video/:/transcode/universal/`;
    this.variantUrl = this._pickVariant(masterText, baseDir);
    console.log(`[Relay] ${this.roomId}: switched channel ${oldRatingKey} → ${this.ratingKey}`);
  }

  // ── Public accessors ───────────────────────────────────────
  /** True once enough segments are buffered to start playback without gaps. */
  isReady() {
    return this.order.length >= READY_SEGS;
  }

  /** Returns an HLS playlist pointing at our own segment endpoint, or null if no segments yet. */
  getPlaylist() {
    if (this.order.length === 0) return null;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(this.targetDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${this.sequence}`,
    ];
    for (const name of this.order) {
      lines.push(`#EXTINF:${this.targetDur.toFixed(3)},`);
      lines.push(`/api/stream/live/${this.roomId}/${name}`);
    }
    return lines.join('\n') + '\n';
  }

  /** Returns the buffered segment data, or null if evicted / not yet fetched. */
  getSegment(name) {
    return this.segments.get(name) || null;
  }

  // ── Stop ───────────────────────────────────────────────────
  stop() {
    this.running = false;
    if (this.pollTimer)      { clearTimeout(this.pollTimer);       this.pollTimer      = null; }
    if (this.kaTimer)        { clearInterval(this.kaTimer);        this.kaTimer        = null; }
    if (this.proactiveTimer) { clearTimeout(this.proactiveTimer);  this.proactiveTimer = null; }
    this.segments.clear();
    this.order = [];
    this.seen.clear();
    // Best-effort stop of the Plex transcode session so it doesn't idle on the server
    axios.get(`${PLEX_BASE_URL}/video/:/transcode/universal/stop`, {
      params: { 'X-Plex-Token': PLEX_TOKEN, session: this.sessionId }
    }).catch(() => {});
    console.log(`[Relay] ${this.roomId}: stopped`);
  }

  // ── HTTP helpers ───────────────────────────────────────────
  async _fetchText(url) {
    const r = await axios.get(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN },
      timeout: 10000,
    });
    return typeof r.data === 'string' ? r.data : String(r.data);
  }

  async _fetchBin(url) {
    const r = await axios.get(url, {
      headers: { 'X-Plex-Token': PLEX_TOKEN },
      responseType: 'arraybuffer',
      timeout: SEG_TIMEOUT,
    });
    return Buffer.from(r.data);
  }

  // ── Manifest parsing ───────────────────────────────────────
  /** Choose highest-bandwidth variant from the master playlist. */
  _pickVariant(masterText, baseDir) {
    const lines = masterText.split('\n');
    let best = { bw: -1, uri: null }, pendingBw = 0;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-STREAM-INF:')) {
        const m = t.match(/BANDWIDTH=(\d+)/i);
        pendingBw = m ? +m[1] : 0;
      } else if (t && !t.startsWith('#')) {
        if (pendingBw >= best.bw) best = { bw: pendingBw, uri: t };
        pendingBw = 0;
      }
    }
    if (!best.uri) throw new Error('No variant stream in master playlist');
    return this._resolve(best.uri, baseDir);
  }

  /** Parse segment entries from a variant playlist. */
  _parseSegs(text, fromUrl) {
    const dirUrl = fromUrl.substring(0, fromUrl.lastIndexOf('/') + 1);
    const lines  = text.split('\n');
    const out    = [];
    let extinf   = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-TARGETDURATION:')) {
        const d = parseFloat(t.split(':')[1]);
        if (!isNaN(d)) this.targetDur = d;
      } else if (t.startsWith('#EXTINF:')) {
        extinf = true;
      } else if (extinf && t && !t.startsWith('#')) {
        extinf = false;
        // Strip query string for dedup key (tokens may vary); use path only
        const stripped = t.split('?')[0];
        const rawName  = stripped.split('/').pop();
        // Prefix with unique ID to avoid segment name collisions across retunes
        const name     = `${this.segPrefix}-${rawName}`;
        const url      = this._resolve(stripped, dirUrl);
        out.push({ name, url });
      } else if (t && !t.startsWith('#')) {
        extinf = false;
      }
    }
    return out;
  }

  _resolve(uri, baseDir) {
    if (uri.startsWith('http')) return uri;
    if (uri.startsWith('/'))    return PLEX_BASE_URL + uri;
    return baseDir + uri;
  }
}

// ── Registry ───────────────────────────────────────────────
const relays = new Map(); // roomId → LiveRelay

/**
 * Start (or switch channel on) the relay for a room.
 *
 * If an existing relay is running, we call switchChannel() to reuse the same
 * Plex session IDs, maintaining a single persistent connection.
 */
async function startRelay(roomId, opts) {
  const existing = relays.get(roomId);
  
  if (existing) {
    // Reuse existing relay - same Plex session, new channel
    await existing.switchChannel(opts.ratingKey, opts.liveSessionKey, opts.onStall);
    // Wait for segments to buffer
    await new Promise(resolve => {
      const t = setInterval(() => {
        if (existing.isReady()) { clearInterval(t); resolve(); }
      }, 200);
      setTimeout(() => { clearInterval(t); resolve(); }, 10000);
    });
    console.log(`[Relay] ${roomId}: reusing existing relay for ratingKey=${opts.ratingKey}`);
    return existing;
  }
  
  const relay = new LiveRelay(roomId, opts);

  // Start the new relay — fetches master playlist and begins segment polling.
  // The existing relay (if any) keeps serving clients during this time.
  try {
    await relay.start();
  } catch (err) {
    throw err;
  }

  // Wait until the new relay has enough segments to serve without gaps (max 10s).
  await new Promise(resolve => {
    const t = setInterval(() => {
      if (relay.isReady()) { clearInterval(t); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(); }, 10000);
  });

  // Atomically swap: new relay takes over, old relay stops.
  relays.set(roomId, relay);
  if (existing) existing.stop();

  return relay;
}

/** Stop and clean up the relay for a room. */
function stopRelay(roomId) {
  const relay = relays.get(roomId);
  if (relay) { relay.stop(); relays.delete(roomId); }
}

/** Get the active relay for a room, or null. */
function getRelay(roomId) {
  return relays.get(roomId) || null;
}

module.exports = { startRelay, stopRelay, getRelay };
