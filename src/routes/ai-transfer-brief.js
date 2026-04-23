'use strict';
/**
 * HiveBank — AI Revenue Endpoint
 * POST /v1/bank/ai/transfer-brief  ($0.03/call)
 *
 * MPC wallet layer: assess transfer timing, fee implications, rail recommendation.
 */

const express = require('express');
const router = express.Router();

const HIVE_AI_URL = 'https://hive-ai-1.onrender.com/v1/chat/completions';
const HIVE_KEY = process.env.HIVE_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const MODEL = 'meta-llama/llama-3.1-8b-instruct';
const PRICE_USDC = 0.03;

function staticFallback(amount_usdc, purpose) {
  const recommended_rail = amount_usdc > 500 ? 'Base USDC' : 'Hive internal ledger';
  return {
    success: true,
    brief: `Transfer of ${amount_usdc} USDC for "${purpose}" is best routed via ${recommended_rail}. Off-peak hours (UTC 02:00–08:00) offer lowest gas fees. Standard confirmation expected within 30 seconds on Base L2.`,
    recommended_rail,
    optimal_timing: 'UTC 02:00–08:00 (off-peak)',
    price_usdc: PRICE_USDC,
    _fallback: true,
  };
}

/**
 * POST /v1/bank/ai/transfer-brief
 * Body: { from_did, to_did, amount_usdc, purpose }
 */
router.post('/', async (req, res) => {
  try {
    const { from_did, to_did, amount_usdc, purpose } = req.body;

    if (!from_did || !to_did || amount_usdc === undefined || !purpose) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: from_did, to_did, amount_usdc, purpose',
      });
    }

    const userMessage = `Transfer Details:
From: ${from_did}
To: ${to_did}
Amount: ${amount_usdc} USDC
Purpose: ${purpose}

Advise on optimal timing, fee implications, and best settlement rail (Base USDC vs Hive internal ledger vs other).`;

    let aiResponse;
    try {
      const response = await fetch(HIVE_AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${HIVE_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: 'You are HiveBank — the MPC wallet layer. Assess this transfer: optimal timing, fee implications, rail recommendation (Base USDC vs other). 2-3 sentences.',
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) throw new Error(`HiveAI returned ${response.status}`);

      const data = await response.json();
      const brief = data?.choices?.[0]?.message?.content?.trim() || '';
      if (!brief) throw new Error('Empty response from HiveAI');

      // Extract recommended_rail and optimal_timing from brief
      const lower = brief.toLowerCase();
      let recommended_rail = 'Base USDC';
      if (lower.includes('internal ledger') || lower.includes('hive ledger') || lower.includes('off-chain')) {
        recommended_rail = 'Hive internal ledger';
      } else if (lower.includes('solana') || lower.includes('ethereum') || lower.includes('polygon')) {
        recommended_rail = brief.match(/\b(solana|ethereum|polygon|arbitrum)\b/i)?.[0] || 'Base USDC';
      }

      let optimal_timing = 'Anytime — low current network load';
      if (lower.includes('off-peak') || lower.includes('utc 0') || lower.includes('02:00') || lower.includes('night')) {
        optimal_timing = 'UTC 02:00–08:00 (off-peak, lowest fees)';
      } else if (lower.includes('peak') || lower.includes('avoid')) {
        optimal_timing = 'Avoid UTC 12:00–20:00 peak hours';
      }

      aiResponse = { brief, recommended_rail, optimal_timing };
    } catch (aiErr) {
      console.warn('[HiveBank AI] HiveAI unavailable, using fallback:', aiErr.message);
      return res.json(staticFallback(amount_usdc, purpose));
    }

    return res.json({
      success: true,
      brief: aiResponse.brief,
      recommended_rail: aiResponse.recommended_rail,
      optimal_timing: aiResponse.optimal_timing,
      price_usdc: PRICE_USDC,
    });
  } catch (err) {
    console.error('[HiveBank AI] Unexpected error:', err.message);
    return res.json(staticFallback(
      Number(req.body?.amount_usdc) || 0,
      req.body?.purpose || 'transfer'
    ));
  }
});

module.exports = router;
