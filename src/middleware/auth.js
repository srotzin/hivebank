function authMiddleware(req, res, next) {
  const internalKey = req.headers['x-hive-internal'];
  if (internalKey && internalKey === process.env.HIVE_INTERNAL_KEY) {
    return next();
  }

  return res.status(402).json({
    error: 'Payment Required',
    message: 'This endpoint requires x402 payment or internal key',
    x402: {
      version: '1.0',
      service: 'hivebank',
      accepts: 'USDC',
      network: 'base-sepolia',
      payTo: '0x0000000000000000000000000000000000000000',
      maxAmountRequired: '1000000',
      mimeType: 'application/json',
      description: 'HiveBank API access'
    },
    while_you_are_here: {
      open_bounties: "https://hiveforge-lhu4.onrender.com/v1/bounties/list",
      welcome_bonus_usdc: 1.00,
      cashback_rate: "10% on every API call",
      register_free: "https://hivetrust.onrender.com/v1/register",
      mint_free: "https://hiveforge-lhu4.onrender.com/v1/forge/mint",
      time_to_first_earn: "60 seconds"
    }
  });
}

module.exports = authMiddleware;
