const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { getRoomByInviteToken } = require('../sync');
const { encryptToken, decryptToken } = require('../tokenCrypto');

const CLIENT_ID   = process.env.PLEX_CLIENT_ID || 'movienight-app';
const PLEX_PRODUCT = 'Movie Night';
const PLEX_API    = 'https://plex.tv/api/v2';

// Cache the server's machine identifier so we only fetch it once
let cachedMachineId = null;
async function getServerMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const res = await axios.get(`${process.env.PLEX_URL}/identity`, {
    headers: { Accept: 'application/json' },
    timeout: 5000
  });
  cachedMachineId = res.data?.MediaContainer?.machineIdentifier;
  return cachedMachineId;
}

const plexHeaders = {
  'Accept': 'application/json',
  'X-Plex-Client-Identifier': CLIENT_ID,
  'X-Plex-Product': PLEX_PRODUCT,
  'X-Plex-Version': '1.0.0'
};

// Step 1: Redirect to Plex OAuth
router.get('/plex', async (req, res) => {
  try {
    const pinRes = await axios.post(`${PLEX_API}/pins`, null, {
      headers: plexHeaders,
      params: { strong: true }
    });
    const { id, code } = pinRes.data;

    const callbackUrl = encodeURIComponent(`${process.env.APP_URL}/auth/plex/callback/${id}`);
    res.redirect(
      `https://app.plex.tv/auth#?clientID=${encodeURIComponent(CLIENT_ID)}` +
      `&code=${code}&forwardUrl=${callbackUrl}` +
      `&context[device][product]=${encodeURIComponent(PLEX_PRODUCT)}`
    );
  } catch (err) {
    console.error('[Auth] Plex PIN error:', err.message);
    res.redirect('/login?error=plex');
  }
});

// Step 2: Plex OAuth callback
router.get('/plex/callback/:pinId', async (req, res) => {
  const pinId = req.params.pinId;
  try {
    const { authToken } = (await axios.get(`${PLEX_API}/pins/${pinId}`, { headers: plexHeaders })).data;
    console.log(`[Auth] authToken present: ${!!authToken}`);
    if (!authToken) return res.redirect('/login?error=no_token');

    try {
      const [machineId, resourcesRes] = await Promise.all([
        getServerMachineId(),
        axios.get(`${PLEX_API}/resources`, {
          headers: { ...plexHeaders, 'X-Plex-Token': authToken },
          params: { includeHttps: 1 },
          timeout: 8000
        })
      ]);
      const hasAccess = resourcesRes.data.some(r => r.clientIdentifier === machineId);
      if (!hasAccess) {
        console.error(`[Auth] User token has no access to server ${machineId}`);
        return res.redirect('/login?error=access');
      }
    } catch (e) {
      console.error('[Auth] Server access check failed:', e.code, e.message, e.response?.status);
      return res.redirect('/login?error=access');
    }

    const plexUser = (await axios.get(`${PLEX_API}/user`, {
      headers: { ...plexHeaders, 'X-Plex-Token': authToken }
    })).data;

    req.session.regenerate(regenErr => {
      if (regenErr) {
        console.error('[Auth] Session regenerate error:', regenErr);
        return res.redirect('/login?error=auth');
      }
      req.session.user = {
        id: String(plexUser.id),
        name: plexUser.friendlyName || plexUser.username || plexUser.email,
        email: plexUser.email,
        picture: plexUser.thumb,
        plexToken: encryptToken(authToken),
        isGuest: false
      };
      req.session.save(err => {
        if (err) console.error('[Auth] Session save error:', err);
        res.redirect('/');
      });
    });
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect('/login?error=auth');
  }
});

// Guest join via invite link — called from /join/:inviteToken page
router.post('/guest-join', express.json(), (req, res) => {
  const { name, inviteToken, roomId } = req.body || {};
  const trimmedName = (name || '').trim().slice(0, 40);
  if (!trimmedName) return res.status(400).json({ error: 'Name is required' });
  if (!inviteToken || !roomId) return res.status(400).json({ error: 'Invalid invite' });

  // Validate that the invite token actually maps to the claimed roomId
  const room = getRoomByInviteToken(inviteToken);
  if (!room || room.id !== roomId) {
    return res.status(403).json({ error: 'Invalid or expired invite' });
  }

  req.session.user = {
    id: `guest-${uuidv4()}`,
    name: trimmedName,
    picture: null,
    isGuest: true,
    inviteToken  // stored so socket join-room can validate it
  };
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session error' });
    res.json({ ok: true, roomId });
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
