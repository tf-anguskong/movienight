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

let isSyncing   = false;
let syncTimer   = null;
let currentKey  = null;
let hlsInstance = null;
let isHost      = false;

const autoplayOnLoad = new URLSearchParams(location.search).has('autoplay');

function esc(s = '') {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// ── Join room ──────────────────────────────────────────────
socket.on('connect', () => socket.emit('join-room', { roomId }));

socket.on('room-state', (state) => {
  isHost = state.isHost;
  roomNameEl.textContent = state.name || '';

  if (isHost) {
    document.getElementById('choose-movie-btn').style.display = 'block';
    if (state.inviteToken) setupInviteLink(state.inviteToken);
  }

  applyState(state);
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
    video.play().catch(console.warn);
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
document.getElementById('play-overlay')?.addEventListener('click', () => {
  hidePlayOverlay();
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
          hidePlayOverlay();  // autoplay allowed
          releaseSyncLock();
        }).catch(() => {
          showPlayOverlay();  // autoplay blocked — show overlay as fallback
        });
      } else {
        releaseSyncLock();
      }
    });
    hlsInstance.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
        console.warn('[HLS] Media error, attempting recovery:', d.details);
        hlsInstance.recoverMediaError();
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
          showPlayOverlay();
        });
      } else {
        releaseSyncLock();
      }
    }, { once: true });
  }
}

// ── Viewers ────────────────────────────────────────────────
socket.on('viewers', (viewers) => {
  viewersList.innerHTML = viewers.map(v => `
    <div class="viewer-item">
      ${v.picture
        ? `<img src="${v.picture}" alt="${esc(v.name)}">`
        : `<div class="viewer-avatar-placeholder">${esc(v.name[0]?.toUpperCase() || '?')}</div>`
      }
      <span>${esc(v.name)}${v.isHost ? ' 👑' : ''}${v.isGuest ? ' <span class="guest-tag">guest</span>' : ''}</span>
    </div>
  `).join('');
});

// ── Playback → server ──────────────────────────────────────
video.addEventListener('play',   () => { if (!isSyncing) socket.emit('play',  { position: video.currentTime }); });
video.addEventListener('pause',  () => { if (!isSyncing) socket.emit('pause', { position: video.currentTime }); });
video.addEventListener('seeked', () => { if (!isSyncing) socket.emit('seek',  { position: video.currentTime }); });

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
