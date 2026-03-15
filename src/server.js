require('dotenv').config();
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
const moviesRouter = require('./routes/movies');
const { router: streamRouter, clearRoomManifest } = require('./routes/stream');
const { setupSync, getRoomByInviteToken } = require('./sync');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 1);

// Temporary request logger — remove once join link issue is diagnosed
app.use((req, _res, next) => {
  console.log(`[HTTP] ${req.method} ${req.path}`);
  next();
});

// Security headers
// HSTS is only valid over HTTPS — sending it over HTTP causes Firefox to cache
// the upgrade and break subsequent requests to http://localhost.
const behindHttps = process.env.COOKIE_SECURE === 'true';
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
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
app.use('/api/stream', requireAuth, streamRouter);
app.get('/api/me', (req, res) => res.json({ user: req.session?.user || null }));

app.post('/api/me/display-name', requirePlexAuth, (req, res) => {
  const name = (req.body?.name || '').trim().slice(0, 40);
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

app.get('/', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/watch/:roomId', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'watch.html')));

// Info endpoint used by join.html to get roomId before posting guest session
// Does not return roomName to avoid information leakage
app.get('/join/:inviteToken/info', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const room = getRoomByInviteToken(req.params.inviteToken);
  if (!room) return res.status(404).json({ error: 'Invite expired or invalid' });
  res.json({ roomId: room.id });
});

// Invite link — public, no auth required
app.get('/join/:inviteToken', (req, res) => {
  // Prevent proxies/CDNs from caching this response — room existence is dynamic
  res.setHeader('Cache-Control', 'no-store');
  const room = getRoomByInviteToken(req.params.inviteToken);
  console.log(`[Join] token=${req.params.inviteToken} found=${!!room}`);
  if (!room) return res.redirect('/?error=expired');
  // If already logged in (Plex), save the invite token in session and go straight to the room
  if (req.session?.user && !req.session.user.isGuest) {
    req.session.user.inviteToken = req.params.inviteToken;
    return req.session.save(() => res.redirect(`/watch/${room.id}`));
  }
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.get('/login', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

setupSync(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Movie Night running on port ${PORT}`));
