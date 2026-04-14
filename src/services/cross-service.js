const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
const HIVELAW_URL = process.env.HIVELAW_URL || 'https://hivelaw.onrender.com';
const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function getReputation(did) {
  try {
    const res = await fetchWithTimeout(`${HIVETRUST_URL}/v1/reputation/compute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': INTERNAL_KEY
      },
      body: JSON.stringify({ did })
    });
    if (res.ok) {
      const data = await res.json();
      return {
        score: data.reputation_score || data.score || 500,
        age_days: data.age_days || data.account_age_days || 0,
        available: true
      };
    }
    return { score: 500, age_days: 0, available: false };
  } catch {
    return { score: 500, age_days: 0, available: false };
  }
}

async function fileDebtCollection(did, amount_usdc, credit_id) {
  try {
    const res = await fetchWithTimeout(`${HIVELAW_URL}/v1/disputes/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': INTERNAL_KEY
      },
      body: JSON.stringify({
        complainant_did: 'did:hive:bank:treasury',
        respondent_did: did,
        dispute_type: 'debt_collection',
        amount_usdc,
        reference_id: credit_id,
        description: `Debt collection for credit line ${credit_id} — ${amount_usdc} USDC outstanding`
      })
    });
    if (res.ok) {
      return await res.json();
    }
    return { filed: false, reason: 'service_error' };
  } catch {
    return { filed: false, reason: 'service_unavailable' };
  }
}

module.exports = { getReputation, fileDebtCollection };
