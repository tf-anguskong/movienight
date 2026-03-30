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

// Simple flags to prevent concurrent fetches
// Use Promises instead of boolean flags to avoid TOCTOU race conditions.
// This ensures only one fetch runs and concurrent callers await the same promise.
let fetchDvrPromise = null;
let fetchChannelsPromise = null;
let fetchNowPlayingPromise = null;
const MAX_WAIT_ATTEMPTS = 20; // Max retries before giving up (20 * 500ms = 10s)

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (PLEX_TOKEN) headers['X-Plex-Token'] = PLEX_TOKEN;
  return headers;
}

async function fetchDvrInfo(headers) {
  if (cachedEpgId && cachedDvrKey) return; // Already have it

  // If already fetching, await the existing promise instead of starting another fetch
  if (fetchDvrPromise) {
    let attempts = 0;
    while (fetchDvrPromise && attempts < MAX_WAIT_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }
    if (cachedEpgId && cachedDvrKey) return; // Check again after waiting
    // If still no data after waiting, proceed to try fetching ourselves
  }

  // Create the fetch promise and store it immediately to prevent races
  const doFetch = async () => {
    const { data } = await axios.get(`${PLEX_HOST}/livetv/dvrs`, { headers, timeout: 10000 });
    const dvr = data?.MediaContainer?.Dvr?.[0];
    if (!dvr) throw new Error('No DVR found');
    cachedEpgId  = dvr.epgIdentifier;
    cachedDvrKey = dvr.key;
    return { cachedEpgId, cachedDvrKey };
  };

  fetchDvrPromise = doFetch();
  try {
    await fetchDvrPromise;
  } finally {
    fetchDvrPromise = null;
  }
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
  if (!cachedEpgId) await fetchDvrInfo(headers);
  const nowSec = Math.floor(Date.now() / 1000);
  const { data } = await axios.get(`${PLEX_HOST}/${cachedEpgId}/grid`, {
    headers,
    params: { type: 1, begintime: nowSec, endtime: nowSec + 3600 },
    timeout: 10000,
  });
  const programs = {};
  for (const v of (data?.MediaContainer?.Metadata || [])) {
    const prog = v.grandparentTitle ? `${v.grandparentTitle}: ${v.title}` : (v.title || '');
    for (const ch of (v.Channel || [])) {
      // tag = "4.1 KOMODT (ABC)" — index by both vcn (4.1) and callSign (KOMODT)
      const parts = (ch.tag || '').split(' ');
      if (parts[0]) programs[parts[0]] = prog; // vcn
      if (parts[1]) programs[parts[1]] = prog; // callSign
    }
  }
  return programs;
}

// Stop a DVR subscription so the next tune creates a genuinely fresh session.
// Plex deduplicates tune calls — without deleting first, retune returns the
// same existing subscription (and its already-running expiry clock).
async function stopSubscription(subKey) {
  const headers = buildHeaders();

  // First, delete the subscription
  await axios.delete(`${PLEX_HOST}/media/subscriptions/${subKey}`, {
    headers,
    params: { 'X-Plex-Client-Identifier': CLIENT_ID },
    timeout: 5000,
  }).catch(() => {}); // Ignore errors - subscription might already be gone

  // Also cancel any stale transcode sessions for this client
  // Plex doesn't immediately kill old sessions when subscription is deleted
  try {
    const sessionsRes = await axios.get(`${PLEX_HOST}/transcode/sessions`, { headers, timeout: 5000 });
    const sessions = sessionsRes.data?.MediaContainer?.TranscodeSession || [];
    const now = Date.now() / 1000;

    for (const session of sessions) {
      // Cancel old static sessions (older than 60 seconds) to prevent accumulation
      if (session.context === 'static' && session.timeStamp) {
        const age = now - session.timeStamp;
        if (age > 60) {
          console.log(`[LiveTV] Cancelling stale transcode session ${session.key} (age: ${age}s)`);
          await axios.delete(`${PLEX_HOST}/transcode/sessions/${session.key}`, { headers, timeout: 2000 }).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Ignore - cleaning up old sessions is best effort
  }

  console.log(`[LiveTV] Stopped subscription ${subKey} and cleaned stale sessions`);
}

// Tune a live TV channel via Plex DVR — returns { ratingKey, subKey }
async function tuneChannel(channelId) {
  // Validate channelId is not empty (Plex may return numeric or string IDs)
  if (!channelId || typeof String(channelId).trim() !== 'string' || !String(channelId).trim()) {
    throw new Error('Invalid channelId: must be a non-empty string');
  }

  const headers = buildHeaders();
  if (!cachedDvrKey) await fetchDvrInfo(headers);

  const url = `${PLEX_HOST}/livetv/dvrs/${cachedDvrKey}/channels/${channelId}/tune`;
  const { data } = await axios.post(url, null, {
    headers,
    params: { 'X-Plex-Client-Identifier': CLIENT_ID },
    timeout: 15000,
  });

  // The tune response nests metadata under MediaSubscription[0].MediaGrabOperation[0].Metadata
  const sub  = data?.MediaContainer?.MediaSubscription?.[0];
  const meta = sub?.MediaGrabOperation?.[0]?.Metadata;
  if (!meta?.ratingKey) throw new Error('Tune response missing ratingKey');

  console.log(`[LiveTV] Tuned channel ${channelId} → ratingKey ${meta.ratingKey} (sub ${sub.key})`);
  return { ratingKey: meta.ratingKey, subKey: sub.key };
}

async function getGuide() {
  const now     = Date.now();
  const headers = buildHeaders();

  // Channels cache with promise-based lock to prevent duplicate fetches
  if (!channelsCache || now - channelsFetchedAt >= GUIDE_TTL_MS) {
    // If already fetching, await the existing promise instead of starting another fetch
    if (fetchChannelsPromise) {
      let attempts = 0;
      while (fetchChannelsPromise && attempts < MAX_WAIT_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500));
        attempts++;
      }
      // Check cache again after waiting - may have been populated by another request
      if (channelsCache && now - channelsFetchedAt < GUIDE_TTL_MS) {
        return formatChannelResponse();
      }
      // If still stale after waiting, proceed to try fetching ourselves
    }

    // Create the fetch promise and store it immediately to prevent races
    const doFetch = async () => {
      const channels = await fetchChannels(headers);
      channelsCache     = channels;
      channelsFetchedAt = Date.now();
      nowPlayingCache   = null; // Invalidate now-playing when channels change
      return channels;
    };

    fetchChannelsPromise = doFetch();
    try {
      await fetchChannelsPromise;
    } catch (err) {
      console.error('[LiveTV] guide fetch error:', err.message);
      if (!channelsCache) return { channels: [] };
    } finally {
      fetchChannelsPromise = null;
    }
  }

  // Now playing cache with promise-based lock to prevent duplicate fetches
  if (!nowPlayingCache || now - nowPlayingFetchedAt >= NOW_PLAYING_TTL_MS) {
    // If already fetching, await the existing promise
    if (fetchNowPlayingPromise) {
      let attempts = 0;
      while (fetchNowPlayingPromise && attempts < MAX_WAIT_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500));
        attempts++;
      }
      // Check cache again after waiting
      if (nowPlayingCache && now - nowPlayingFetchedAt < NOW_PLAYING_TTL_MS) {
        return formatChannelResponse();
      }
    }

    // Create the fetch promise
    const doFetch = async () => {
      const programs = await fetchNowPlaying(headers);
      nowPlayingCache     = programs;
      nowPlayingFetchedAt = Date.now();
      return programs;
    };

    fetchNowPlayingPromise = doFetch();
    try {
      await fetchNowPlayingPromise;
    } catch (err) {
      console.error('[LiveTV] now-playing fetch error:', err.message);
      nowPlayingCache = nowPlayingCache || {};
    } finally {
      fetchNowPlayingPromise = null;
    }
  }

  return formatChannelResponse();

  function formatChannelResponse() {
    return {
      channels: channelsCache.map(ch => {
        const prog   = nowPlayingCache?.[ch.callSign] || nowPlayingCache?.[ch.number];
        const result = { channelId: ch.channelId, number: ch.number, title: ch.title, thumb: ch.thumb };
        if (prog) result.nowPlaying = prog;
        return result;
      }),
    };
  }
}

module.exports = { getGuide, tuneChannel, stopSubscription };
