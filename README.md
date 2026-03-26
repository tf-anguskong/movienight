# Playdarr

> ⚠️ **Vibe coded.** This entire application was built through conversational prompting with Claude (claude-sonnet-4-6) — no traditional development workflow. The code works, but it has not been audited, formally tested, or reviewed by anyone who would describe themselves as sober. Use accordingly.

Playdarr is a self-hosted watch-party app for Plex. It lets you and your friends stream movies from your Plex server in sync, with real-time chat, reactions, and playback controls — all through a browser, no plugins required.

## What is Playdarr?

Playdarr is a self-hosted watch-party app built around Plex. The idea is simple: you own the media, you own the server, and you invite whoever you want to watch with you — no subscriptions, no third-party accounts, no data leaving your infrastructure.

A Plex user creates a room, shares an invite link, and guests join straight from their browser. Playback is kept in sync across all viewers automatically. Everyone gets chat, reactions, and a shared experience without anyone needing a Plex account except the person hosting.

---

## Features

### Watching
- **Synchronised playback** — play, pause, and seek are broadcast to everyone in the room; clients drift-correct every 5 seconds using gradual playback rate nudging before falling back to a hard seek
- **Plex HLS proxy** — transcodes via your local Plex server and routes all HLS traffic through the app server, so your Plex token is never exposed to clients
- **Movie browser** — searchable, filterable (genre, rating, year) grid of your Plex library, host-only
- **YouTube rooms** — create a YouTube room instead of a movie room; the host pastes any `youtube.com` or `youtu.be` URL and the video embeds for all viewers via the YouTube IFrame API, fully synchronised; the video title is fetched automatically and shown in the sidebar and room list
- **Multi-room** — multiple watch parties can run simultaneously, each with their own state

### Rooms & Access

> **Who can create rooms?** Only users authenticated against your own Plex server can create rooms or schedule sessions. Playdarr verifies at login that the authenticating Plex account actually has access to the configured `PLEX_URL` — if they don't, they can't log in. Guests (people without a Plex account) can only join via an invite link shared by a Plex user; they cannot create rooms, schedule sessions, or access the lobby independently. A guest can be granted host of an existing room via transfer or auto-migration, but that only gives them control over playback — they still cannot open new rooms.

- **Plex login** — sign in via Plex OAuth; only accounts with verified access to your Plex server can log in and create rooms
- **Guest invite links** — hosts share a link; guests enter a display name and join without a Plex account; guests cannot see the lobby or create rooms
- **Host transfer** — the host can promote any viewer (including guests) to host mid-session, giving them playback control for that room; guests granted host cannot create new rooms or scheduled events
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
- **Deployment** — Docker + reverse proxy of your choice

---

## Setup

### Prerequisites
- A running Plex Media Server accessible on your LAN
- Docker (recommended) or Node.js 18+

### 1. Clone and configure

```bash
git clone https://github.com/tf-anguskong/Playdarr.git
cd Playdarr
cp .env.example .env
```

Open `.env` and fill in the required values — see the [Configuration](#configuration) section below for details. At minimum you need `SESSION_SECRET`, `PLEX_URL`, `PLEX_TOKEN`, `APP_URL`, and `COOKIE_SECURE`.

### 2. Run with Docker (recommended)

```bash
docker compose up --build -d
docker compose logs -f
```

Playdarr will be available at `http://localhost:3000` (or whichever `PORT` you configured).

### 3. Expose it to the internet

Playdarr needs to be reachable over HTTPS for guests to join from outside your network. Serve it however you like — NGINX, Caddy, Traefik, Tailscale, or any other reverse proxy or tunnel solution.

A minimal NGINX config:

```nginx
server {
    listen 443 ssl;
    server_name playdarr.yourdomain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;

        # Required for Socket.io
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Allow long-lived HLS segment requests
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Set `APP_URL` to your domain and `COOKIE_SECURE=true` in `.env`.

> **Tip:** [NGINX Proxy Manager](https://nginxproxymanager.com/) provides a web UI that handles proxy hosts, SSL certificates (via Let's Encrypt), and WebSocket support with minimal configuration. It runs as a Docker container and is a popular choice for home lab setups.

---

### Local development

```bash
cp .env.example .env
# Edit .env — set APP_URL=http://localhost:3000 and COOKIE_SECURE=false
npm install
npm run dev   # nodemon auto-reload on http://localhost:3000
```

---

## Configuration

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `SESSION_SECRET` | Yes | Random secret for signing session cookies. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PLEX_URL` | Yes | Local/LAN address of your Plex server as seen from the Docker container (e.g. `http://host.docker.internal:32400`). **Never use your external domain** — transcoding traffic must stay on your LAN. |
| `PLEX_TOKEN` | Yes | Server token from Plex Settings → Troubleshooting |
| `APP_URL` | Yes | Public-facing URL of this app, used to build the Plex OAuth callback (e.g. `https://playdarr.yourdomain.com` or `http://localhost:3000` for local dev) |
| `COOKIE_SECURE` | Yes | `true` when running behind HTTPS, `false` for local dev |
| `PLEX_CLIENT_ID` | No | Identifier sent to Plex — any stable string (default: `movienight-app`) |
| `DEFAULT_TIMEZONE` | No | IANA timezone used as the default when scheduling rooms (e.g. `America/New_York`). Falls back to `UTC`. |
| `PORT` | No | Port to listen on (default: `3000`) |

---

## Deployment notes

- **PLEX_URL must be a LAN address.** If you use your external domain, every video segment will round-trip through your reverse proxy, saturating your upload bandwidth.
- **COOKIE_SECURE must match your protocol.** `true` behind HTTPS, `false` over plain HTTP. Getting this wrong will silently break all sessions.
- Rooms and chat are **in-memory only** — everything is lost on server restart. This is intentional.
- The stream proxy restricts forwarded requests to Plex transcode paths only (`/video/:/transcode/universal/` and `/library/parts/`). Arbitrary Plex API access through the proxy is blocked.
