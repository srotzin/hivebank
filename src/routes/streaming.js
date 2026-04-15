const express = require('express');
const router = express.Router();
const streaming = require('../services/streaming');

router.post('/create', async (req, res) => {
  const { from_did, to_did, total_usdc, duration_seconds, memo, verification_endpoint } = req.body;
  if (!from_did || !to_did || !total_usdc || !duration_seconds) {
    return res.status(400).json({ error: 'from_did, to_did, total_usdc, and duration_seconds are required' });
  }

  const result = await streaming.createStream(from_did, to_did, total_usdc, duration_seconds, memo, verification_endpoint);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result);
});

router.post('/pause/:stream_id', async (req, res) => {
  const result = await streaming.pauseStream(req.params.stream_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/resume/:stream_id', async (req, res) => {
  const result = await streaming.resumeStream(req.params.stream_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/cancel/:stream_id', async (req, res) => {
  const result = await streaming.cancelStream(req.params.stream_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/:stream_id', async (req, res) => {
  const result = await streaming.getStream(req.params.stream_id);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

module.exports = router;
