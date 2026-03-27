require('dotenv').config();

// Prefix every console log/warn/error with an ISO timestamp
['log', 'warn', 'error'].forEach(level => {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(`[${new Date().toISOString()}]`, ...args);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRouter = require('./routes/auth');
const { sanitizeText } = require('./sanitize');
const moviesRouter = require('./routes/movies');
const showsRouter = require('./routes/shows');
const { router: streamRouter, clearRoomManifest } = require('./routes/stream');
const { setupSync, getRoomByInviteToken, createScheduledRoom, getRoom } = require('./sync');
const scheduler = require('./scheduler');
const scheduleRouter = require('./routes/schedule');

const enabledRoomTypes = {
  movie:   process.env.ROOM_TYPE_MOVIE   !== 'false',
  tv:      process.env.ROOM_TYPE_TV      !== 'false',
  youtube: process.env.ROOM_TYPE_YOUTUBE !== 'false',
  livetv:  process.env.ROOM_TYPE_LIVETV  === 'true',
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);

// Security headers
// HSTS is only valid over HTTPS — sending it over HTTP causes Firefox to cache
// the upgrade and break subsequent requests to http://localhost.
const behindHttps = process.env.COOKIE_SECURE === 'true';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'cdn.jsdelivr.net', 'https://www.youtube.com', 'https://s.ytimg.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", ...(process.env.APP_URL ? [`wss://${new URL(process.env.APP_URL).host}`, `ws://${new URL(process.env.APP_URL).host}`] : ['wss:', 'ws:'])],
      frameSrc: ["'self'", 'https://www.youtube.com'],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'https:'],
    }
  },
  hsts: behindHttps ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json());

const sessionsDir = process.env.DATA_PATH
  ? path.join(process.env.DATA_PATH, 'sessions')
  : '/data/sessions';
fs.mkdirSync(sessionsDir, { recursive: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET env var must be set and at least 32 characters long');
}

const sessionMiddleware = session({
  store: new FileStore({ path: sessionsDir, ttl: 7 * 24 * 3600, retries: 1 }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.COOKIE_SECURE === 'true',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});
io.use((socket, next) => {
  const user = socket.request.session?.user;
  if (user) { socket.user = user; next(); }
  else next(new Error('Unauthorized'));
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // Non-page requests (HLS/XHR/fetch) should get a 401, not an HTML redirect —
  // a redirect causes HLS.js to silently receive a login page and stall.
  const acceptsHtml = req.headers.accept?.includes('text/html');
  if (!acceptsHtml) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
}

function requirePlexAuth(req, res, next) {
  if (req.session?.user && !req.session.user.isGuest) return next();
  if (req.headers.accept?.includes('json')) return res.status(403).json({ error: 'Plex account required' });
  res.redirect('/login');
}

// Rate limit auth endpoints — prevents PIN enumeration and brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

app.use('/auth', authLimiter, authRouter);
app.use('/api/movies', requirePlexAuth, moviesRouter);
app.use('/api/shows', requirePlexAuth, showsRouter);
// Segment proxy is the high-volume path (one request per .ts chunk, every few
// seconds per viewer). The manifest endpoint is called once per movie load and
// must never be rate-limited — a 429 there kills the whole stream startup.
// The segment limiter is registered first so it runs before the stream router.
const segmentLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 600,                   // 600 segment requests per minute per IP (~10/s)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many stream requests' }
});
app.use('/api/stream/proxy', segmentLimiter);
app.use('/api/stream', requireAuth, streamRouter);
app.use('/api/schedule', requirePlexAuth, scheduleRouter);

app.get('/api/config', (req, res) => res.json({ enabledRoomTypes }));

if (enabledRoomTypes.livetv) {
  app.use('/api/livetv', requireAuth, require('./routes/livetv'));
}

app.get('/api/me', (req, res) => {
    const user = req.session?.user || null;
    if (!user) return res.json({ user: null });
    const { plexToken, ...safeUser } = user;
    res.json({ user: safeUser });
});

app.post('/api/me/display-name', requirePlexAuth, (req, res) => {
  const name = sanitizeText((req.body?.name || '').trim().slice(0, 40));
  if (!name) return res.status(400).json({ error: 'Name required' });
  req.session.user.displayName = name;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({ name });
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

app.get('/', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/watch/:roomId', (req, res, next) => {
  // Discord/Slack/Telegram crawlers don't have a session — intercept before requireAuth
  // and return a lightweight OG preview page so link unfurls work.
  const ua = req.headers['user-agent'] || '';
  if (/discordbot|slackbot|telegrambot|whatsapp|twitterbot|facebookexternalhit/i.test(ua)) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const room = getRoom(req.params.roomId);
    const title = room
      ? (room.movieTitle || room.liveTvChannelTitle
          ? `${room.name} — ${room.movieTitle || room.liveTvChannelTitle}`
          : room.name)
      : 'Playdarr';
    const desc = room
      ? 'Click to join!'
      : 'Join the room on Playdarr.';
    const url = `${process.env.APP_URL || ''}/watch/${req.params.roomId}`;
    return res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Playdarr">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
</head><body></body></html>`);
  }
  requireAuth(req, res, () => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  });
});

// Info endpoint used by join.html and waiting.html to get roomId or scheduled info
app.get('/join/:inviteToken/info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const token = req.params.inviteToken;

  // Check active rooms first
  const room = getRoomByInviteToken(token);
  if (room) return res.json({ roomId: room.id });

  // Check scheduled rooms
  const scheduled = scheduler.getByInviteToken(token);
  if (scheduled) {
    return res.json({
      scheduled:    true,
      scheduledFor: scheduled.scheduledFor,
      name:         scheduled.name,
      timezone:     scheduled.timezone
    });
  }

  res.status(404).json({ error: 'Invite expired or invalid' });
});

// Invite link — public, no auth required
app.get('/join/:inviteToken', (req, res) => {
  // Prevent proxies/CDNs from caching this response — room existence is dynamic
  res.setHeader('Cache-Control', 'no-store');
  const token = req.params.inviteToken;
  const room  = getRoomByInviteToken(token);

  const ua = req.headers['user-agent'] || '';
  if (/discordbot|slackbot|telegrambot|whatsapp|twitterbot|facebookexternalhit/i.test(ua)) {
    const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const title = room
      ? (room.movieTitle || room.liveTvChannelTitle
          ? `${room.name} — ${room.movieTitle || room.liveTvChannelTitle}`
          : room.name)
      : 'Playdarr';
    const desc = room
      ? 'Click to join!'
      : 'Join the room on Playdarr.';
    const url = `${process.env.APP_URL || ''}/join/${token}`;
    return res.send(`<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Playdarr">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
</head><body></body></html>`);
  }
  console.log(`[Join] token=${token} found=${!!room}`);

  if (room) {
    // Active room exists
    if (req.session?.user && !req.session.user.isGuest) {
      req.session.user.inviteToken = token;
      return req.session.save(() => res.redirect(`/watch/${room.id}`));
    }
    return res.sendFile(path.join(__dirname, 'public', 'join.html'));
  }

  // Check if it's a scheduled room not yet open
  const scheduled = scheduler.getByInviteToken(token);
  if (scheduled) {
    // Pass data as query params so waiting.html can render immediately
    // without needing a separate async fetch for initial display
    if (!req.query.t) {
      const q = new URLSearchParams({
        n: scheduled.name,
        t: scheduled.scheduledFor,
        z: scheduled.timezone || 'UTC'
      });
      return res.redirect(`/join/${token}?${q}`);
    }
    return res.sendFile(path.join(__dirname, 'public', 'waiting.html'));
  }

  res.redirect('/?error=expired');
});

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

setupSync(io, enabledRoomTypes);

scheduler.init((scheduled) => {
  const room = createScheduledRoom(scheduled);
  console.log(`[Scheduler] Room "${room.name}" opened from schedule (roomId=${room.id})`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Movie Night running on port ${PORT}`));
