'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// JavaScript timers are 32-bit signed integers — delays > this overflow.
// We re-arm the timer in chunks when needed.
const MAX_SAFE_TIMEOUT = 2147483647; // ~24.8 days in ms

const dataPath = process.env.DATA_PATH || '/data';
const FILE     = path.join(dataPath, 'scheduled.json');

// In-memory store: id -> scheduled room object
const store = new Map();

let _openRoomCallback = null;

// ── Persistence ───────────────────────────────────────────

function persist() {
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(Array.from(store.values()), null, 2), 'utf8');
  } catch (err) {
    console.error('[Scheduler] Failed to write scheduled.json:', err.message);
  }
}

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, 'utf8');
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (item && item.id) store.set(item.id, item);
    }
    console.log(`[Scheduler] Loaded ${store.size} scheduled room(s) from disk`);
  } catch (err) {
    console.error('[Scheduler] Failed to read scheduled.json:', err.message);
  }
}

// ── Timer management ──────────────────────────────────────

function armTimer(scheduled) {
  const delay = new Date(scheduled.scheduledFor).getTime() - Date.now();

  if (delay <= 0) {
    // Already past — fire immediately after the current call stack unwinds
    setImmediate(() => fire(scheduled.id));
    return;
  }

  if (delay > MAX_SAFE_TIMEOUT) {
    // Re-arm after MAX_SAFE_TIMEOUT ms and try again
    scheduled._timer = setTimeout(() => armTimer(scheduled), MAX_SAFE_TIMEOUT);
    return;
  }

  scheduled._timer = setTimeout(() => fire(scheduled.id), delay);
}

function fire(id) {
  const scheduled = store.get(id);
  if (!scheduled) return; // already removed

  // Remove from store before calling callback
  store.delete(id);
  persist();

  console.log(`[Scheduler] Firing scheduled room "${scheduled.name}" (id=${id})`);

  if (_openRoomCallback) {
    try {
      _openRoomCallback(scheduled);
    } catch (err) {
      console.error('[Scheduler] openRoomCallback threw:', err.message);
    }
  }
}

// ── Public API ────────────────────────────────────────────

/**
 * Initialise the scheduler.
 * Must be called once at startup, after setupSync.
 * @param {function} openRoomCallback - called with (scheduledRoom) when a room fires
 */
function init(openRoomCallback) {
  _openRoomCallback = openRoomCallback;
  load();
  // Arm timers for all loaded entries
  for (const scheduled of store.values()) {
    armTimer(scheduled);
  }
}

/**
 * Create a new scheduled room.
 * @param {{ name, scheduledFor, timezone, createdBy: {id, name} }} fields
 * @returns {object} the new scheduled room record
 */
function createScheduled(fields) {
  const { name, scheduledFor, timezone, createdBy } = fields;
  const scheduled = {
    id:           uuidv4(),
    inviteToken:  uuidv4(),
    name:         (name || 'Movie Night').slice(0, 60),
    scheduledFor, // ISO string
    timezone:     timezone || process.env.DEFAULT_TIMEZONE || 'UTC',
    createdBy,    // { id, name }
    createdAt:    new Date().toISOString()
  };
  store.set(scheduled.id, scheduled);
  persist();
  armTimer(scheduled);
  console.log(`[Scheduler] Scheduled room "${scheduled.name}" for ${scheduled.scheduledFor} (id=${scheduled.id})`);
  return scheduled;
}

/**
 * Delete a scheduled room by id. Returns true if found and deleted.
 */
function deleteScheduled(id) {
  const scheduled = store.get(id);
  if (!scheduled) return false;
  if (scheduled._timer) clearTimeout(scheduled._timer);
  store.delete(id);
  persist();
  console.log(`[Scheduler] Deleted scheduled room "${scheduled.name}" (id=${id})`);
  return true;
}

/**
 * Get a scheduled room by id.
 */
function getScheduled(id) {
  return store.get(id) || null;
}

/**
 * Look up a scheduled room by invite token.
 */
function getByInviteToken(token) {
  for (const s of store.values()) {
    if (s.inviteToken === token) return s;
  }
  return null;
}

/**
 * List all scheduled rooms (sorted by scheduledFor ascending).
 */
function listScheduled() {
  return Array.from(store.values())
    .sort((a, b) => new Date(a.scheduledFor) - new Date(b.scheduledFor));
}

module.exports = { init, createScheduled, deleteScheduled, getScheduled, getByInviteToken, listScheduled };
