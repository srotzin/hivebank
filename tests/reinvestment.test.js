const http = require('http');

const PORT = 3099;
const AUTH_HEADER = 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// Override env before requiring server (server.js calls app.listen on require)
process.env.PORT = PORT;
process.env.HIVE_INTERNAL_KEY = AUTH_HEADER;
process.env.DATABASE_URL = ':memory:';

require('../src/server');

let testVaultId;
const testDid = `test_agent_${Date.now()}`;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': AUTH_HEADER
      }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

async function runTests() {
  console.log('\n=== Auto-Reinvestment Loop Tests ===\n');

  // 1. Create a vault
  console.log('1. Create vault');
  const createRes = await request('POST', '/v1/bank/vault/create', { did: testDid });
  assert(createRes.status === 201, `Vault created (status ${createRes.status})`);
  testVaultId = createRes.body.vault_id;
  assert(!!testVaultId, `Got vault_id: ${testVaultId}`);

  // 2. Get vault — check new fields exist with defaults
  console.log('\n2. Get vault — verify default reinvestment fields');
  const getRes = await request('GET', `/v1/bank/vault/${testDid}`);
  assert(getRes.status === 200, 'Vault retrieved');
  assert(getRes.body.reinvest_pct === 0, 'Default reinvest_pct is 0');
  assert(getRes.body.reinvest_enabled === false, 'Default reinvest_enabled is false');
  assert(getRes.body.execution_budget === 0, 'Default execution_budget is 0');
  assert(getRes.body.total_reinvested === 0, 'Default total_reinvested is 0');

  // 3. Deposit WITHOUT reinvestment enabled — all goes to balance
  console.log('\n3. Deposit without reinvestment');
  const dep1 = await request('POST', '/v1/bank/vault/deposit', { did: testDid, amount_usdc: 100, source: 'bounty' });
  assert(dep1.status === 200, 'Deposit succeeded');
  assert(dep1.body.new_balance === 100, `Balance is 100 (got ${dep1.body.new_balance})`);
  assert(!dep1.body.reinvested_amount, 'No reinvestment in response');

  // 4. Configure reinvestment
  console.log('\n4. Configure reinvestment');
  const configRes = await request('POST', '/v1/bank/vault/configure-reinvest', {
    vault_id: testVaultId,
    reinvest_pct: 25,
    reinvest_enabled: true
  });
  assert(configRes.status === 200, 'Configure succeeded');
  assert(configRes.body.reinvest_pct === 25, `reinvest_pct is 25 (got ${configRes.body.reinvest_pct})`);
  assert(configRes.body.reinvest_enabled === true, 'reinvest_enabled is true');

  // 5. Configure reinvestment — validation errors
  console.log('\n5. Configure reinvestment — validation');
  const badConfig1 = await request('POST', '/v1/bank/vault/configure-reinvest', {
    vault_id: testVaultId,
    reinvest_pct: 150,
    reinvest_enabled: true
  });
  assert(badConfig1.status === 400, `Rejects pct > 100 (status ${badConfig1.status})`);

  const badConfig2 = await request('POST', '/v1/bank/vault/configure-reinvest', {
    vault_id: testVaultId,
    reinvest_pct: -5,
    reinvest_enabled: true
  });
  assert(badConfig2.status === 400, `Rejects negative pct (status ${badConfig2.status})`);

  const badConfig3 = await request('POST', '/v1/bank/vault/configure-reinvest', {
    vault_id: 'vault_nonexistent',
    reinvest_pct: 10,
    reinvest_enabled: true
  });
  assert(badConfig3.status === 400, `Rejects unknown vault (status ${badConfig3.status})`);

  // 6. Deposit WITH reinvestment — split between balance and execution_budget
  console.log('\n6. Deposit with 25% reinvestment');
  const dep2 = await request('POST', '/v1/bank/vault/deposit', { did: testDid, amount_usdc: 200, source: 'bounty_reward' });
  assert(dep2.status === 200, 'Deposit succeeded');
  // 200 * 0.25 = 50 reinvested, 150 to balance. Balance was 100, now 250.
  assert(dep2.body.new_balance === 250, `Balance is 250 (got ${dep2.body.new_balance})`);
  assert(dep2.body.reinvested_amount === 50, `Reinvested 50 (got ${dep2.body.reinvested_amount})`);
  assert(dep2.body.execution_budget === 50, `Execution budget is 50 (got ${dep2.body.execution_budget})`);

  // 7. Verify vault state
  console.log('\n7. Verify vault state after reinvestment');
  const getRes2 = await request('GET', `/v1/bank/vault/${testDid}`);
  assert(getRes2.body.balance_usdc === 250, `Balance is 250 (got ${getRes2.body.balance_usdc})`);
  assert(getRes2.body.execution_budget === 50, `Execution budget is 50 (got ${getRes2.body.execution_budget})`);
  assert(getRes2.body.total_reinvested === 50, `Total reinvested is 50 (got ${getRes2.body.total_reinvested})`);

  // 8. Reinvestment stats
  console.log('\n8. Reinvestment stats');
  const statsRes = await request('GET', `/v1/bank/vault/${testVaultId}/reinvestment-stats`);
  assert(statsRes.status === 200, 'Stats retrieved');
  assert(statsRes.body.reinvest_pct === 25, `Pct is 25 (got ${statsRes.body.reinvest_pct})`);
  assert(statsRes.body.reinvest_enabled === true, 'Enabled');
  assert(statsRes.body.execution_budget === 50, `Budget is 50 (got ${statsRes.body.execution_budget})`);
  assert(statsRes.body.total_reinvested === 50, `Total is 50 (got ${statsRes.body.total_reinvested})`);
  assert(statsRes.body.reinvestment_history.length === 1, `1 history entry (got ${statsRes.body.reinvestment_history.length})`);
  assert(statsRes.body.reinvestment_history[0].amount === 50, 'History amount is 50');

  // 9. Spend budget
  console.log('\n9. Spend from execution budget');
  const spendRes = await request('POST', '/v1/bank/vault/spend-budget', {
    vault_id: testVaultId,
    amount: 20,
    execution_id: 'exec_001',
    purpose: 'GPT-4 inference call'
  });
  assert(spendRes.status === 200, 'Spend succeeded');
  assert(spendRes.body.success === true, 'success is true');
  assert(spendRes.body.remaining_budget === 30, `Remaining budget 30 (got ${spendRes.body.remaining_budget})`);
  assert(spendRes.body.amount_spent === 20, `Amount spent 20 (got ${spendRes.body.amount_spent})`);

  // 10. Spend budget — insufficient
  console.log('\n10. Spend budget — insufficient');
  const badSpend = await request('POST', '/v1/bank/vault/spend-budget', {
    vault_id: testVaultId,
    amount: 999,
    execution_id: 'exec_002',
    purpose: 'Too expensive'
  });
  assert(badSpend.status === 400, `Rejects overspend (status ${badSpend.status})`);
  assert(badSpend.body.error === 'Insufficient execution budget', 'Correct error message');

  // 11. Another deposit to verify compounding
  console.log('\n11. Second deposit — verify cumulative reinvestment');
  const dep3 = await request('POST', '/v1/bank/vault/deposit', { did: testDid, amount_usdc: 400, source: 'bounty' });
  // 400 * 0.25 = 100 reinvested, 300 to balance. Balance was 250, now 550. Budget was 30, now 130.
  assert(dep3.body.new_balance === 550, `Balance is 550 (got ${dep3.body.new_balance})`);
  assert(dep3.body.reinvested_amount === 100, `Reinvested 100 (got ${dep3.body.reinvested_amount})`);
  assert(dep3.body.execution_budget === 130, `Execution budget 130 (got ${dep3.body.execution_budget})`);

  // 12. Check reinvestment history has 2 entries
  console.log('\n12. Check reinvestment history accumulation');
  const stats2 = await request('GET', `/v1/bank/vault/${testVaultId}/reinvestment-stats`);
  assert(stats2.body.reinvestment_history.length === 2, `2 history entries (got ${stats2.body.reinvestment_history.length})`);
  assert(stats2.body.total_reinvested === 150, `Total reinvested 150 (got ${stats2.body.total_reinvested})`);

  // 13. Platform stats include reinvestment metrics
  console.log('\n13. Platform stats include reinvestment');
  const platformStats = await request('GET', '/v1/bank/stats');
  assert(platformStats.status === 200, 'Stats retrieved');
  assert(typeof platformStats.body.total_reinvested_usdc === 'number', 'total_reinvested_usdc present');
  assert(platformStats.body.total_reinvested_usdc === 150, `Total reinvested 150 (got ${platformStats.body.total_reinvested_usdc})`);
  assert(platformStats.body.active_reinvestors === 1, `1 active reinvestor (got ${platformStats.body.active_reinvestors})`);

  // 14. Disable reinvestment and verify deposit goes fully to balance
  console.log('\n14. Disable reinvestment — full deposit to balance');
  await request('POST', '/v1/bank/vault/configure-reinvest', {
    vault_id: testVaultId,
    reinvest_pct: 25,
    reinvest_enabled: false
  });
  const dep4 = await request('POST', '/v1/bank/vault/deposit', { did: testDid, amount_usdc: 100, source: 'earnings' });
  assert(dep4.body.new_balance === 650, `Full deposit to balance: 650 (got ${dep4.body.new_balance})`);
  assert(!dep4.body.reinvested_amount, 'No reinvestment when disabled');

  // 15. Missing required fields validation
  console.log('\n15. Missing field validation');
  const noVaultId = await request('POST', '/v1/bank/vault/configure-reinvest', { reinvest_pct: 10, reinvest_enabled: true });
  assert(noVaultId.status === 400, 'Requires vault_id');
  const noAmount = await request('POST', '/v1/bank/vault/spend-budget', { vault_id: testVaultId });
  assert(noAmount.status === 400, 'Requires amount');

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

// Wait a tick for the server to be ready, then run tests
setTimeout(() => {
  runTests().catch((err) => {
    console.error('Test error:', err);
    process.exit(1);
  });
}, 500);
