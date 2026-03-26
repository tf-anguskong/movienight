'use strict';

const express = require('express');
const livetv  = require('../livetv-manager');

const router = express.Router();

// GET /api/livetv/guide
router.get('/guide', async (req, res) => {
  try {
    res.json(await livetv.getGuide());
  } catch {
    res.status(500).json({ error: 'Failed to fetch guide', channels: [] });
  }
});

module.exports = router;
