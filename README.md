# Playdarr

> ⚠️ **Vibe coded.** This entire application was built through conversational prompting with Claude (claude-sonnet-4-6) — no traditional development workflow. The code works, but it has not been audited, formally tested, or reviewed by anyone who would describe themselves as sober. Use accordingly.

Playdarr is a self-hosted watch-party app for Plex. It lets you and your friends stream movies from your Plex server in sync, with real-time chat, reactions, and playback controls — all through a browser, no plugins required.

---

## Features

### Watching
- **Synchronised playback** — play, pause, and seek are broadcast to everyone in the room; clients drift-correct every 5 seconds using gradual playback rate nudging before falling back to a hard seek
- **Plex HLS proxy** — transcodes via your local Plex server and routes all HLS traffic through the app server, so your Plex token is never exposed to clients
- **Movie browser** — searchable, filterable (genre, rating, year) grid of your Plex library, host-only
- **YouTube rooms** — create a YouTube room instead of a movie room; the host pastes any `youtube.com` or `youtu.be` URL and the video embeds for all viewers via the YouTube IFrame API, fully synchronised; the video title is fetched automatically and shown in the sidebar and room list
- **Multi-room** — multiple watch parties can run simultaneously, each with their own state

### Rooms & Access

> **Who can host?** Only users authenticated against your own Plex server can create rooms, schedule sessions, or act as host. Playdarr verifies at login that the authenticating Plex account actually has access to the configured `PLEX_URL` — if they don't, they can't log in. Guests (people without a Plex account) can only join via an invite link shared by a Plex user; they cannot create rooms or access the lobby independently.

- **Plex login** — sign in via Plex OAuth; only accounts with verified access to your Plex server can log in and create rooms
- **Guest invite links** — hosts share a link; guests enter a display name and join without a Plex account; guests cannot see the lobby or create rooms
- **Host transfer** — the host can promote any viewer (including guests) to host mid-session; non-Plex hosts cannot create new rooms from the lobby
- **Auto host migration** — if the host leaves and other viewers remain, the room automatically promotes the next best viewer (preferring Plex users over guests) rather than closing
- **Room persistence** — rooms live in memory; a 30-second grace timer keeps a room alive if the host briefly navigates away

### Scheduled Rooms

> Scheduling is Plex-only. Guests cannot schedule rooms.

- **Schedule a room** — Plex users can schedule a watch party in advance, picking a date/time, timezone, room name, and optionally pre-selecting a movie
- **Pre-shared invite links** — the invite link is generated at scheduling time and can be shared immediately; it works both before and after the room opens
- **Waiting page** — guests who arrive early see a branded waiting page showing the scheduled date/time in their local timezone; the page polls in the background and redirects automatically when the room opens
- **First-joiner becomes host** — when the scheduled time arrives and the room opens, whoever joins first is granted host, regardless of whether they have a Plex account
- **Persistent schedule** — upcoming scheduled rooms survive server restarts (`DATA_PATH/scheduled.json`); the timer re-arms on startup
- **Default timezone** — set `DEFAULT_TIMEZONE` in `.env` to pre-fill the timezone picker when scheduling (e.g. `America/New_York`)

### Social
- **Real-time chat** — all viewers can send messages; chat includes the sender's current movie timestamp for context
- **Chat export** — download the full chat log as a `.txt` file with video timestamps
- **Play/pause attribution** — a system message appears in chat whenever someone plays or pauses, showing who did it and at what position
- **Emoji reactions** — a reaction bar (👍 ❤️ 😂 😱 😮 👏) overlays the video on hover; reactions float up the screen for all viewers
- **Countdown timer** — host can fire a countdown (3 s, 5 s, 10 s, or custom) before playback begins; all viewers see a film-leader overlay with beep tones; host can cancel mid-count
- **Intermission** — host can start a timed intermission (1–120 minutes); the video pauses for everyone and an overlay displays the movie poster with a live MM:SS countdown; the movie resumes automatically when the timer ends, or the host can end it early

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
| `DEFAULT_TIMEZONE` | No | IANA timezone used as the default when scheduling rooms (e.g. `America/New_York`). Falls back to `UTC`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | No | Cloudflare Zero Trust tunnel token if using Cloudflare for HTTPS |
| `PORT` | No | Port to listen on (default: `3000`) |

---

## Deployment notes

- **PLEX_URL must be a LAN address.** If you use your external domain, every video segment will travel out through Cloudflare and back in, saturating your upload and likely hitting Cloudflare's limits.
- **COOKIE_SECURE must match your protocol.** `true` behind HTTPS, `false` over plain HTTP. Getting this wrong will silently break all sessions.
- Rooms and chat are **in-memory only** — everything is lost on server restart. This is intentional.
- The stream proxy restricts forwarded requests to Plex transcode paths only (`/video/:/transcode/universal/` and `/library/parts/`). Arbitrary Plex API access through the proxy is blocked.
