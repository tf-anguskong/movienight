'use strict';

const socket = io();

function esc(s = '') {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s));
  return d.innerHTML;
}

// ── User info ──────────────────────────────────────────────
let currentUserId = null;

async function loadUser() {
  const { user } = await fetch('/api/me').then(r => r.json());
  if (!user) return;
  currentUserId = user.id || null;
  document.getElementById('user-name').textContent = user.displayName || user.name;
  if (user.picture) {
    const a = document.getElementById('user-avatar');
    a.src = user.picture; a.style.display = 'block';
  }
  if (!user.isGuest) {
    document.getElementById('create-room-btn').style.display = 'inline-flex';
    document.getElementById('schedule-room-btn').style.display = 'inline-flex';
    document.getElementById('edit-name-btn').style.display = 'inline';
    loadScheduled();
  }
}

// ── Display name editor ────────────────────────────────────
const editBtn    = document.getElementById('edit-name-btn');
const nameEditor = document.getElementById('name-editor');
const nameInput  = document.getElementById('name-input');
const nameSave   = document.getElementById('name-save-btn');
const nameCancel = document.getElementById('name-cancel-btn');

function openNameEditor() {
  nameInput.value = document.getElementById('user-name').textContent;
  nameEditor.style.display = 'flex';
  editBtn.style.display = 'none';
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 30);
}

function closeNameEditor() {
  nameEditor.style.display = 'none';
  editBtn.style.display = 'inline';
}

async function saveName() {
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const { name: saved } = await fetch('/api/me/display-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(r => r.json());
    document.getElementById('user-name').textContent = saved;
    closeNameEditor();
  } catch { alert('Failed to save name.'); }
}

editBtn.addEventListener('click', openNameEditor);
nameSave.addEventListener('click', saveName);
nameCancel.addEventListener('click', closeNameEditor);
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveName();
  if (e.key === 'Escape') closeNameEditor();
});

// ── Room list ──────────────────────────────────────────────
socket.on('room-list', (rooms) => {
  const grid = document.getElementById('rooms-grid');
  if (!rooms.length) {
    grid.innerHTML = '<div class="loading">No rooms yet — create one to get started!</div>';
    return;
  }
  grid.innerHTML = rooms.map(r => `
    <div class="room-card">
      <div class="room-card-header">
        <span class="room-card-name">${esc(r.name)}</span>
        <span class="room-host">hosted by ${esc(r.hostName)}</span>
      </div>
      <div class="room-card-movie">
        ${r.roomType === 'youtube'
          ? `<span class="room-now-playing">▶ ${r.movieTitle ? esc(r.movieTitle) : (r.youtubeVideoId ? 'YouTube' : 'No video set')}</span>`
          : r.hasMovie
            ? `<span class="room-now-playing">▶ ${esc(r.movieTitle)}</span>`
            : `<span style="color:var(--text-muted)">No movie selected yet</span>`
        }
      </div>
      <div class="room-card-footer">
        <span class="room-viewers">${r.viewerCount} watching</span>
        <a class="btn-join" href="/watch/${r.id}">Join →</a>
      </div>
    </div>
  `).join('');
});

// ── Create room ────────────────────────────────────────────
let selectedRoomType = 'movie';

document.querySelectorAll('.btn-room-type').forEach(btn => {
  btn.addEventListener('click', () => {
    selectedRoomType = btn.dataset.type;
    document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('yt-url-row').style.display = selectedRoomType === 'youtube' ? 'block' : 'none';
    if (selectedRoomType === 'youtube') setTimeout(() => document.getElementById('yt-url-create').focus(), 30);
    else setTimeout(() => document.getElementById('room-name-input').focus(), 30);
  });
});

document.getElementById('create-room-btn').addEventListener('click', () => {
  // Reset modal state
  selectedRoomType = 'movie';
  document.querySelectorAll('.btn-room-type').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-type="movie"]').classList.add('active');
  document.getElementById('room-name-input').value = '';
  document.getElementById('yt-url-create').value = '';
  document.getElementById('yt-url-create-error').style.display = 'none';
  document.getElementById('yt-url-row').style.display = 'none';
  document.getElementById('create-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('room-name-input').focus(), 50);
});
document.getElementById('cancel-create').addEventListener('click', () => {
  document.getElementById('create-modal').style.display = 'none';
});
document.getElementById('confirm-create').addEventListener('click', createRoom);
document.getElementById('room-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') createRoom();
  if (e.key === 'Escape') document.getElementById('create-modal').style.display = 'none';
});
document.getElementById('yt-url-create').addEventListener('keydown', e => {
  if (e.key === 'Enter') createRoom();
  if (e.key === 'Escape') document.getElementById('create-modal').style.display = 'none';
});

function createRoom() {
  const name = document.getElementById('room-name-input').value.trim();
  if (selectedRoomType === 'youtube') {
    const youtubeUrl = document.getElementById('yt-url-create').value.trim();
    const errEl = document.getElementById('yt-url-create-error');
    if (!youtubeUrl) {
      errEl.textContent = 'YouTube URL is required';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    document.getElementById('create-modal').style.display = 'none';
    socket.emit('create-room', { name, roomType: 'youtube', youtubeUrl });
  } else {
    document.getElementById('create-modal').style.display = 'none';
    socket.emit('create-room', { name });
  }
}

socket.on('room-created', ({ roomId }) => {
  window.location.href = `/watch/${roomId}`;
});

socket.on('error-msg', (msg) => alert(msg));

// ── Schedule room ──────────────────────────────────────────

function populateTimezones() {
  const sel = document.getElementById('sched-timezone');
  const commonZones = [
    'Pacific/Honolulu','America/Anchorage','America/Los_Angeles','America/Denver',
    'America/Chicago','America/New_York','America/Halifax','America/Sao_Paulo',
    'Atlantic/Azores','Europe/London','Europe/Paris','Europe/Berlin','Europe/Helsinki',
    'Europe/Moscow','Asia/Dubai','Asia/Kolkata','Asia/Bangkok','Asia/Singapore',
    'Asia/Tokyo','Australia/Sydney','Pacific/Auckland'
  ];
  let zones;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    zones = commonZones;
  }

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  zones.forEach(tz => {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz;
    if (tz === browserTz) opt.selected = true;
    sel.appendChild(opt);
  });

  // Fallback: if browser tz wasn't in the list, try to select it or default to UTC
  if (!sel.value) sel.value = 'UTC';
}

function openScheduleModal() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const localMin = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
    + 'T' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  const dt = document.getElementById('sched-datetime');
  dt.min = localMin;
  dt.value = '';

  document.getElementById('sched-name').value = '';
  document.getElementById('sched-movie-display').value = '';
  document.getElementById('sched-movie-key').value = '';
  document.getElementById('sched-movie-partid').value = '';
  document.getElementById('sched-movie-clear').style.display = 'none';
  document.getElementById('sched-error').style.display = 'none';
  document.getElementById('schedule-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('sched-name').focus(), 50);
}

// ── Schedule movie browser ──────────────────────────────────
let schedMovieSearchTimeout = null;

async function loadSchedMovies() {
  const grid   = document.getElementById('sched-movies-grid');
  const search = document.getElementById('sched-search-input').value.trim();
  const genre  = document.getElementById('sched-genre-select').value;
  const sort   = document.getElementById('sched-sort-select').value;

  grid.innerHTML = '<div class="loading">Loading movies…</div>';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (genre)  params.set('genre', genre);
  if (sort)   params.set('sort', sort);

  try {
    const { movies, genres, error } = await fetch(`/api/movies?${params}`).then(r => r.json());
    if (error) throw new Error(error);

    const genreSelect = document.getElementById('sched-genre-select');
    const currentGenre = genreSelect.value;
    if (genres?.length) {
      genreSelect.innerHTML = '<option value="">All genres</option>' +
        genres.map(g => `<option value="${esc(g)}"${g === currentGenre ? ' selected' : ''}>${esc(g)}</option>`).join('');
    }

    document.getElementById('sched-movie-count').textContent =
      movies.length ? `${movies.length} movie${movies.length !== 1 ? 's' : ''}` : '';

    if (!movies.length) {
      grid.innerHTML = '<div class="loading">No movies found.</div>';
      return;
    }

    grid.innerHTML = movies.map(m => `
      <div class="movie-card" data-key="${esc(m.ratingKey)}" data-title="${esc(m.title)}">
        ${m.thumb
          ? `<img class="movie-poster" src="${esc(m.thumb)}" alt="${esc(m.title)}" loading="lazy">`
          : `<div class="movie-poster-placeholder">🎬</div>`}
        <div class="movie-info">
          <h3 title="${esc(m.title)}">${esc(m.title)}</h3>
          <span>${m.year || ''}${m.year && m.rating ? ' · ' : ''}${m.rating ? '★ ' + Number(m.rating).toFixed(1) : ''}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.movie-card').forEach(card => {
      card.addEventListener('click', () => selectSchedMovie(card.dataset.key, card.dataset.title));
    });
  } catch (err) {
    grid.innerHTML = `<div class="loading">Error: ${esc(err.message)}</div>`;
  }
}

async function selectSchedMovie(ratingKey, title) {
  try {
    const movie = await fetch(`/api/movies/${ratingKey}`).then(r => r.json());
    if (!movie.partId) { alert('No stream found for this movie.'); return; }

    document.getElementById('sched-movie-display').value = movie.title || title;
    document.getElementById('sched-movie-key').value     = movie.ratingKey;
    document.getElementById('sched-movie-partid').value  = movie.partId;
    document.getElementById('sched-movie-clear').style.display = 'inline-flex';

    document.getElementById('sched-movie-modal').style.display = 'none';
    document.getElementById('schedule-modal').style.display    = 'flex';
  } catch {
    alert('Failed to load movie details.');
  }
}

document.getElementById('sched-movie-btn').addEventListener('click', () => {
  document.getElementById('schedule-modal').style.display    = 'none';
  document.getElementById('sched-movie-modal').style.display = 'flex';
  loadSchedMovies();
});

document.getElementById('sched-movie-clear').addEventListener('click', () => {
  document.getElementById('sched-movie-display').value = '';
  document.getElementById('sched-movie-key').value     = '';
  document.getElementById('sched-movie-partid').value  = '';
  document.getElementById('sched-movie-clear').style.display = 'none';
});

document.getElementById('close-sched-movie-modal').addEventListener('click', () => {
  document.getElementById('sched-movie-modal').style.display = 'none';
  document.getElementById('schedule-modal').style.display    = 'flex';
});

document.getElementById('sched-search-input').addEventListener('input', () => {
  clearTimeout(schedMovieSearchTimeout);
  schedMovieSearchTimeout = setTimeout(loadSchedMovies, 300);
});
document.getElementById('sched-genre-select').addEventListener('change', loadSchedMovies);
document.getElementById('sched-sort-select').addEventListener('change', loadSchedMovies);

async function submitSchedule() {
  const nameEl  = document.getElementById('sched-name');
  const dtEl    = document.getElementById('sched-datetime');
  const tzEl    = document.getElementById('sched-timezone');
  const errEl   = document.getElementById('sched-error');

  const name       = nameEl.value.trim();
  const dtLocal    = dtEl.value;
  const timezone   = tzEl.value;
  const movieKey   = document.getElementById('sched-movie-key').value   || null;
  const movieTitle = document.getElementById('sched-movie-display').value.trim() || null;
  const partId     = document.getElementById('sched-movie-partid').value || null;

  errEl.style.display = 'none';

  if (!dtLocal) {
    errEl.textContent = 'Please choose a date and time.';
    errEl.style.display = 'block';
    return;
  }

  const scheduledFor = new Date(dtLocal).toISOString();

  if (new Date(scheduledFor) <= new Date()) {
    errEl.textContent = 'Scheduled time must be in the future.';
    errEl.style.display = 'block';
    return;
  }

  try {
    const res  = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name || 'Movie Night', scheduledFor, timezone, movieKey, movieTitle, partId })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Failed to schedule room.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('schedule-modal').style.display = 'none';
    loadScheduled();
  } catch {
    errEl.textContent = 'Network error. Please try again.';
    errEl.style.display = 'block';
  }
}

async function loadScheduled() {
  try {
    const res  = await fetch('/api/schedule');
    if (!res.ok) return;
    const { scheduled } = await res.json();
    renderScheduled(scheduled || []);
  } catch {
    renderScheduled([]);
  }
}

function renderScheduled(list) {
  const section = document.getElementById('scheduled-section');
  const grid    = document.getElementById('scheduled-grid');

  if (!list.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  grid.innerHTML = list.map(s => {
    const tz = s.timezone || 'UTC';
    let timeStr;
    try {
      timeStr = new Date(s.scheduledFor).toLocaleString(undefined, {
        timeZone: tz,
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      });
    } catch {
      timeStr = s.scheduledFor;
    }

    const inviteUrl = window.location.origin + '/join/' + s.inviteToken;
    const isOwner   = currentUserId && s.createdBy && s.createdBy.id === currentUserId;

    return `
      <div class="room-card scheduled-card">
        <div class="room-card-header">
          <span class="room-card-name">${esc(s.name)}</span>
          <span class="sched-badge">Scheduled</span>
        </div>
        <div class="room-card-movie">
          ${s.movieTitle ? `<span class="room-now-playing">🎬 ${esc(s.movieTitle)}</span><br>` : ''}
          <span style="color:var(--text-muted);font-size:0.82rem">Opens ${esc(timeStr)}</span>
        </div>
        <div class="room-card-footer">
          <span class="room-viewers">by ${esc(s.createdBy ? s.createdBy.name : 'unknown')}</span>
          <div style="display:flex;gap:0.4rem;align-items:center">
            <button class="btn-copy-link" data-url="${esc(inviteUrl)}" title="Copy invite link">Copy Link</button>
            ${isOwner ? `<button class="btn-cancel-sched" data-id="${esc(s.id)}">Cancel</button>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Wire up copy-link buttons
  grid.querySelectorAll('.btn-copy-link').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.url).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }).catch(() => alert(btn.dataset.url));
    });
  });

  // Wire up cancel buttons
  grid.querySelectorAll('.btn-cancel-sched').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Cancel this scheduled room?')) return;
      try {
        const res = await fetch('/api/schedule/' + btn.dataset.id, { method: 'DELETE' });
        if (res.ok) {
          loadScheduled();
        } else {
          const d = await res.json();
          alert(d.error || 'Failed to cancel.');
        }
      } catch {
        alert('Network error.');
      }
    });
  });
}

// Wire up schedule modal buttons
document.getElementById('schedule-room-btn').addEventListener('click', openScheduleModal);
document.getElementById('sched-cancel').addEventListener('click', () => {
  document.getElementById('schedule-modal').style.display = 'none';
});
document.getElementById('sched-confirm').addEventListener('click', submitSchedule);
document.getElementById('sched-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitSchedule();
  if (e.key === 'Escape') document.getElementById('schedule-modal').style.display = 'none';
});

// Populate timezone dropdown once on load
populateTimezones();

loadUser();
