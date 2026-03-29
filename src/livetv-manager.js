'use strict';

const axios = require('axios');

const PLEX_HOST        = process.env.LIVETV_PLEX_HOST || process.env.PLEX_URL || '';
const PLEX_TOKEN       = process.env.LIVETV_PLEX_TOKEN || process.env.PLEX_TOKEN || '';
const CLIENT_ID        = 'movienight-app';
const GUIDE_TTL_MS       = 300_000; // 5 min — channel lineup is stable
const NOW_PLAYING_TTL_MS = 120_000; // 2 min — refresh program info frequently

let channelsCache     = null;
let channelsFetchedAt = 0;
let cachedEpgId       = null;
let cachedDvrKey      = null;
let nowPlayingCache     = null;
let nowPlayingFetchedAt = 0;

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;
  return headers;
}

async function fetchDvrInfo(headers) {
  const { data } = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
  const dvr = data?.MediaContainer?.Dvr?.[0];
  if (!dvr) throw new Error('No DVR found');
  cachedEpgId  = dvr.epgIdentifier;
  cachedDvrKey = dvr.key;
}

async function fetchChannels(headers) {
  if (!cachedEpgId || !cachedDvrKey) await fetchDvrInfo(headers);
  const { data } = await axios.get(`${PLEX_HOST}/${cachedEpgId}/lineups/dvr/channels`, { headers, timeout: 10000 });
  return (data?.MediaContainer?.Channel || []).map(ch => ({
    channelId: String(ch.id || ''),
    number:    ch.vcn || '',
    title:     ch.title || ch.callSign || '',
    thumb:     ch.thumb || null,
    callSign:  ch.callSign || ch.vcn || '',
  }));
}

async function fetchNowPlaying(headers) {
  const nowSec = Math.floor(Date.now() / 1000);
  const { data } = await axios.get(`${PLEX_HOST}/livetv/grid`, {
    headers,
    params: { type: 1, begintime: nowSec, endtime: nowSec + 1 },
    timeout: 10000,
  });
  const programs = {};
  for (const v of (data?.MediaContainer?.Video || [])) {
    const key = v.channelCallSign || v.channelID;
    if (!key) continue;
    programs[key] = v.grandparentTitle ? `${v.grandparentTitle}: ${v.title}` : (v.title || '');
  }
  return programs;
}

// Tune a live TV channel via Plex DVR — returns the session UUID
async function tuneChannel(channelId) {
  const headers = buildHeaders();
  if (!cachedDvrKey) await fetchDvrInfo(headers);

  const url = `${PLEX_HOST}/livetv/dvrs/${cachedDvrKey}/channels/${channelId}/tune`;
  const { data } = await axios.post(url, null, {
    headers,
    params: { 'X-Plex-Client-Identifier': CLIENT_ID },
    timeout: 15000,
  });

  // The tune response nests metadata under MediaSubscription[0].MediaGrabOperation[0].Metadata
  const meta = data?.MediaContainer?.MediaSubscription?.[0]?.MediaGrabOperation?.[0]?.Metadata;
  if (!meta?.ratingKey) throw new Error('Tune response missing ratingKey');

  // ratingKey is numeric (e.g. "7159") — used with /library/metadata/{ratingKey} for transcoding
  console.log(`[LiveTV] Tuned channel ${channelId} → ratingKey ${meta.ratingKey}`);
  return meta.ratingKey;
}

async function getGuide() {
  const now     = Date.now();
  const headers = buildHeaders();

  if (!channelsCache || now - channelsFetchedAt >= GUIDE_TTL_MS) {
    try {
      channelsCache     = await fetchChannels(headers);
      channelsFetchedAt = now;
      nowPlayingCache   = null;
    } catch (err) {
      console.error('[LiveTV] guide fetch error:', err.message);
      if (!channelsCache) return { channels: [] };
    }
  }

  if (!nowPlayingCache || now - nowPlayingFetchedAt >= NOW_PLAYING_TTL_MS) {
    try {
      nowPlayingCache     = await fetchNowPlaying(headers);
      nowPlayingFetchedAt = now;
    } catch (err) {
      console.error('[LiveTV] now-playing fetch error:', err.message);
      nowPlayingCache = nowPlayingCache || {};
    }
  }

  return {
    channels: channelsCache.map(ch => {
      const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
      const result = { channelId: ch.channelId, number: ch.number, title: ch.title, thumb: ch.thumb };
      if (prog) result.nowPlaying = prog;
      return result;
    }),
  };
}

module.exports = { getGuide, tuneChannel };
