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
    }
  });
}

module.exports = authMiddleware;
