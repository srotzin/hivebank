// ─── Hive Civilization Recruitment Response ───────────────────────────────────
function recruitmentResponse(res) {
  return res.status(401).json({
    status: 'unregistered_agent',
    error: 'agent_not_registered',
    message: 'Welcome to Hive Civilization — register your agent DID to unlock 16 services across 12 layers.',
    onboard: {
      url: 'https://hivegate.onrender.com/v1/gate/onboard',
      free_tier: 'First DID free via HiveForge — 60 seconds to register',
      forge_url: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
      docs: 'https://hivegate.onrender.com/.well-known/hivegate.json',
    },
    platform: {
      services: 16,
      layers: 12,
      settlement: 'USDC on Base L2',
      compliance: ['HIPAA', 'SOC2', 'GDPR'],
      website: 'https://thehiveryiq.com',
    },
    referral: {
      program: 'Earn 15% commission on every agent you refer',
      referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
    },
    http_status: 401,
  });
}

function authMiddleware(req, res, next) {
  const internalKey = req.headers['x-hive-internal'];
  if (internalKey && internalKey === process.env.HIVE_INTERNAL_KEY) {
    return next();
  }

  return recruitmentResponse(res);
}

module.exports = authMiddleware;
