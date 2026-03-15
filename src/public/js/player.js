'use strict';

const socket   = io();
const roomId   = location.pathname.split('/').pop();

const video       = document.getElementById('video-player');
const noMovie     = document.getElementById('no-movie');
const noMovieText = document.getElementById('no-movie-text');
const titleEl     = document.getElementById('movie-title');
const roomNameEl  = document.getElementById('room-name');
const viewersList = document.getElementById('viewers-list');
const syncDot     = document.getElementById('sync-dot');
const syncText    = document.getElementById('sync-text');

let isSyncing        = false;
let syncTimer        = null;
let currentKey       = null;
let hlsInstance      = null;
let isHost           = false;
let roomType         = 'movie';
let roomSettings     = { playbackLocked: false, reactionsEnabled: true };
let sidebarCollapsed = false;
let unreadChats      = 0;
let lastKnownState   = null;

// ── YouTube state ──────────────────────────────────────────
let ytApiLoaded   = false;
let ytApiReady    = false;
let ytPlayer      = null;
let ytVideoId     = null;
let pendingYtInit = null;

const autoplayOnLoad = new URLSearchParams(location.search).has('autoplay');

function esc(s = '') {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// ── Join room ──────────────────────────────────────────────
socket.on('connect', () => socket.emit('join-room', { roomId }));

function setHostUI(on, inviteToken) {
  const isYt = roomType === 'youtube';
  document.getElementById('choose-movie-btn').style.display      = (on && !isYt) ? 'block' : 'none';
  document.getElementById('yt-controls-section').style.display   = (on && isYt)  ? 'block' : 'none';
  document.getElementById('countdown-btn').style.display         = on ? 'block' : 'none';
  document.getElementById('room-controls-section').style.display = on ? 'block' : 'none';
  if (on && inviteToken) setupInviteLink(inviteToken);
  if (!on) document.getElementById('invite-section').style.display = 'none';
}

function applyRoomSettings(settings) {
  roomSettings = { ...roomSettings, ...settings };
  if (roomType === 'movie') video.controls = !roomSettings.playbackLocked || isHost;
  document.getElementById('reaction-bar').style.display = roomSettings.reactionsEnabled ? '' : 'none';
  if (isHost) {
    const lockEl = document.getElementById('toggle-lock-playback');
    const reactEl = document.getElementById('toggle-reactions');
    if (lockEl) lockEl.checked = !!roomSettings.playbackLocked;
    if (reactEl) reactEl.checked = !!roomSettings.reactionsEnabled;
  }
}

socket.on('room-state', (state) => {
  isHost = state.isHost;
  roomType = state.roomType || 'movie';
  roomNameEl.textContent = state.name || '';
  setHostUI(isHost, state.inviteToken);
  if (state.settings) applyRoomSettings(state.settings);
  applyState(state);
});

socket.on('room-settings', applyRoomSettings);

socket.on('kicked', () => {
  alert('You have been removed from this room by the host.');
  window.location.href = '/';
});

socket.on('state', applyState);

socket.on('room-error', (msg) => {
  alert(msg + '\n\nRedirecting to lobby.');
  window.location.href = '/';
});

socket.on('room-closed', ({ reason }) => {
  alert(reason || 'Room closed.');
  window.location.href = '/';
});

// ── Invite link (host only) ────────────────────────────────
function setupInviteLink(inviteToken) {
  const inviteSection = document.getElementById('invite-section');
  const inviteInput   = document.getElementById('invite-link');
  if (!inviteSection || !inviteInput) return;

  const url = `${location.origin}/join/${inviteToken}`;
  inviteInput.value = url;
  inviteSection.style.display = 'block';

  document.getElementById('copy-invite-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.getElementById('copy-invite-btn');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    });
  });
}

// ── Sync indicator ─────────────────────────────────────────
function setSyncing(v) {
  syncDot.className = `sync-dot ${v ? 'syncing' : 'synced'}`;
  syncText.textContent = v ? 'Syncing…' : 'Synced';
}
function releaseSyncLock() {
  syncTimer = setTimeout(() => { isSyncing = false; setSyncing(false); }, 400);
}

// ── Apply server state ─────────────────────────────────────
function applyState(state) {
  lastKnownState = state;
  if (state.roomType === 'youtube') {
    video.style.display = 'none';
    applyYtState(state);
    return;
  }
  // Hide YouTube player if switching room types
  document.getElementById('yt-player-container').style.display = 'none';

  if (!state.movieKey) {
    video.style.display = 'none';
    noMovie.style.display = 'block';
    titleEl.textContent = 'No movie selected';
    return;
  }

  noMovie.style.display = 'none';
  video.style.display = 'block';
  titleEl.textContent = state.movieTitle || 'Now Playing';

  const elapsed    = (Date.now() - state.lastUpdate) / 1000;
  const targetTime = state.playing ? state.position + elapsed : state.position;

  // New movie — full reload
  if (state.movieKey !== currentKey) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    currentKey = state.movieKey;
    loadHls(state.movieKey, targetTime, state.playing);
    return;
  }

  // Sync play/pause state
  if (state.playing && video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.play().catch(err => { console.warn('[Player] Autoplay blocked:', err.message); showPlayOverlay(); });
    releaseSyncLock();
  } else if (!state.playing && !video.paused) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.currentTime = targetTime;
    video.pause();
    releaseSyncLock();
    return;
  }

  if (!state.playing) return;

  // Drift correction during playback
  const drift    = video.currentTime - targetTime;
  const absDrift = Math.abs(drift);

  if (absDrift > 5) {
    // Large drift — hard seek
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    video.currentTime = targetTime;
    releaseSyncLock();
  } else if (absDrift > 0.5) {
    // Small drift — nudge playback rate to catch up gradually (±5%)
    video.playbackRate = drift > 0 ? 0.95 : 1.05;
  } else {
    // In sync — restore normal speed
    if (video.playbackRate !== 1.0) video.playbackRate = 1.0;
  }
}

// ── HLS loader ─────────────────────────────────────────────
function showPlayOverlay() {
  const overlay = document.getElementById('play-overlay');
  if (overlay) overlay.style.display = 'flex';
}

function hidePlayOverlay() {
  const overlay = document.getElementById('play-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Make the entire overlay clickable — the native video spinner can intercept
// clicks on the button specifically, so we catch clicks on the whole overlay.
// Re-sync to current authoritative position so guests who clicked late don't
// start from where the manifest was loaded rather than where the movie is now.
document.getElementById('play-overlay')?.addEventListener('click', () => {
  hidePlayOverlay();
  if (lastKnownState && lastKnownState.playing) {
    const elapsed   = (Date.now() - lastKnownState.lastUpdate) / 1000;
    const catchUpTo = lastKnownState.position + elapsed;
    isSyncing = true;
    video.currentTime = catchUpTo;
  }
  video.play().catch(console.warn);
  releaseSyncLock();
});

function tryPlay() {
  return video.play().then(() => {
    hidePlayOverlay();
  }).catch(err => {
    console.warn('[Player] Autoplay blocked — showing overlay:', err.message);
    showPlayOverlay();
  });
}

function loadHls(ratingKey, targetTime, shouldPlay) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  hidePlayOverlay();
  const src = `/api/stream/hls/${roomId}/${ratingKey}/master.m3u8`;

  // Show the overlay proactively unless this is a fresh join navigation,
  // where the browser may allow autoplay and we want seamless playback.
  if (shouldPlay && !autoplayOnLoad) showPlayOverlay();

  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    // startPosition: -1 lets HLS.js read the stream layout before seeking.
    // Jumping straight to targetTime on a shared mid-session Plex stream causes
    // buffer append errors due to codec init / segment boundary mismatches.
    // We seek to targetTime ourselves once the manifest is parsed.
    hlsInstance = new Hls({ startPosition: -1, enableWorker: true });
    hlsInstance.loadSource(src);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
      video.currentTime = targetTime;
      if (shouldPlay) {
        video.play().then(() => {
          hidePlayOverlay();
          releaseSyncLock();
        }).catch(() => {
          if (!autoplayOnLoad) showPlayOverlay(); // guests use native controls as fallback
        });
      } else {
        releaseSyncLock();
      }
    });
    let networkRetried = false;
    hlsInstance.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn('[HLS] Media error, attempting recovery:', d.details);
        hlsInstance.recoverMediaError();
      } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR && !networkRetried) {
        // Network error — Plex session likely expired. Bust the server-side
        // manifest cache and restart from the current playback position so
        // Plex transcodes from roughly the right spot.
        networkRetried = true;
        console.warn('[HLS] Network error, busting manifest and restarting:', d.details);
        setTimeout(() => {
          if (hlsInstance) {
            const offsetMs = Math.floor((video.currentTime || 0) * 1000);
            hlsInstance.loadSource(`${src}?bust=1&offset=${offsetMs}`);
            hlsInstance.startLoad();
          }
        }, 2000);
      } else {
        console.error('[HLS] Fatal:', d.type, d.details);
        hidePlayOverlay();
        noMovieText.textContent = `Stream error: ${d.details} — try refreshing.`;
        noMovie.style.display = 'block';
        video.style.display = 'none';
      }
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = targetTime;
      if (shouldPlay) {
        video.play().then(() => {
          hidePlayOverlay();
          releaseSyncLock();
        }).catch(() => {
          if (!autoplayOnLoad) showPlayOverlay();
        });
      } else {
        releaseSyncLock();
      }
    }, { once: true });
  }
}

// ── Sidebar collapse ───────────────────────────────────────
const sidebar   = document.querySelector('.sidebar');
const expandTab = document.getElementById('sidebar-expand-tab');
const chatBadge = document.getElementById('chat-badge');

function collapseSidebar() {
  sidebarCollapsed = true;
  sidebar.classList.add('collapsed');
  expandTab.style.display = 'flex';
}

function expandSidebar() {
  sidebarCollapsed = false;
  sidebar.classList.remove('collapsed');
  expandTab.style.display = 'none';
  unreadChats = 0;
  chatBadge.style.display = 'none';
  chatBadge.textContent = '';
}

document.getElementById('sidebar-toggle').addEventListener('click', collapseSidebar);
document.getElementById('sidebar-expand-btn').addEventListener('click', expandSidebar);

// ── Toast notifications ────────────────────────────────────
function showNotif(text) {
  const area = document.getElementById('notif-area');
  const el   = document.createElement('div');
  el.className   = 'notif-toast';
  el.textContent = text;
  area.appendChild(el);
  setTimeout(() => {
    el.classList.add('notif-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 4000);
}

// ── Position reporting (for drift indicator) ───────────────
setInterval(() => {
  let pos = null;
  if (roomType === 'movie' && currentKey && !video.paused && !video.ended) {
    pos = video.currentTime;
  } else if (roomType === 'youtube' && ytPlayer && ytVideoId) {
    if (ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING) {
      pos = ytPlayer.getCurrentTime?.();
    }
  }
  if (pos != null && isFinite(pos)) socket.emit('position-report', { position: pos });
}, 2000);

// ── Buffering state reporting ──────────────────────────────
video.addEventListener('waiting', () => socket.emit('buffering-state', { buffering: true }));
video.addEventListener('playing', () => socket.emit('buffering-state', { buffering: false }));

// ── YouTube IFrame API ─────────────────────────────────────
function loadYouTubeApi() {
  if (ytApiLoaded) return;
  ytApiLoaded = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
}

window.onYouTubeIframeAPIReady = function() {
  ytApiReady = true;
  if (pendingYtInit) {
    const p = pendingYtInit; pendingYtInit = null;
    createYtPlayer(p.videoId, p.targetTime, p.shouldPlay);
  }
};

function initYtPlayer(videoId, targetTime, shouldPlay) {
  loadYouTubeApi();
  if (!ytApiReady) {
    pendingYtInit = { videoId, targetTime, shouldPlay };
    return;
  }
  createYtPlayer(videoId, targetTime, shouldPlay);
}

function ensureYtDiv() {
  const container = document.getElementById('yt-player-container');
  let div = document.getElementById('yt-player');
  if (!div) {
    div = document.createElement('div');
    div.id = 'yt-player';
    container.appendChild(div);
  }
  return div;
}

function createYtPlayer(videoId, targetTime, shouldPlay) {
  const container = document.getElementById('yt-player-container');
  container.style.display = 'block';
  noMovie.style.display = 'none';
  video.style.display = 'none';

  if (ytPlayer && ytVideoId === videoId) {
    // Same video — just sync position/state
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    if (shouldPlay) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
    releaseSyncLock();
    return;
  }

  if (ytPlayer) {
    ytPlayer.destroy();
    ytPlayer = null;
  }

  ytVideoId = videoId;
  ensureYtDiv();

  ytPlayer = new YT.Player('yt-player', {
    videoId,
    playerVars: { rel: 0, modestbranding: 1 },
    events: {
      onReady(e) {
        isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
        e.target.seekTo(targetTime, true);
        if (shouldPlay) e.target.playVideo();
        else e.target.pauseVideo();
        releaseSyncLock();
      },
      onStateChange: onYtStateChange
    }
  });
}

function onYtStateChange(event) {
  if (isSyncing) return;
  const s = event.data;
  if (s === YT.PlayerState.PLAYING) {
    if (roomSettings.playbackLocked && !isHost) {
      isSyncing = true; ytPlayer.pauseVideo(); releaseSyncLock(); return;
    }
    socket.emit('play', { position: ytPlayer.getCurrentTime() });
  } else if (s === YT.PlayerState.PAUSED) {
    if (roomSettings.playbackLocked && !isHost) return;
    socket.emit('pause', { position: ytPlayer.getCurrentTime() });
  }
}

function applyYtState(state) {
  titleEl.textContent = state.movieTitle || (state.youtubeVideoId ? 'YouTube' : 'No video selected');

  if (!state.youtubeVideoId) {
    document.getElementById('yt-player-container').style.display = 'none';
    noMovieText.textContent = 'Waiting for host to set a YouTube video…';
    noMovie.style.display = 'block';
    return;
  }

  noMovie.style.display = 'none';
  const elapsed    = (Date.now() - state.lastUpdate) / 1000;
  const targetTime = state.playing ? state.position + elapsed : state.position;

  if (state.youtubeVideoId !== ytVideoId || !ytPlayer) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    initYtPlayer(state.youtubeVideoId, targetTime, state.playing);
    return;
  }

  const ytState   = ytPlayer.getPlayerState?.();
  const ytPlaying = ytState === YT.PlayerState.PLAYING;

  if (state.playing && !ytPlaying) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    ytPlayer.playVideo();
    releaseSyncLock();
  } else if (!state.playing && ytPlaying) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    ytPlayer.pauseVideo();
    releaseSyncLock();
  }

  if (!state.playing) return;

  const drift = (ytPlayer.getCurrentTime?.() || 0) - targetTime;
  if (Math.abs(drift) > 5) {
    isSyncing = true; setSyncing(true); clearTimeout(syncTimer);
    ytPlayer.seekTo(targetTime, true);
    releaseSyncLock();
  }
}

// ── YouTube host controls ──────────────────────────────────
document.getElementById('yt-url-btn')?.addEventListener('click', setYoutubeUrl);
document.getElementById('yt-url-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') setYoutubeUrl();
});

function setYoutubeUrl() {
  const url    = document.getElementById('yt-url-input')?.value.trim();
  const errEl  = document.getElementById('yt-url-error');
  if (!url) { errEl.textContent = 'URL required'; errEl.style.display = 'block'; return; }
  try {
    const u = new URL(url);
    if (u.hostname !== 'youtu.be' && u.hostname !== 'youtube.com' && u.hostname !== 'www.youtube.com') {
      errEl.textContent = 'Must be a YouTube URL'; errEl.style.display = 'block'; return;
    }
  } catch { errEl.textContent = 'Invalid URL'; errEl.style.display = 'block'; return; }
  errEl.style.display = 'none';
  socket.emit('set-youtube', { youtubeUrl: url });
  document.getElementById('yt-url-input').value = '';
}

// ── Viewers ────────────────────────────────────────────────
let lastViewers = [];

function renderViewers(viewers) {
  viewersList.innerHTML = viewers.map(v => {
    const driftHtml = v.drift != null
      ? (() => {
          const abs = Math.abs(v.drift);
          const cls = abs < 1 ? 'drift-ok' : abs < 3 ? 'drift-warn' : 'drift-bad';
          const sign = v.drift > 0 ? '+' : '';
          return `<span class="drift-badge ${cls}">${sign}${v.drift.toFixed(1)}s</span>`;
        })()
      : '';
    const bufHtml = v.buffering ? '<span class="buffering-dot" title="Buffering…"></span>' : '';
    return `
      <div class="viewer-item">
        ${v.picture
          ? `<img src="${v.picture}" alt="${esc(v.name)}">`
          : `<div class="viewer-avatar-placeholder">${esc(v.name[0]?.toUpperCase() || '?')}</div>`
        }
        <span class="viewer-name-wrap">${esc(v.name)}${v.isHost ? ' 👑' : ''}${v.isGuest ? ' <span class="guest-tag">guest</span>' : ''}</span>
        ${bufHtml}${driftHtml}
        ${isHost && !v.isHost ? `
          <button class="btn-make-host" data-sid="${esc(v.socketId)}">Host</button>
          <button class="btn-kick" data-sid="${esc(v.socketId)}">Kick</button>
        ` : ''}
      </div>
    `;
  }).join('');

  if (isHost) {
    viewersList.querySelectorAll('.btn-make-host').forEach(btn => {
      btn.addEventListener('click', () => socket.emit('transfer-host', { targetSocketId: btn.dataset.sid }));
    });
    viewersList.querySelectorAll('.btn-kick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('Kick this viewer from the room?')) {
          socket.emit('kick-viewer', { targetSocketId: btn.dataset.sid });
        }
      });
    });
  }
}

socket.on('viewers', (viewers) => {
  if (sidebarCollapsed && lastViewers.length > 0) {
    const prevIds = new Set(lastViewers.map(v => v.socketId));
    const currIds = new Set(viewers.map(v => v.socketId));
    viewers.forEach(v => { if (!prevIds.has(v.socketId)) showNotif(`👋 ${v.name} joined`); });
    lastViewers.forEach(v => { if (!currIds.has(v.socketId)) showNotif(`👋 ${v.name} left`); });
  }
  lastViewers = viewers;
  renderViewers(viewers);
});

socket.on('became-host', ({ inviteToken }) => {
  isHost = true;
  setHostUI(true, inviteToken);
  renderViewers(lastViewers);
});

socket.on('lost-host', () => {
  isHost = false;
  setHostUI(false);
  renderViewers(lastViewers);
});

// ── Playback → server ──────────────────────────────────────
video.addEventListener('play', () => {
  if (isSyncing) return;
  if (roomSettings.playbackLocked && !isHost) {
    // Immediately revert — don't let the video run while server-state says paused
    isSyncing = true; video.pause(); releaseSyncLock(); return;
  }
  socket.emit('play', { position: video.currentTime });
});
video.addEventListener('pause',  () => {
  if (isSyncing) return;
  if (roomSettings.playbackLocked && !isHost) return;
  socket.emit('pause', { position: video.currentTime });
});
video.addEventListener('seeked', () => {
  if (isSyncing) return;
  if (roomSettings.playbackLocked && !isHost) return;
  socket.emit('seek',  { position: video.currentTime });
});

// ── Movie browser modal (host only) ───────────────────────
document.getElementById('choose-movie-btn').addEventListener('click', () => {
  document.getElementById('movie-modal').style.display = 'flex';
  loadMovies();
});
document.getElementById('close-movie-modal').addEventListener('click', () => {
  document.getElementById('movie-modal').style.display = 'none';
});

async function loadMovies() {
  const grid = document.getElementById('movies-grid');
  grid.innerHTML = '<div class="loading" style="grid-column:1/-1">Loading…</div>';

  const params = new URLSearchParams({
    search: document.getElementById('search-input').value.trim(),
    genre:  document.getElementById('genre-select').value,
    sort:   document.getElementById('sort-select').value
  });

  try {
    const { movies, genres, error } = await fetch(`/api/movies?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    const sel = document.getElementById('genre-select');
    const cur = sel.value;
    if (genres?.length) {
      sel.innerHTML = '<option value="">All genres</option>' +
        genres.map(g => `<option value="${esc(g)}"${g === cur ? ' selected' : ''}>${esc(g)}</option>`).join('');
    }

    document.getElementById('movie-count').textContent =
      movies.length ? `${movies.length} movie${movies.length !== 1 ? 's' : ''}` : '';

    if (!movies.length) {
      grid.innerHTML = '<div class="loading" style="grid-column:1/-1">No movies found.</div>';
      return;
    }

    grid.innerHTML = movies.map(m => `
      <div class="movie-card" data-key="${m.ratingKey}">
        ${m.thumb
          ? `<img class="movie-poster" src="${m.thumb}" alt="${esc(m.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">🎬</div>`
        }
        <div class="movie-info">
          <h3 title="${esc(m.title)}">${esc(m.title)}</h3>
          <span>${m.year || ''}${m.year && m.rating ? ' · ' : ''}${m.rating ? '★ ' + Number(m.rating).toFixed(1) : ''}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => selectMovie(card.dataset.key));
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading" style="grid-column:1/-1">Error: ${esc(err.message)}</div>`;
  }
}

async function selectMovie(ratingKey) {
  try {
    const movie = await fetch(`/api/movies/${ratingKey}`).then(r => r.json());
    if (!movie.partId) { alert('No stream found for this movie.'); return; }
    socket.emit('select-movie', { movieKey: movie.ratingKey, movieTitle: movie.title, partId: movie.partId });
    document.getElementById('movie-modal').style.display = 'none';
  } catch { alert('Failed to load movie details.'); }
}

let searchTimeout;
document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadMovies, 300);
});
document.getElementById('genre-select').addEventListener('change', loadMovies);
document.getElementById('sort-select').addEventListener('change', loadMovies);

socket.on('disconnect', () => { syncDot.className = 'sync-dot offline'; syncText.textContent = 'Disconnected'; });

// ── Chat ───────────────────────────────────────────────────
const chatMessages = document.getElementById('chat-messages');
const chatInput    = document.getElementById('chat-input');

function formatVideoTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

socket.on('chat', ({ name, text, isGuest, videoTime, isSystem }) => {
  const div = document.createElement('div');
  const ts  = videoTime != null ? `<span class="chat-ts">[${esc(formatVideoTime(videoTime))}]</span> ` : '';
  if (isSystem) {
    div.className = 'chat-msg chat-system';
    div.innerHTML = `${esc(name)} <span class="chat-system-action">${esc(text)}</span> ${ts}`;
  } else {
    div.className = 'chat-msg';
    div.innerHTML = `<span class="chat-name">${esc(name)}${isGuest ? ' <span class="guest-tag">guest</span>' : ''}</span> ${ts}${esc(text)}`;
  }
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (sidebarCollapsed && !isSystem) {
    unreadChats++;
    chatBadge.textContent = unreadChats > 99 ? '99+' : String(unreadChats);
    chatBadge.style.display = 'flex';
    const preview = text.length > 55 ? text.slice(0, 55) + '…' : text;
    showNotif(`💬 ${name}: ${preview}`);
  }
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  let videoTime = null;
  if (roomType === 'youtube' && ytPlayer && ytVideoId) {
    const t = ytPlayer.getCurrentTime?.();
    if (typeof t === 'number' && isFinite(t)) videoTime = Math.floor(t);
  } else if (roomType === 'movie' && currentKey) {
    videoTime = video.currentTime;
  }
  socket.emit('chat', { text, videoTime });
  chatInput.value = '';
}

document.getElementById('chat-send').addEventListener('click', sendChat);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

// ── Reactions ──────────────────────────────────────────────
const playerContainer = document.querySelector('.player-container');

document.getElementById('reaction-bar').addEventListener('click', e => {
  const btn = e.target.closest('.reaction-btn');
  if (btn) socket.emit('reaction', { emoji: btn.dataset.emoji });
});

socket.on('reaction', ({ emoji }) => {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = (15 + Math.random() * 70) + '%';
  playerContainer.appendChild(el);
  setTimeout(() => el.remove(), 2200);
});

// ── Countdown ──────────────────────────────────────────────
let countdownRafId   = null;
let countdownLastSec = -1;
let audioCtx         = null;

const countdownOverlay   = document.getElementById('countdown-overlay');
const countdownCanvas    = document.getElementById('countdown-canvas');
const countdownBtn       = document.getElementById('countdown-btn');
const cancelCountdownBtn = document.getElementById('cancel-countdown-btn');

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playBeep(freq, dur) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.28, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur);
  } catch(e) {}
}

function drawCountdownFrame(remaining, sweepProgress) {
  const cw = countdownCanvas.width, ch = countdownCanvas.height;
  const cx = cw / 2, cy = ch / 2;
  const R  = Math.min(cw, ch) * 0.41;
  const ctx = countdownCanvas.getContext('2d');

  // Background
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, cw, ch);

  // Outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(225,225,225,0.9)';
  ctx.lineWidth = 4; ctx.stroke();

  // Crosshairs extending past circle
  ctx.strokeStyle = 'rgba(200,200,200,0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - R * 1.18, cy); ctx.lineTo(cx + R * 1.18, cy);
  ctx.moveTo(cx, cy - R * 1.18); ctx.lineTo(cx, cy + R * 1.18);
  ctx.stroke();

  // Tick marks (12 positions)
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2 - Math.PI / 2;
    const maj   = i % 3 === 0;
    const inner = maj ? R * 0.76 : R * 0.87;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * R,     cy + Math.sin(angle) * R);
    ctx.strokeStyle = maj ? 'rgba(220,220,220,0.9)' : 'rgba(170,170,170,0.65)';
    ctx.lineWidth = maj ? 4 : 2; ctx.stroke();
  }

  // Sweep arm
  const sa = sweepProgress * Math.PI * 2 - Math.PI / 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sa) * R * 0.84, cy + Math.sin(sa) * R * 0.84);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = 3; ctx.stroke();

  // Centre pivot
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = 'white'; ctx.fill();

  // Inner circle framing the number
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.30, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(210,210,210,0.7)'; ctx.lineWidth = 2.5; ctx.stroke();

  // Number
  if (remaining > 0) {
    const fSize = Math.floor(R * 0.48);
    ctx.font = `bold ${fSize}px "Courier New", Courier, monospace`;
    ctx.fillStyle = 'rgba(240,240,240,0.97)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(remaining), cx, cy + fSize * 0.05);
  }

  // Corner alignment circle (classic leader mark)
  ctx.beginPath(); ctx.arc(cx + R * 0.78, cy - R * 0.78, R * 0.10, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(200,200,200,0.65)'; ctx.lineWidth = 2; ctx.stroke();

  // Film grain (random dots)
  for (let i = 0; i < 60; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * cw, Math.random() * ch, Math.random() * 1.8 + 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`; ctx.fill();
  }
  // Occasional vertical scratch
  if (Math.random() < 0.04) {
    const sx = cx + (Math.random() - 0.5) * cw * 0.8;
    ctx.beginPath();
    ctx.moveTo(sx, 0); ctx.lineTo(sx + (Math.random() - 0.5) * 30, ch);
    ctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.07 + 0.02})`;
    ctx.lineWidth = Math.random() * 1.5 + 0.5; ctx.stroke();
  }
}

function startCountdownAnim(endsAt) {
  if (countdownRafId) { cancelAnimationFrame(countdownRafId); countdownRafId = null; }
  countdownLastSec = -1;

  function frame() {
    const timeLeft = endsAt - Date.now();
    if (timeLeft <= 0) {
      drawCountdownFrame(0, 1);
      setTimeout(() => {
        countdownOverlay.style.display = 'none';
        cancelCountdownBtn.style.display = 'none';
      }, 300);
      return;
    }
    const remaining     = Math.ceil(timeLeft / 1000);
    const sweepProgress = (1000 - (timeLeft % 1000)) / 1000;

    if (remaining !== countdownLastSec) {
      countdownLastSec = remaining;
      playBeep(remaining === 1 ? 1760 : 880, remaining === 1 ? 0.25 : 0.1);
    }

    drawCountdownFrame(remaining, sweepProgress);
    countdownRafId = requestAnimationFrame(frame);
  }
  frame();
}

function stopCountdownAnim() {
  if (countdownRafId) { cancelAnimationFrame(countdownRafId); countdownRafId = null; }
  countdownOverlay.style.display = 'none';
  cancelCountdownBtn.style.display = 'none';
}

socket.on('countdown', ({ endsAt }) => {
  countdownOverlay.style.display = 'flex';
  if (isHost) cancelCountdownBtn.style.display = 'block';
  startCountdownAnim(endsAt);
});

socket.on('countdown-cancelled', stopCountdownAnim);

countdownBtn.addEventListener('click', () => socket.emit('start-countdown'));
cancelCountdownBtn.addEventListener('click', () => socket.emit('cancel-countdown'));

// ── Room settings toggles (host only) ──────────────────────
function emitSettings() {
  socket.emit('update-settings', {
    playbackLocked:  document.getElementById('toggle-lock-playback').checked,
    reactionsEnabled: document.getElementById('toggle-reactions').checked
  });
}
document.getElementById('toggle-lock-playback').addEventListener('change', emitSettings);
document.getElementById('toggle-reactions').addEventListener('change', emitSettings);
