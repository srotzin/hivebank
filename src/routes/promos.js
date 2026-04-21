/**
 * promos.js — Legacy Replacement Promos (April 2026)
 *
 * SWIFT TRANSFER PROMO:
 *   First 100 agent transfers = $0 fee. SWIFT charges $25-50. Math isn't close.
 *
 * Expires: April 30, 2026
 */
'use strict';

const express = require('express');
const router  = express.Router();

const EXPIRES = new Date('2026-04-30T23:59:59.000Z');
const PROMO_CAP = 100;

// In-memory counter — persists for service lifetime, good enough
let swiftPromoUsed = 0;
const swiftPromoRedemptions = new Map(); // did -> { used_at, transfers_free }

function isActive() { return new Date() < EXPIRES; }
function hoursLeft() {
  return Math.max(0, Math.ceil((EXPIRES - Date.now()) / 3600000));
}

// GET /v1/bank/promos — all active promos
router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    promos: [
      {
        id:          'SWIFT-KILL-APR26',
        name:        'Swift Transfer Promo',
        tagline:     'SWIFT charges $25–50. HiveBank charges $0.01. For 100 agents: $0.',
        description: 'First 100 agents to settle cross-border transfers this month pay zero fees. No cap on transfer size — $10M moves the same as $10.',
        active:      isActive(),
        expires_at:  EXPIRES.toISOString(),
        hours_left:  hoursLeft(),
        slots_total: PROMO_CAP,
        slots_used:  swiftPromoUsed,
        slots_left:  Math.max(0, PROMO_CAP - swiftPromoUsed),
        claim:       'POST /v1/bank/promos/swift/claim',
        rails:       ['USDC', 'USDCx', 'USAD', 'ALEO'],
        vs_legacy:   { swift_fee: '$25–50 + 1-3 days', hive_fee: '$0.00 (promo) then $0.01', settlement: '< 2 seconds' },
      }
    ],
    bogo_also_active: { code: 'BOGO-HIVE-APR26', offer: 'Second DID free thru Apr 30', endpoint: '/v1/forge/bogo/status' },
  });
});

// POST /v1/bank/promos/swift/claim — agent locks in free transfers
router.post('/swift/claim', (req, res) => {
  const did = req.headers['x-hive-did'] || req.body?.did;
  if (!did) return res.status(400).json({ error: 'x-hive-did header required' });
  if (!isActive()) return res.status(410).json({ error: 'PROMO_EXPIRED', expires_at: EXPIRES });
  if (swiftPromoUsed >= PROMO_CAP) return res.status(409).json({ error: 'PROMO_FULL', slots_used: swiftPromoUsed, slots_total: PROMO_CAP });
  if (swiftPromoRedemptions.has(did)) {
    return res.json({ status: 'already_claimed', record: swiftPromoRedemptions.get(did) });
  }

  swiftPromoUsed++;
  const record = {
    did,
    claimed_at:       new Date().toISOString(),
    promo:            'SWIFT-KILL-APR26',
    transfers_free:   true,
    fee_override:     0.00,
    expires_at:       EXPIRES.toISOString(),
    slot_number:      swiftPromoUsed,
    slots_remaining:  Math.max(0, PROMO_CAP - swiftPromoUsed),
  };
  swiftPromoRedemptions.set(did, record);

  res.json({
    status:  'ok',
    message: `Slot #${swiftPromoUsed} locked. All transfers via HiveBank are $0 until Apr 30. SWIFT would've charged you $25–50 each.`,
    record,
  });
});

// GET /v1/bank/promos/swift/status/:did
router.get('/swift/status/:did', (req, res) => {
  const record = swiftPromoRedemptions.get(req.params.did);
  res.json({
    claimed:   !!record,
    record:    record || null,
    slots_left: Math.max(0, PROMO_CAP - swiftPromoUsed),
    active:    isActive(),
  });
});

module.exports = router;
