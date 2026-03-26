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

    // Build channelKey → lineupIdentifier map from DVR ChannelMapping (already fetched)
    const keyToLineup = new Map();
    for (const mapping of dvrsRes.data?.MediaContainer?.Dvr?.[0]?.Device?.[0]?.ChannelMapping || []) {
      if (mapping.channelKey && mapping.lineupIdentifier) {
        keyToLineup.set(mapping.channelKey, mapping.lineupIdentifier);
      }
    }

    const { data } = await axios.get(`${PLEX_HOST}/${epgId}/lineups/dvr/channels`, { headers, timeout: 10000 });
    const channels = (data?.MediaContainer?.Channel || []).map(ch => {
      const id = ch.id || ch.gridKey || '';
      const lineup = keyToLineup.get(id);
      return {
        id,
        number:  ch.vcn || '',
        title:   ch.title || ch.callSign || '',
        thumb:   ch.thumb || null,
        plexKey: lineup ? `/livetv/timelines/${lineup}` : null,
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
