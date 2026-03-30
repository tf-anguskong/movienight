const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { clearRoomManifest, prewarmManifest, registerLiveTvSessionKey } = require('./routes/stream');
const plex = require('./plex');
const { sanitizeText } = require('./sanitize');

const rooms        = new Map(); // roomId -> Room
const inviteTokens = new Map(); // inviteToken -> roomId
const socketToRoom = new Map(); // socketId -> Room

let _io = null; // set in setupSync, used by createScheduledRoom
let _enabledRoomTypes = { movie: true, tv: true, youtube: true, livetv: false };

async function fetchYoutubeTitle(videoId) {
  try {
    const res = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 5000
    });
    return res.data?.title || null;
  } catch {
    return null;
  }
}

function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split(/[?#]/)[0] || null;
    if (u.hostname === 'youtube.com' || u.hostname === 'www.youtube.com') {
      return u.searchParams.get('v') || null;
    }
  } catch {}
  return null;
}

class Room {
  constructor({ hostId, hostName, hostPicture, name }) {
    this.id             = uuidv4();
    this.inviteToken    = uuidv4();
    this.name           = (name || `${hostName}'s Room`).slice(0, 60);
    this.hostId         = hostId;
    this.hostName       = hostName;
    this.hostPicture    = hostPicture || null;
    this.hostIsGuest    = false;
    this.hostSocketId   = null;
    this.awaitingHost   = false;
    this.countdownTimer     = null;
    this.intermissionTimer  = null;
    this.intermissionEndsAt = null;
    this.settings       = { playbackLocked: false, reactionsEnabled: true };
    this.roomType       = 'movie'; // 'movie' | 'youtube' | 'tv' | 'livetv'
    this.liveTvChannel      = null;  // e.g. '7.1'
    this.liveTvChannelTitle = null;  // e.g. 'KIRO/CBS'
    this.liveTvChannelId    = null;  // DVR channel ID for re-tuning
    this.liveTvSubKey       = null;  // Plex MediaSubscription key for current tune
    this.movieKey       = null;
    this.movieTitle     = null;
    this.partId         = null;
    this.youtubeVideoId = null;
    this.tvShowKey      = null;
    this.tvShowTitle    = null;
    this.tvEpisodeList  = []; // [{ ratingKey, title, index, parentIndex }]
    this.tvEpisodeIndex = 0;
    this.playing        = false;
    this.position       = 0;
    this.lastUpdate     = Date.now();
    this.viewers        = new Map(); // socketId -> viewer info
  }

  currentPosition() {
    if (!this.playing) return this.position;
    return this.position + (Date.now() - this.lastUpdate) / 1000;
  }

  state() {
    return {
      id: this.id, name: this.name,
      hostId: this.hostId, hostName: this.hostName,
      roomType: this.roomType,
      movieKey: this.movieKey, movieTitle: this.movieTitle, partId: this.partId,
      youtubeVideoId: this.youtubeVideoId,
      tvShowTitle: this.tvShowTitle || null,
      hasNextEpisode: this.roomType === 'tv' && this.tvEpisodeIndex < this.tvEpisodeList.length - 1,
      liveTvChannel:      this.liveTvChannel,
      liveTvChannelTitle: this.liveTvChannelTitle,
      playing: this.playing,
      position: this.currentPosition(),
      lastUpdate: Date.now(),
      settings: this.settings,
      intermissionEndsAt: this.intermissionEndsAt || null
    };
  }

  summary() {
    return {
      id: this.id, name: this.name, hostName: this.hostName,
      roomType: this.roomType,
      movieTitle: this.movieTitle,
      viewerCount: this.viewers.size,
      hasMovie: !!this.movieKey,
      youtubeVideoId: this.youtubeVideoId,
      liveTvChannel: this.liveTvChannel
    };
  }

  broadcast(io, event, data) {
    this.viewers.forEach((_, sid) => io.to(sid).emit(event, data));
  }

  broadcastViewers(io) {
    const now        = Date.now();
    const currentPos = this.playing ? this.currentPosition() : null;
    const viewers = Array.from(this.viewers.values()).map(v => {
      let drift = null;
      if (currentPos !== null && v.reportedTime != null && v.reportedAt != null) {
        const estimated = v.reportedTime + (now - v.reportedAt) / 1000;
        drift = Math.round((estimated - currentPos) * 10) / 10;
      }
      return { ...v, drift, buffering: v.buffering || false };
    });
    this.broadcast(io, 'viewers', viewers);
  }

  broadcastState(io) {
    this.broadcast(io, 'state', this.state());
  }
}

// Resolve an invite token to a room (used by auth route)
function getRoomByInviteToken(token) {
  const roomId = inviteTokens.get(token);
  return roomId ? rooms.get(roomId) : null;
}

function broadcastRoomList(io) {
  io.emit('room-list', Array.from(rooms.values()).map(r => r.summary()));
}


// Per-socket rate limiter — sliding window
function makeSocketRateLimiter(maxCalls, windowMs) {
  const history = new Map(); // socketId -> timestamp[]
  return {
    allow(socketId) {
      const now = Date.now();
      const times = (history.get(socketId) || []).filter(t => now - t < windowMs);
      if (times.length >= maxCalls) return false;
      times.push(now);
      history.set(socketId, times);
      return true;
    },
    delete(socketId) { history.delete(socketId); }
  };
}

const chatLimiter          = makeSocketRateLimiter(3, 2000);  // 3 msgs / 2s
const reactionLimiter      = makeSocketRateLimiter(5, 2000);  // 5 reactions / 2s
const seekLimiter          = makeSocketRateLimiter(15, 2000); // 15 seeks / 2s (scrubbing)
const playPauseLimiter     = makeSocketRateLimiter(10, 2000); // 10 play/pause / 2s
const positionLimiter      = makeSocketRateLimiter(5, 1000);  // 5 position reports / 1s
const bufferingLimiter     = makeSocketRateLimiter(10, 2000); // 10 buffering events / 2s

function formatEpisodeTitle(showTitle, ep) {
  if (!ep) return showTitle || 'Unknown';
  const s = ep.parentIndex != null ? `S${String(ep.parentIndex).padStart(2, '0')}` : '';
  const e = ep.index != null ? `E${String(ep.index).padStart(2, '0')}` : '';
  const se = (s || e) ? `${s}${e} · ` : '';
  return `${showTitle ? showTitle + ' · ' : ''}${se}${ep.title || ''}`;
}

// ── Live TV retune (reactive only — called when HLS stream fails) ─────────
async function doRetune(room, io) {
  if (!room.liveTvChannelId) return;
  const liveTvManager = require('./livetv-manager');
  try {
    // DELETE the current subscription so Plex creates a genuinely fresh session.
    // Without this, retune returns the same ratingKey and the dying session continues.
    if (room.liveTvSubKey) {
      await liveTvManager.stopSubscription(room.liveTvSubKey).catch(() => {});
    }
    clearRoomManifest(room.id);
    const { ratingKey, subKey, sessionKey } = await liveTvManager.tuneChannel(room.liveTvChannelId);
    room.liveTvSubKey = subKey;
    if (sessionKey) registerLiveTvSessionKey(room.id, ratingKey, sessionKey);

    // Pre-warm: start the new Plex transcode session and cache its manifest
    // before telling clients to switch. Clients get an instant cache hit when
    // they request the new manifest, and Plex has had ~1.5s to buffer the first
    // segments — cutting black-screen time from ~7s to ~2s.
    await prewarmManifest(room.id, ratingKey, true, room.liveTvChannelId, subKey).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const keyChanged = ratingKey !== room.movieKey;
    room.movieKey    = ratingKey;
    room.playing     = true;
    room.position    = 0;
    room.lastUpdate  = Date.now();
    // If ratingKey is unchanged the clients won't detect the new session from state
    // alone — force them to reload the HLS manifest explicitly.
    if (!keyChanged) room.broadcast(io, 'livetv-reload');
    room.broadcastState(io);
    console.log(`[Room] "${room.name}" → Retuned ${room.liveTvChannel} → ratingKey=${ratingKey} (sub ${subKey})`);
  } catch (err) {
    console.error(`[Room] Retune failed for ${room.liveTvChannel}:`, err.message);
  }
}

function setupSync(io, enabledRoomTypes) {
  _io = io;
  if (enabledRoomTypes) _enabledRoomTypes = enabledRoomTypes;

  // Periodic sync heartbeat — keeps clients corrected during normal playback
  // without waiting for a play/pause/seek event to trigger a state broadcast.
  setInterval(() => {
    rooms.forEach(room => {
      if (room.playing && room.viewers.size > 1 && room.roomType !== 'livetv') {
        room.broadcastState(io);
        room.broadcastViewers(io);
      }
    });
  }, 5000);

  // Faster heartbeat for live TV rooms — tighter sync tolerance needs more frequent updates.
  // Plex session keepalives are handled by stream.js; this just calibrates position + broadcasts.
  setInterval(() => {
    rooms.forEach(room => {
      if (room.roomType !== 'livetv') return;
      // Calibrate room position from host's reported playback time.
      // This makes currentPosition() return a smooth, deterministic value
      // that advances at real-time speed — same as movie/TV sync.
      const hostViewer = room.viewers.get(room.hostSocketId);
      if (hostViewer?.reportedTime != null && hostViewer.reportedAt != null) {
        room.position   = hostViewer.reportedTime;
        room.lastUpdate = hostViewer.reportedAt;
      }
      if (room.playing && room.viewers.size > 1) {
        room.broadcastState(io);
        room.broadcastViewers(io);
      }
    });
  }, 2000);

  io.on('connection', (socket) => {
    const user = socket.user;

    socket.emit('room-list', Array.from(rooms.values()).map(r => r.summary()));

    // ── Create room (Plex users only) ──────────────────────
    socket.on('create-room', async ({ name, roomType, youtubeUrl } = {}) => {
      if (user.isGuest) return socket.emit('error-msg', 'Guests cannot create rooms');
      name = sanitizeText((name || '').trim().slice(0, 60)) || undefined;

      const VALID_TYPES = Object.keys(_enabledRoomTypes).filter(t => _enabledRoomTypes[t]);
      const type = VALID_TYPES.includes(roomType) ? roomType : (VALID_TYPES[0] || 'movie');
      let youtubeVideoId = null;
      if (type === 'youtube') {
        youtubeVideoId = extractYoutubeId(youtubeUrl || '');
        if (!youtubeVideoId) return socket.emit('error-msg', 'Invalid YouTube URL');
      }

      const room = new Room({ hostId: user.id, hostName: user.displayName || user.name, hostPicture: user.picture, name });
      room.roomType = type;
      room.youtubeVideoId = youtubeVideoId;
      if (youtubeVideoId) room.movieTitle = await fetchYoutubeTitle(youtubeVideoId);
      room.hostSocketId = socket.id;
      room.viewers.set(socket.id, {
        socketId: socket.id, id: user.id, name: user.displayName || user.name, picture: user.picture || null, isGuest: false, isHost: true
      });

      rooms.set(room.id, room);
      inviteTokens.set(room.inviteToken, room.id);
      socketToRoom.set(socket.id, room);

      socket.emit('room-created', { roomId: room.id, inviteToken: room.inviteToken });
      broadcastRoomList(io);
      console.log(`[Room] ${user.name} created "${room.name}" (${room.id})`);
    });

    // ── Join room from watch page ──────────────────────────
    // Allowed if: host, OR guest who arrived via a valid invite token (stored in session)
    socket.on('join-room', ({ roomId }) => {
      const room = rooms.get(roomId);
      if (!room) return socket.emit('room-error', 'Room not found');

      // Scheduled room: first *Plex* user to join becomes the host.
      // Guests are not allowed to claim host on a scheduled room — they must
      // wait until a Plex user has joined and opened the room.
      if (room.awaitingHost) {
        if (user.isGuest) {
          return socket.emit('room-error', 'Waiting for the host to arrive. Please try again shortly.');
        }
        room.awaitingHost  = false;
        room.hostId        = user.id;
        room.hostName      = user.displayName || user.name;
        room.hostPicture   = user.picture || null;
        room.hostIsGuest   = false;
        room.hostSocketId  = socket.id;
        console.log(`[Room] "${room.name}" (scheduled) — first joiner "${user.name}" became host`);
      }

      const isHost         = socket.id === room.hostSocketId ||
                             (!room.hostIsGuest && !user.isGuest && user.id === room.hostId);
      const hasValidInvite = user.inviteToken === room.inviteToken;
      // Plex users can join any room (they're all authenticated against the same server).
      // Guests must arrive via an invite link, which stores the token in their session.
      const isPlexViewer   = !user.isGuest && !isHost;

      if (!isHost && !hasValidInvite && !isPlexViewer) {
        return socket.emit('room-error', 'Access denied — use the invite link to join');
      }

      if (isHost) {
        room.hostSocketId = socket.id;
        // Cancel any pending close timer from a previous disconnect
        if (room.closeTimer) {
          clearTimeout(room.closeTimer);
          room.closeTimer = null;
          console.log(`[Room] Host reconnected to "${room.name}" — close cancelled`);
        }
      }

      room.viewers.set(socket.id, {
        socketId: socket.id, id: user.id, name: user.displayName || user.name, picture: user.picture || null,
        isGuest: user.isGuest || false, isHost
      });
      socketToRoom.set(socket.id, room);

      socket.emit('room-state', { ...room.state(), isHost, inviteToken: isHost ? room.inviteToken : null });
      room.broadcastViewers(io);
      console.log(`[Room] ${user.name} joined "${room.name}"`);
    });

    // ── Select movie (host only) ───────────────────────────
    socket.on('select-movie', ({ movieKey, movieTitle, partId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      clearRoomManifest(room.id); // Evict cached manifest so next request starts fresh
      room.movieKey = movieKey; room.movieTitle = movieTitle; room.partId = partId;
      room.playing = false; room.position = 0; room.lastUpdate = Date.now();
      console.log(`[Room] "${room.name}" → "${movieTitle}"`);
      room.broadcastState(io);
      broadcastRoomList(io);
    });

    // ── Select TV episode (host only, TV rooms) ────────────
    socket.on('select-show', async ({ showKey, showTitle, seasonRatingKey, episodeRatingKey, episodeTitle, partId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'tv') return;
      try {
        const episodes = await plex.getShowChildren(String(seasonRatingKey));
        const episodeList = episodes.map(e => ({
          ratingKey: String(e.ratingKey),
          title: e.title,
          index: e.index,
          parentIndex: e.parentIndex
        }));
        const episodeIndex = episodeList.findIndex(e => e.ratingKey === String(episodeRatingKey));

        clearRoomManifest(room.id);
        room.tvShowKey      = String(showKey);
        room.tvShowTitle    = showTitle;
        room.tvEpisodeList  = episodeList;
        room.tvEpisodeIndex = episodeIndex >= 0 ? episodeIndex : 0;
        room.movieKey       = String(episodeRatingKey);
        room.movieTitle     = formatEpisodeTitle(showTitle, episodeList[room.tvEpisodeIndex] || { title: episodeTitle, parentIndex: null, index: null });
        room.partId         = String(partId);
        room.playing        = false;
        room.position       = 0;
        room.lastUpdate     = Date.now();
        console.log(`[Room] "${room.name}" → TV "${room.movieTitle}"`);
        room.broadcastState(io);
        broadcastRoomList(io);
      } catch (err) {
        console.error('[Room] select-show error:', err.message);
        socket.emit('error-msg', 'Failed to load episode list');
      }
    });

    // ── Episode ended — advance to next (host only, TV rooms) ──
    socket.on('episode-ended', async () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'tv' || !room.tvEpisodeList.length) return;

      const nextIndex = room.tvEpisodeIndex + 1;
      if (nextIndex >= room.tvEpisodeList.length) {
        console.log(`[Room] "${room.name}" — TV season complete, no more episodes`);
        return;
      }

      const nextEp = room.tvEpisodeList[nextIndex];
      try {
        const details = await plex.getMovieDetails(nextEp.ratingKey);
        const part = details.Media?.[0]?.Part?.[0];
        if (!part) {
          console.warn(`[Room] episode-ended: no part found for ${nextEp.ratingKey}`);
          return;
        }
        clearRoomManifest(room.id);
        room.tvEpisodeIndex = nextIndex;
        room.movieKey       = String(nextEp.ratingKey);
        room.partId         = String(part.id);
        room.movieTitle     = formatEpisodeTitle(room.tvShowTitle, nextEp);
        room.playing        = false;
        room.position       = 0;
        room.lastUpdate     = Date.now();
        console.log(`[Room] "${room.name}" → next episode "${room.movieTitle}"`);
        room.broadcastState(io);
        broadcastRoomList(io);
      } catch (err) {
        console.error('[Room] episode-ended error:', err.message);
      }
    });

    // ── Set YouTube video (host only, YouTube rooms) ───────
    socket.on('set-youtube', async ({ youtubeUrl }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.roomType !== 'youtube') return;
      const videoId = extractYoutubeId(youtubeUrl || '');
      if (!videoId) return;
      room.youtubeVideoId = videoId;
      room.movieTitle = await fetchYoutubeTitle(videoId);
      room.playing = false; room.position = 0; room.lastUpdate = Date.now();
      console.log(`[Room] \"${room.name}\" → YouTube ${videoId} \"${room.movieTitle || 'unknown'}\"`);
      room.broadcastState(io);
      broadcastRoomList(io);
    });

    // ── Select live TV channel (host only, livetv rooms) ──
    socket.on('select-livetv-channel', async ({ channel, channelTitle, channelId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      if (!channelId) return;

      // Validate channelId is not empty (Plex may return numeric or string IDs)
      if (!channelId || typeof String(channelId).trim() !== 'string' || !String(channelId).trim()) {
        return socket.emit('error-message', 'Invalid channelId');
      }

      // Prevent concurrent tune requests (rate limit on channel switching)
      if (room._tuningInProgress) {
        return socket.emit('error-message', 'Channel change in progress');
      }
      room._tuningInProgress = true;

      clearRoomManifest(room.id); // stop any existing Plex transcode session
      try {
        const liveTvManager = require('./livetv-manager');
        const { ratingKey, subKey, sessionKey } = await liveTvManager.tuneChannel(channelId);
        room.liveTvChannel      = String(channel || '').slice(0, 20);
        room.liveTvChannelTitle = sanitizeText((channelTitle || channel || '').slice(0, 60));
        room.liveTvChannelId    = channelId;
        room.liveTvSubKey       = subKey;
        if (sessionKey) registerLiveTvSessionKey(room.id, ratingKey, sessionKey);
        room.movieKey   = ratingKey;
        room.playing    = true;
        room.position   = 0;
        room.lastUpdate = Date.now();

        // Pre-warm the manifest so clients get instant playback
        await prewarmManifest(room.id, ratingKey, true, channelId, subKey).catch(() => {});

        room.broadcastState(io);
        console.log(`[Room] "${room.name}" → Live TV channel ${room.liveTvChannel} (ratingKey=${ratingKey}, sub ${subKey})`);
      } catch (err) {
        console.error(`[Room] Failed to tune channel ${channel}:`, err.message);
        socket.emit('error-message', `Failed to tune channel: ${err.message}`);
      } finally {
        room._tuningInProgress = false;
      }
    });

    // ── Re-tune live TV when session dies (host only) ──────
    // Triggered by the client when the HLS stream fails unrecoverably.
    // The DVR ratingKey has expired; we need to re-tune to get a fresh one.
    socket.on('retune-livetv', async () => {
      const room = socketToRoom.get(socket.id);
      if (!room || socket.id !== room.hostSocketId || room.roomType !== 'livetv') return;
      if (!room.liveTvChannelId) return;
      await doRetune(room, io);
    });

    // ── Playback (anyone in room, unless locked) ───────────
    socket.on('play', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!playPauseLimiter.allow(socket.id)) return;
      // LiveTV intentionally bypasses playback lock — the stream is shared across
      // all viewers and cannot be independently paused/resumed by guests. Only the
      // host can retune to a different channel, but playback state (play/pause)
      // must stay in sync for everyone watching the same stream.
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId && room.roomType !== 'livetv') return;
      room.position = position ?? room.currentPosition();
      room.playing = true; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: '▶ resumed',
        isSystem: true,
        videoTime: Math.floor(room.position)
      });
    });

    socket.on('pause', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!playPauseLimiter.allow(socket.id)) return;
      // LiveTV intentionally bypasses playback lock — see play handler for explanation.
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId && room.roomType !== 'livetv') return;
      room.position = position ?? room.currentPosition();
      room.playing = false; room.lastUpdate = Date.now();
      room.broadcastState(io);
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: '⏸ paused',
        isSystem: true,
        videoTime: Math.floor(room.position)
      });
    });

    socket.on('seek', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (room.settings.playbackLocked && socket.id !== room.hostSocketId) return;
      if (!seekLimiter.allow(socket.id)) return;
      room.position = position; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    // ── Chat ───────────────────────────────────────────────
    socket.on('chat', (data) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!chatLimiter.allow(socket.id)) return;
      const trimmed = sanitizeText(((data && data.text) || '').trim().slice(0, 300));
      if (!trimmed) return;
      const videoTime = (typeof data.videoTime === 'number' && isFinite(data.videoTime)
        && data.videoTime >= 0 && data.videoTime < 86400)
        ? Math.floor(data.videoTime)
        : null;
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: trimmed,
        isGuest: user.isGuest || false,
        videoTime
      });
    });

    // ── Reactions ──────────────────────────────────────────
    socket.on('reaction', ({ emoji }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!room.settings.reactionsEnabled) return;
      if (!reactionLimiter.allow(socket.id)) return;
      const allowed = ['👍','❤️','😂','😱','😮','👏'];
      if (!allowed.includes(emoji)) return;
      room.broadcast(io, 'reaction', { emoji, name: user.displayName || user.name });
    });

    // ── Room settings (host only) ──────────────────────────
    socket.on('update-settings', (s) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (typeof s.playbackLocked  === 'boolean') room.settings.playbackLocked  = s.playbackLocked;
      if (typeof s.reactionsEnabled === 'boolean') room.settings.reactionsEnabled = s.reactionsEnabled;
      room.broadcast(io, 'room-settings', room.settings);
    });

    // ── Kick viewer (host only) ────────────────────────────
    socket.on('kick-viewer', ({ targetSocketId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.viewers.has(targetSocketId)) return;
      if (targetSocketId === socket.id) return;
      const kicked = room.viewers.get(targetSocketId);
      io.to(targetSocketId).emit('kicked');
      room.viewers.delete(targetSocketId);
      socketToRoom.delete(targetSocketId);
      room.broadcastViewers(io);
      console.log(`[Room] ${user.name} kicked "${kicked?.name}" from "${room.name}"`);
    });

    // ── Countdown (host only) ──────────────────────────────
    socket.on('start-countdown', ({ seconds } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }

      const SECONDS = (Number.isInteger(seconds) && seconds >= 1 && seconds <= 99) ? seconds : 10;
      const endsAt  = Date.now() + SECONDS * 1000;
      room.broadcast(io, 'countdown', { endsAt });

      room.countdownTimer = setTimeout(() => {
        room.countdownTimer = null;
        room.position  = room.currentPosition();
        room.playing   = true;
        room.lastUpdate = Date.now();
        room.broadcastState(io);
      }, SECONDS * 1000);
    });

    socket.on('cancel-countdown', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (room.countdownTimer) { clearTimeout(room.countdownTimer); room.countdownTimer = null; }
      room.broadcast(io, 'countdown-cancelled');
    });

    // ── Intermission (host only) ───────────────────────────
    socket.on('start-intermission', ({ minutes } = {}) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;

      const MINS     = (Number.isInteger(minutes) && minutes >= 1 && minutes <= 120) ? minutes : 10;
      const DURATION = MINS * 60 * 1000;
      const endsAt   = Date.now() + DURATION;

      // Clear any existing intermission
      if (room.intermissionTimer) { clearTimeout(room.intermissionTimer); room.intermissionTimer = null; }

      // Pause playback
      room.position   = room.currentPosition();
      room.playing    = false;
      room.lastUpdate = Date.now();
      room.intermissionEndsAt = endsAt;

      room.broadcastState(io);
      room.broadcast(io, 'intermission-started', { endsAt });

      room.intermissionTimer = setTimeout(() => {
        room.intermissionTimer  = null;
        room.intermissionEndsAt = null;
        room.playing    = true;
        room.lastUpdate = Date.now();
        room.broadcastState(io);
        room.broadcast(io, 'intermission-ended');
        console.log(`[Room] Intermission ended in "${room.name}" — resuming`);
      }, DURATION);

      console.log(`[Room] Intermission started in "${room.name}" for ${MINS} min`);
    });

    socket.on('cancel-intermission', () => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.intermissionTimer) return;
      clearTimeout(room.intermissionTimer);
      room.intermissionTimer  = null;
      room.intermissionEndsAt = null;
      room.broadcast(io, 'intermission-cancelled');
      console.log(`[Room] Intermission cancelled in "${room.name}"`);
    });

    // ── Transfer host ──────────────────────────────────────
    socket.on('transfer-host', ({ targetSocketId }) => {
      const room = socketToRoom.get(socket.id);
      if (!room || room.hostSocketId !== socket.id) return;
      if (!room.viewers.has(targetSocketId)) return;

      const oldHostViewer = room.viewers.get(socket.id);
      const newHostViewer = room.viewers.get(targetSocketId);

      if (oldHostViewer) oldHostViewer.isHost = false;
      newHostViewer.isHost = true;

      room.hostId       = newHostViewer.isGuest ? null : newHostViewer.id;
      room.hostName     = newHostViewer.name;
      room.hostPicture  = newHostViewer.picture;
      room.hostIsGuest  = newHostViewer.isGuest;
      room.hostSocketId = targetSocketId;

      if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }

      io.to(socket.id).emit('lost-host');
      io.to(targetSocketId).emit('became-host', { inviteToken: room.inviteToken });

      room.broadcastViewers(io);
      broadcastRoomList(io);
      console.log(`[Room] Host transferred from "${user.name}" to "${newHostViewer.name}" in "${room.name}"`);
    });

    // ── Position report (for drift display) ───────────────
    socket.on('position-report', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!positionLimiter.allow(socket.id)) return;
      const viewer = room.viewers.get(socket.id);
      if (!viewer) return;
      if (typeof position !== 'number' || !isFinite(position) || position < 0) return;
      viewer.reportedTime = position;
      viewer.reportedAt   = Date.now();
    });

    // ── Buffering state ────────────────────────────────────
    socket.on('buffering-state', ({ buffering }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      if (!bufferingLimiter.allow(socket.id)) return;
      const viewer = room.viewers.get(socket.id);
      if (!viewer) return;
      viewer.buffering = !!buffering;
      room.broadcastViewers(io);
    });

    // ── Disconnect ─────────────────────────────────────────
    socket.on('disconnect', () => {
      chatLimiter.delete(socket.id);
      reactionLimiter.delete(socket.id);
      seekLimiter.delete(socket.id);
      const room = socketToRoom.get(socket.id);
      socketToRoom.delete(socket.id);
      if (!room) return;

      room.viewers.delete(socket.id);

      if (room.hostSocketId === socket.id) {
        if (room.countdownTimer) {
          clearTimeout(room.countdownTimer); room.countdownTimer = null;
          room.broadcast(io, 'countdown-cancelled');
        }
        if (room.intermissionTimer) {
          clearTimeout(room.intermissionTimer); room.intermissionTimer = null;
          room.intermissionEndsAt = null;
        }

        // If viewers remain, auto-migrate host rather than closing the room.
        if (room.viewers.size > 0) {
          // Prefer a non-guest viewer; otherwise take any remaining viewer.
          let candidate = null;
          for (const [sid, v] of room.viewers) {
            if (!v.isGuest) { candidate = [sid, v]; break; }
            if (!candidate) candidate = [sid, v];
          }
          if (candidate) {
            const [newSid, newViewer] = candidate;
            newViewer.isHost      = true;
            room.hostId           = newViewer.isGuest ? null : newViewer.id;
            room.hostName         = newViewer.name;
            room.hostPicture      = newViewer.picture;
            room.hostIsGuest      = newViewer.isGuest;
            room.hostSocketId     = newSid;
            if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; }
            io.to(newSid).emit('became-host', { inviteToken: room.inviteToken });
            room.broadcastViewers(io);
            broadcastRoomList(io);
            console.log(`[Room] "${room.name}" — host "${user.name}" left, auto-migrated to "${newViewer.name}"`);
            return;
          }
        }

        if (room.hostIsGuest) {
          // Guest hosts cannot reconnect — close the room immediately
          console.log(`[Room] Guest host "${user.name}" disconnected from "${room.name}" — closing`);
          room.broadcast(io, 'room-closed', { reason: 'Host left the room' });
          inviteTokens.delete(room.inviteToken);
          rooms.delete(room.id);
          broadcastRoomList(io);
        } else {
          // Give the Plex host a grace window to reconnect (e.g. lobby → watch navigation).
          // If they rejoin before the timer fires it will be cancelled.
          console.log(`[Room] Host "${user.name}" disconnected from "${room.name}" — waiting to see if they reconnect…`);
          room.closeTimer = setTimeout(() => {
            if (!rooms.has(room.id)) return; // already cleaned up
            console.log(`[Room] "${room.name}" closed — host did not reconnect`);
            room.broadcast(io, 'room-closed', { reason: 'Host left the room' });
            inviteTokens.delete(room.inviteToken);
            rooms.delete(room.id);
            broadcastRoomList(io);
            }, 30000);
        }
      } else {
        room.broadcastViewers(io);
        console.log(`[Room] ${user.name} left "${room.name}"`);
        broadcastRoomList(io);
      }
    });
  });
}

/**
 * Create a room from a scheduled room record.
 * Called by the scheduler when the scheduled time arrives.
 * The room is registered in the rooms/inviteTokens maps and the pre-shared
 * inviteToken is preserved so outstanding invite links continue to work.
 */
function createScheduledRoom(scheduled) {
  const room = new Room({
    hostId:      null,
    hostName:    scheduled.createdBy.name,
    hostPicture: null,
    name:        scheduled.name
  });

  // Preserve the pre-shared invite token
  room.inviteToken  = scheduled.inviteToken;
  room.awaitingHost = true;

  // Pre-load the movie if one was chosen at scheduling time
  if (scheduled.movieKey) {
    room.movieKey   = scheduled.movieKey;
    room.movieTitle = scheduled.movieTitle;
    room.partId     = scheduled.partId;
  }

  rooms.set(room.id, room);
  inviteTokens.set(room.inviteToken, room.id);

  if (_io) broadcastRoomList(_io);
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

module.exports = { setupSync, getRoomByInviteToken, createScheduledRoom, getRoom };
