'use strict';

/**
 * Server-side HLS relay for live TV.
 *
 * Fetches HLS segments directly from Plex's DVR endpoint (not transcoding)
 * and buffers them in memory. Clients connect to /api/stream/live/:roomId/index.m3u8
 * and receive segments from this buffer.
 *
 * Benefits:
 *   • Direct DVR HLS doesn't expire like transcoding sessions
 *   • Keepalive pings keep the DVR subscription alive
 *   • Client URL is stable across retuning (same /live/:roomId/index.m3u8)
 *   • Room is the only Plex client — no per-viewer session management
 */

const axios  = require('axios');
const crypto = require('crypto');

const PLEX_BASE_URL = process.env.LIVETV_PLEX_HOST  || process.env.PLEX_URL   || '';
const PLEX_TOKEN    = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const CLIENT_ID     = process.env.PLEX_CLIENT_ID    || 'movienight-app';

const POLL_MS      = 500;   // segment polling interval
const KEEPALIVE_MS = 3000;  // DVR subscription keepalive interval
const SEG_TIMEOUT  = 15000; // max ms to wait for a segment download
const MAX_SEGS     = 10;    // segments kept in memory (circular buffer)
const READY_SEGS   = 1;     // segments needed before relay is considered ready

class LiveRelay {
  constructor(roomId, { ratingKey, liveSessionKey, grabberId, clientId, onStall }) {
    this.roomId       = roomId;
    this.ratingKey    = String(ratingKey);
    this.liveSessionKey = liveSessionKey; // /livetv/sessions/{uuid} - needed for keepalive
    this.grabberId    = grabberId;         // grabber ID for direct HLS URL
    this.clientId     = clientId || CLIENT_ID;
    this.onStall      = onStall || null;

    this.sessionId  = `mn-relay-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.playbackId = crypto.randomUUID();
    this.bgId       = crypto.randomUUID();
    this.segPrefix  = `r${Date.now().toString(36)}`;

    this.hlsUrl     = null;         // Direct HLS index.m3u8 URL from Plex
    this.segments   = new Map();    // segmentName → Buffer
    this.order      = [];           // segment names in current window (oldest first)
    this.sequence   = 0;            // EXT-X-MEDIA-SEQUENCE for current window start
    this.seen       = new Set();    // all segment names ever fetched (dedup)
    this.targetDur  = 3;            // EXT-X-TARGETDURATION (updated from playlist)
    this.running        = false;
    this.pollTimer      = null;
    this.kaTimer        = null;
    this.startMs        = Date.now();
    this.consecErrors   = 0;
  }

  // ── Start ──────────────────────────────────────────────────
  async start() {
    if (!this.liveSessionKey || !this.grabberId) {
      throw new Error('liveSessionKey and grabberId are required for direct HLS');
    }

    this.running = true;
    this.hlsUrl = `${PLEX_BASE_URL}${this.liveSessionKey}/${this.grabberId}/index.m3u8`;
    console.log(`[Relay] ${this.roomId}: fetching HLS from ${this.hlsUrl}`);

    // Initial fetch to verify the stream works and get segment info
    const text = await this._fetchText(this.hlsUrl);
    this._parseSegments(text);
    
    console.log(`[Relay] ${this.roomId}: started (ratingKey=${this.ratingKey}, grabber=${this.grabberId})`);
    this._poll();
    this._startKeepalive();
  }

  // ── Segment polling loop ───────────────────────────────────
  _poll() {
    if (!this.running) return;
    this._doOnePoll()
      .then(() => { this.consecErrors = 0; })
      .catch(err => {
        this.consecErrors++;
        console.warn(`[Relay] ${this.roomId}: poll error (${this.consecErrors}/2) — ${err.message}`);
      })
      .finally(() => {
        if (this.running) this.pollTimer = setTimeout(() => this._poll(), POLL_MS);
      });
  }

  async _doOnePoll() {
    const text = await this._fetchText(this.hlsUrl);
    this._parseSegments(text);
  }

  _parseSegments(text) {
    const lines = text.split('\n');
    const segs = [];
    let extinf = false;

    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('#EXT-X-TARGETDURATION:')) {
        const d = parseFloat(t.split(':')[1]);
        if (!isNaN(d)) this.targetDur = d;
      } else if (t.startsWith('#EXTINF:')) {
        extinf = true;
      } else if (extinf && t && !t.startsWith('#')) {
        extinf = false;
        // Segment URL from direct HLS - names like "0.ts", "1.ts", etc.
        const rawName = t.split('/').pop();
        const name = `${this.segPrefix}-${rawName}`;
        const url = t.startsWith('http') ? t : `${this.hlsUrl.substring(0, this.hlsUrl.lastIndexOf('/') + 1)}${t}`;
        segs.push({ name, url });
      }
    }

    for (const { name, url } of segs) {
      if (this.seen.has(name)) continue;
      this.seen.add(name);
      this._fetchBin(url).then(buf => {
        if (buf) {
          this.segments.set(name, buf);
          this.order.push(name);
          if (this.order.length > MAX_SEGS) {
            this.segments.delete(this.order.shift());
            this.sequence++;
          }
        }
      }).catch(e => {
        console.warn(`[Relay] ${this.roomId}: segment ${name} failed — ${e.message}`);
      });
    }
  }

  // ── DVR subscription keepalive ─────────────────────────────
  _startKeepalive() {
    this.kaTimer = setInterval(() => {
      if (!this.running) return;
      
      const elapsed = Date.now() - this.startMs;

      // Keepalive to /:/timeline with the session key
      axios.get(`${PLEX_BASE_URL}/:/timeline`, {
        params: {
          'X-Plex-Token'              : PLEX_TOKEN,
          'X-Plex-Client-Identifier'  : this.clientId,
          'X-Plex-Session-Identifier' : this.sessionId,
          'X-Plex-Session-Id'         : this.bgId,
          'X-Plex-Playback-Session-Id': this.playbackId,
          ratingKey: this.ratingKey,
          key    : this.liveSessionKey,
          state  : 'playing',
          time   : elapsed,
          hasMDE : 1,
        }
      }).catch(() => {});

      // Background session ping
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

  // ── Public accessors ───────────────────────────────────────
  isReady() {
    return this.order.length >= READY_SEGS;
  }

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

  getSegment(name) {
    return this.segments.get(name) || null;
  }

  // ── Stop ───────────────────────────────────────────────────
  stop() {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.kaTimer)   { clearInterval(this.kaTimer); this.kaTimer = null; }
    this.segments.clear();
    this.order = [];
    this.seen.clear();
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
}

// ── Registry ───────────────────────────────────────────────
const relays = new Map();

async function startRelay(roomId, opts) {
  const existing = relays.get(roomId);
  const relay = new LiveRelay(roomId, opts);

  try {
    await relay.start();
  } catch (err) {
    throw err;
  }

  // Wait until ready
  await new Promise(resolve => {
    const t = setInterval(() => {
      if (relay.isReady()) { clearInterval(t); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(t); resolve(); }, 10000);
  });

  // Swap
  relays.set(roomId, relay);
  if (existing) existing.stop();

  return relay;
}

function stopRelay(roomId) {
  const relay = relays.get(roomId);
  if (relay) { relay.stop(); relays.delete(roomId); }
}

function getRelay(roomId) {
  return relays.get(roomId) || null;
}

module.exports = { startRelay, stopRelay, getRelay };