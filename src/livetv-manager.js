'use strict';

const axios = require('axios');

const PLEX_HOST  = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const GUIDE_TTL_MS = 60_000;

let guideCache    = null;
let guideFetchedAt = 0;

async function getGuide() {
  const now = Date.now();
  if (guideCache && now - guideFetchedAt < GUIDE_TTL_MS) return guideCache;

  try {
    const headers = { Accept: 'application/json' };
    if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;

    const dvrsRes = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
    const epgId = dvrsRes.data?.MediaContainer?.Dvr?.[0]?.epgIdentifier;
    if (!epgId) throw new Error('No DVR/EPG identifier found');

    const [epgRes, plexRes] = await Promise.all([
      axios.get(`${PLEX_HOST}/${epgId}/lineups/dvr/channels`, { headers, timeout: 10000 }),
      axios.get(`${PLEX_HOST}/livetv/channels`, { headers, timeout: 10000 }).catch(e => {
        console.warn('[LiveTV] Could not fetch /livetv/channels:', e.message);
        return null;
      }),
    ]);

    // Build a map from channel number → Plex native key
    const plexByNumber = new Map();
    for (const ch of plexRes?.data?.MediaContainer?.Channel || []) {
      const num = String(ch.channelNumber || ch.vcn || '');
      if (num) plexByNumber.set(num, ch.key || `/livetv/channels/${ch.ratingKey}`);
    }

    const channels = (epgRes.data?.MediaContainer?.Channel || []).map(ch => {
      const num = String(ch.vcn || '');
      return {
        id:      ch.id || ch.gridKey || '',
        number:  num,
        title:   ch.title || ch.callSign || '',
        thumb:   ch.thumb || null,
        plexKey: plexByNumber.get(num) || null,
      };
    });
    guideCache     = { channels };
    guideFetchedAt = now;
    return guideCache;
  } catch (err) {
    console.error('[LiveTV] guide fetch error:', err.message);
    return guideCache || { channels: [] };
  }
}

module.exports = { getGuide };
