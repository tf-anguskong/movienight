'use strict';

const express  = require('express');
const livetv   = require('../livetv-manager');

const router = express.Router();

// GET /api/livetv/guide
router.get('/guide', async (req, res) => {
  try {
    res.json(await livetv.getGuide());
  } catch {
    res.status(500).json({ error: 'Failed to fetch guide', channels: [] });
  }
});

// POST /api/livetv/channel — called internally from sync.js
router.post('/channel', (req, res) => {
  const { channel } = req.body || {};
  if (!channel) return res.status(400).json({ error: 'channel required' });
  livetv.switchChannel(String(channel));
  res.json({ channel });
});

module.exports = router;
