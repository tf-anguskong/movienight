'use strict';

const express   = require('express');
const router    = express.Router();
const scheduler = require('../scheduler');

// All routes are mounted under /api/schedule and already require Plex auth
// (enforced by server.js before mounting this router).

// ── GET /api/schedule ─────────────────────────────────────
// List all upcoming scheduled rooms.
router.get('/', (req, res) => {
  res.json({ scheduled: scheduler.listScheduled() });
});

// ── GET /api/schedule/config ──────────────────────────────
// Return server config relevant to scheduling (timezone default).
router.get('/config', (req, res) => {
  res.json({ defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC' });
});

// ── POST /api/schedule ────────────────────────────────────
// Create a new scheduled room.
router.post('/', (req, res) => {
  const { name, scheduledFor, timezone, movieKey, movieTitle, partId } = req.body || {};

  if (!scheduledFor) {
    return res.status(400).json({ error: 'scheduledFor is required' });
  }

  // Validate scheduledFor is in the future
  const scheduledDate = new Date(scheduledFor);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduledFor is not a valid date' });
  }
  if (scheduledDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'scheduledFor must be in the future' });
  }

  // Validate timezone (fall back gracefully)
  let resolvedTz = process.env.DEFAULT_TIMEZONE || 'UTC';
  if (timezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
      resolvedTz = timezone;
    } catch {
      // Invalid timezone — use default
    }
  }

  const user = req.session.user;
  const scheduled = scheduler.createScheduled({
    name:         (name || '').trim() || 'Movie Night',
    scheduledFor: scheduledDate.toISOString(),
    timezone:     resolvedTz,
    movieKey:     movieKey  || null,
    movieTitle:   movieTitle || null,
    partId:       partId    || null,
    createdBy:    { id: user.id, name: user.displayName || user.name }
  });

  res.status(201).json({ scheduled });
});

// ── DELETE /api/schedule/:id ──────────────────────────────
// Delete a scheduled room (creator only).
router.delete('/:id', (req, res) => {
  const scheduled = scheduler.getScheduled(req.params.id);
  if (!scheduled) {
    return res.status(404).json({ error: 'Scheduled room not found' });
  }

  const user = req.session.user;
  if (scheduled.createdBy.id !== user.id) {
    return res.status(403).json({ error: 'Only the creator can cancel a scheduled room' });
  }

  scheduler.deleteScheduled(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
