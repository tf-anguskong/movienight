const { v4: uuidv4 } = require('uuid');
const { clearRoomManifest } = require('./routes/stream');

const rooms        = new Map(); // roomId -> Room
const inviteTokens = new Map(); // inviteToken -> roomId
const socketToRoom = new Map(); // socketId -> Room

class Room {
  constructor({ hostId, hostName, hostPicture, name }) {
    this.id           = uuidv4();
    this.inviteToken  = uuidv4();
    this.name         = (name || `${hostName}'s Room`).slice(0, 60);
    this.hostId       = hostId;
    this.hostName     = hostName;
    this.hostPicture  = hostPicture || null;
    this.hostIsGuest  = false;
    this.hostSocketId = null;
    this.movieKey     = null;
    this.movieTitle   = null;
    this.partId       = null;
    this.playing      = false;
    this.position     = 0;
    this.lastUpdate   = Date.now();
    this.viewers      = new Map(); // socketId -> viewer info
  }

  currentPosition() {
    if (!this.playing) return this.position;
    return this.position + (Date.now() - this.lastUpdate) / 1000;
  }

  state() {
    return {
      id: this.id, name: this.name,
      hostId: this.hostId, hostName: this.hostName,
      movieKey: this.movieKey, movieTitle: this.movieTitle, partId: this.partId,
      playing: this.playing,
      position: this.currentPosition(),
      lastUpdate: Date.now()
    };
  }

  summary() {
    return {
      id: this.id, name: this.name, hostName: this.hostName,
      movieTitle: this.movieTitle,
      viewerCount: this.viewers.size,
      hasMovie: !!this.movieKey
    };
  }

  broadcast(io, event, data) {
    this.viewers.forEach((_, sid) => io.to(sid).emit(event, data));
  }

  broadcastViewers(io) {
    this.broadcast(io, 'viewers', Array.from(this.viewers.values()));
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

function setupSync(io) {
  // Periodic sync heartbeat — keeps clients corrected during normal playback
  // without waiting for a play/pause/seek event to trigger a state broadcast.
  setInterval(() => {
    rooms.forEach(room => {
      if (room.playing && room.viewers.size > 1) room.broadcastState(io);
    });
  }, 5000);

  io.on('connection', (socket) => {
    const user = socket.user;

    socket.emit('room-list', Array.from(rooms.values()).map(r => r.summary()));

    // ── Create room (Plex users only) ──────────────────────
    socket.on('create-room', ({ name } = {}) => {
      if (user.isGuest) return socket.emit('error-msg', 'Guests cannot create rooms');

      const room = new Room({ hostId: user.id, hostName: user.displayName || user.name, hostPicture: user.picture, name });
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

      const isHost          = !room.hostIsGuest && !user.isGuest && user.id === room.hostId;
      const hasValidInvite  = user.isGuest && user.inviteToken === room.inviteToken;
      const isPlexViewer    = !user.isGuest && !isHost;
      // Plex users can join any room (they browse via lobby anyway)

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

    // ── Playback (anyone in room) ──────────────────────────
    socket.on('play', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      room.position = position ?? room.currentPosition();
      room.playing = true; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    socket.on('pause', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      room.position = position ?? room.currentPosition();
      room.playing = false; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    socket.on('seek', ({ position }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      room.position = position; room.lastUpdate = Date.now();
      room.broadcastState(io);
    });

    // ── Chat ───────────────────────────────────────────────
    socket.on('chat', ({ text }) => {
      const room = socketToRoom.get(socket.id);
      if (!room) return;
      const trimmed = (text || '').trim().slice(0, 300);
      if (!trimmed) return;
      room.broadcast(io, 'chat', {
        name: user.displayName || user.name,
        text: trimmed,
        isGuest: user.isGuest || false
      });
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

    // ── Disconnect ─────────────────────────────────────────
    socket.on('disconnect', () => {
      const room = socketToRoom.get(socket.id);
      socketToRoom.delete(socket.id);
      if (!room) return;

      room.viewers.delete(socket.id);

      if (room.hostSocketId === socket.id) {
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

module.exports = { setupSync, getRoomByInviteToken };
