# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Local development (requires .env file)
npm install
npm run dev        # nodemon auto-reload

# Production
npm start          # node src/server.js

# Docker
docker compose up --build -d
docker compose logs -f
docker compose down

# Generate a session secret
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

No test suite exists. There is no linter configured.

## Environment Setup

Copy `.env.example` to `.env`. Key variables:

- `PLEX_URL` — must be a **local/LAN address** (e.g. `http://host.docker.internal:32400`), never the external domain. Plex transcoding requests must stay on the LAN.
- `COOKIE_SECURE` — set `true` only when behind HTTPS (reverse proxy). Controls the session cookie `secure` flag directly; **not** driven by `NODE_ENV`.
- `APP_URL` — public-facing URL, used to build the Plex OAuth callback URL.
- `PLEX_TOKEN` — server token from Plex Settings → Troubleshooting.

Sessions are stored in `session-file-store` at `/data/sessions` (Docker volume). The `DATA_PATH` env var overrides the base path for local dev.

## Architecture

### Real-time sync model

`src/sync.js` is the core. The server maintains authoritative playback state per room:

```
{ playing, position, lastUpdate }
```

Current position is computed as `position + (Date.now() - lastUpdate) / 1000` when playing. Clients receive a `state` event and snap their video if drift > 1.5s. The `isSyncing` flag in `player.js` prevents feedback loops when the player fires `play/pause/seeked` in response to programmatic changes.

### Multi-room system

- `rooms` Map (roomId → Room) and `inviteTokens` Map (token → roomId) live in memory in `sync.js` — rooms are **not** persisted.
- `socketToRoom` Map enables O(1) lookup when any socket event arrives.
- Host disconnect triggers an **8-second grace timer** before closing the room, to survive lobby→watch page navigation (which creates a new socket). The timer is cancelled if the host rejoins before it fires.
- Guests are validated by comparing `user.inviteToken` (stored in session) against `room.inviteToken`.

### Plex HLS proxy

Plex's `/video/:/transcode/universal/start.m3u8` returns an HLS manifest containing internal Plex URLs and tokens. The proxy pipeline:

1. `GET /api/stream/hls/:ratingKey/master.m3u8` — starts a Plex transcode session and rewrites all URLs in the returned m3u8 to `/api/stream/proxy/…`, stripping `X-Plex-Token`.
2. `GET /api/stream/proxy/*` — forwards requests to Plex (adding the token server-side). m3u8 files are buffered and rewritten; `.ts` segments are piped directly.
3. The `baseDir` variable is critical for resolving **relative** paths in sub-manifests (Plex returns paths like `session/xxx/base/index.m3u8` with no leading slash).

**Important quirk**: axios encodes `/` as `%2F` in query params. The `path` param sent to Plex requires literal slashes, so the query string is built manually in `stream.js`.

### Auth flow

- Plex OAuth uses PIN-based flow (not standard OAuth redirect). The PIN ID is embedded in the **callback URL path** (`/auth/plex/callback/:pinId`) rather than the session, because the session cookie may not be available across the Plex redirect.
- After OAuth, the server verifies the user has access to the local Plex server by hitting `PLEX_URL` with their token.
- Guests get a session with `{ isGuest: true, name, inviteToken }` via `POST /auth/guest-join`.
- `requireAuth` — any session user (Plex or guest). `requirePlexAuth` — non-guest only.

### Socket authentication

Session middleware is shared between Express and Socket.io (both use the same `sessionMiddleware` instance). A Socket.io middleware layer reads `socket.request.session.user` and attaches it as `socket.user`.

### Frontend pages

- `index.html` + `lobby.js` — room list, create room modal (Plex users only)
- `watch.html` + `player.js` — video player, sidebar (viewers, invite link, sync status), movie browser modal (host only)
- `join.html` — public invite landing page; fetches `/join/:inviteToken/info` for roomId, then POSTs guest session
- `login.html` — Plex-only login page

All styling is in a single `src/public/css/app.css` with CSS custom properties for the dark cinema theme.
