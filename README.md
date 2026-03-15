# Playdarr

> ⚠️ **Vibe coded.** This entire application was built through conversational prompting with Claude (claude-sonnet-4-6) — no traditional development workflow. The code works, but it has not been audited, formally tested, or reviewed by anyone who would describe themselves as sober. Use accordingly.

Playdarr is a self-hosted watch-party app for Plex. It lets you and your friends stream movies from your Plex server in sync, with real-time chat, reactions, and playback controls — all through a browser, no plugins required.

---

## Features

### Watching
- **Synchronised playback** — play, pause, and seek are broadcast to everyone in the room; clients drift-correct every 5 seconds using gradual playback rate nudging before falling back to a hard seek
- **Plex HLS proxy** — transcodes via your local Plex server and routes all HLS traffic through the app server, so your Plex token is never exposed to clients
- **Movie browser** — searchable, filterable (genre, rating, year) grid of your Plex library, host-only
- **Multi-room** — multiple watch parties can run simultaneously, each with their own state

### Rooms & Access
- **Plex login** — sign in via Plex OAuth; any user with access to the Plex server can create a room
- **Guest invite links** — share a link; guests enter a display name and join without a Plex account
- **Host transfer** — the host can promote any viewer (including guests) to host mid-session
- **Room persistence** — rooms live in memory; a 30-second grace timer keeps a room alive if the host briefly navigates away

### Social
- **Real-time chat** — all viewers can send messages; chat includes the sender's current movie timestamp for context
- **Play/pause attribution** — a system message appears in chat whenever someone plays or pauses, showing who did it and at what position
- **Emoji reactions** — a reaction bar (👍 ❤️ 😂 😱 😮 👏) overlays the video on hover; reactions float up the screen for all viewers
- **Countdown timer** — host can start a 10-second countdown before playback begins; all viewers see the overlay; host can cancel mid-count

---

## Stack

- **Backend** — Node.js, Express, Socket.io
- **Frontend** — vanilla JS, no framework
- **Streaming** — Plex HLS transcoding proxied server-side; [HLS.js](https://github.com/video-dev/hls.js) on the client
- **Auth** — Plex PIN-based OAuth for Plex users; session-based guest tokens for invited viewers
- **Sessions** — `express-session` with `session-file-store`
- **Deployment** — Docker + optional Cloudflare Tunnel or NGINX reverse proxy

---

## Setup

### Prerequisites
- A running Plex Media Server accessible on your LAN
- Docker (recommended) or Node.js 18+

### Quick start with Docker

```bash
cp .env.example .env
# Edit .env — see configuration section below
docker compose up --build -d
docker compose logs -f
```

### Local development

```bash
cp .env.example .env
# Edit .env
npm install
npm run dev   # nodemon auto-reload on http://localhost:3000
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Random secret for signing session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLEX_URL` | Yes | Local/LAN address of your Plex server as seen from the Docker container (e.g. `http://host.docker.internal:32400`). **Never use your external domain** — transcoding must not round-trip through Cloudflare. |
| `PLEX_TOKEN` | Yes | Server token from Plex Settings → Troubleshooting |
| `APP_URL` | Yes | Public-facing URL of this app, used to build the Plex OAuth callback (e.g. `https://playdarr.yourdomain.com` or `http://localhost:3000` for local dev) |
| `COOKIE_SECURE` | Yes | `true` when running behind HTTPS, `false` for local dev |
| `PLEX_CLIENT_ID` | No | Identifier sent to Plex — any stable string (default: `movienight-app`) |
| `CLOUDFLARE_TUNNEL_TOKEN` | No | Cloudflare Zero Trust tunnel token if using Cloudflare for HTTPS |
| `PORT` | No | Port to listen on (default: `3000`) |

---

## Deployment notes

- **PLEX_URL must be a LAN address.** If you use your external domain, every video segment will travel out through Cloudflare and back in, saturating your upload and likely hitting Cloudflare's limits.
- **COOKIE_SECURE must match your protocol.** `true` behind HTTPS, `false` over plain HTTP. Getting this wrong will silently break all sessions.
- Rooms and chat are **in-memory only** — everything is lost on server restart. This is intentional.
- The stream proxy restricts forwarded requests to Plex transcode paths only (`/video/:/transcode/universal/` and `/library/parts/`). Arbitrary Plex API access through the proxy is blocked.
