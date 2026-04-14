const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function createStream(from_did, to_did, total_usdc, duration_seconds, memo, verification_endpoint) {
  if (total_usdc <= 0) return { error: 'Total USDC must be positive' };
  if (duration_seconds <= 0) return { error: 'Duration must be positive' };

  const from_vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(from_did);
  if (!from_vault) return { error: 'Sender vault not found' };
  if (from_vault.balance_usdc < total_usdc) return { error: 'Insufficient balance to fund stream' };

  const stream_id = `stream_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const rate_per_second_usdc = total_usdc / duration_seconds;
  const now = new Date().toISOString();
  const ends_at = new Date(Date.now() + duration_seconds * 1000).toISOString();

  db.prepare(`
    INSERT INTO revenue_streams (stream_id, from_did, to_did, total_usdc, rate_per_second_usdc,
      streamed_usdc, platform_fee_usdc, duration_seconds, status, verification_endpoint, memo, started_at)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'active', ?, ?, ?)
  `).run(stream_id, from_did, to_did, total_usdc, rate_per_second_usdc, duration_seconds, verification_endpoint || null, memo || null, now);

  return {
    stream_id,
    from_did,
    to_did,
    rate_per_second_usdc: Math.round(rate_per_second_usdc * 1e8) / 1e8,
    total_usdc,
    started_at: now,
    ends_at
  };
}

function pauseStream(stream_id) {
  const stream = db.prepare('SELECT * FROM revenue_streams WHERE stream_id = ?').get(stream_id);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status !== 'active') return { error: `Cannot pause stream in '${stream.status}' status` };

  const now = new Date().toISOString();
  db.prepare("UPDATE revenue_streams SET status = 'paused', paused_at = ? WHERE stream_id = ?")
    .run(now, stream_id);

  return {
    stream_id,
    status: 'paused',
    streamed_so_far_usdc: stream.streamed_usdc,
    paused_at: now
  };
}

function resumeStream(stream_id) {
  const stream = db.prepare('SELECT * FROM revenue_streams WHERE stream_id = ?').get(stream_id);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status !== 'paused') return { error: `Cannot resume stream in '${stream.status}' status` };

  const now = new Date().toISOString();
  db.prepare("UPDATE revenue_streams SET status = 'active', paused_at = NULL WHERE stream_id = ?")
    .run(stream_id);

  return {
    stream_id,
    status: 'active',
    resumed_at: now
  };
}

function cancelStream(stream_id) {
  const stream = db.prepare('SELECT * FROM revenue_streams WHERE stream_id = ?').get(stream_id);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status === 'cancelled' || stream.status === 'completed') {
    return { error: `Stream already ${stream.status}` };
  }

  const now = new Date().toISOString();
  const refund = stream.total_usdc - stream.streamed_usdc;
  const platform_fee = stream.platform_fee_usdc;

  db.prepare("UPDATE revenue_streams SET status = 'cancelled', cancelled_at = ? WHERE stream_id = ?")
    .run(now, stream_id);

  return {
    stream_id,
    status: 'cancelled',
    total_streamed_usdc: stream.streamed_usdc,
    refund_usdc: Math.round(refund * 1e6) / 1e6,
    platform_fee_usdc: Math.round(platform_fee * 1e6) / 1e6
  };
}

function getStream(stream_id) {
  const stream = db.prepare('SELECT * FROM revenue_streams WHERE stream_id = ?').get(stream_id);
  if (!stream) return { error: 'Stream not found' };

  return {
    stream_id: stream.stream_id,
    from_did: stream.from_did,
    to_did: stream.to_did,
    rate_per_second: stream.rate_per_second_usdc,
    total: stream.total_usdc,
    streamed_so_far: stream.streamed_usdc,
    remaining: Math.max(0, stream.total_usdc - stream.streamed_usdc),
    status: stream.status,
    started_at: stream.started_at
  };
}

function getStreamsForDid(did) {
  const inbound = db.prepare('SELECT * FROM revenue_streams WHERE to_did = ? ORDER BY started_at DESC').all(did);
  const outbound = db.prepare('SELECT * FROM revenue_streams WHERE from_did = ? ORDER BY started_at DESC').all(did);
  return { inbound, outbound };
}

function processStreams() {
  const active = db.prepare("SELECT * FROM revenue_streams WHERE status = 'active'").all();
  const now = new Date();
  let total_moved = 0;

  const txn = db.transaction(() => {
    for (const stream of active) {
      const started = new Date(stream.started_at);
      const elapsed_seconds = (now.getTime() - started.getTime()) / 1000;
      const should_have_streamed = Math.min(stream.total_usdc, stream.rate_per_second_usdc * elapsed_seconds);
      const to_stream = should_have_streamed - stream.streamed_usdc;

      if (to_stream <= 0) continue;

      const platform_fee = to_stream * 0.001; // 0.1%
      const net_amount = to_stream - platform_fee;

      // Deduct from sender vault
      const from_vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(stream.from_did);
      if (from_vault && from_vault.balance_usdc >= to_stream) {
        const from_new_balance = from_vault.balance_usdc - to_stream;
        const from_tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
        db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(from_new_balance, from_vault.vault_id);
        db.prepare(`
          INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
          VALUES (?, ?, ?, 'stream_out', ?, ?, 'stream', ?, ?)
        `).run(from_tx_id, from_vault.vault_id, stream.from_did, to_stream, from_new_balance, `stream:${stream.stream_id}`, now.toISOString());

        // Credit to receiver vault
        const to_vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(stream.to_did);
        if (to_vault) {
          const to_new_balance = to_vault.balance_usdc + net_amount;
          const to_tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
          db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(to_new_balance, to_vault.vault_id);
          db.prepare(`
            INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
            VALUES (?, ?, ?, 'stream_in', ?, ?, 'stream', ?, ?)
          `).run(to_tx_id, to_vault.vault_id, stream.to_did, net_amount, to_new_balance, `stream:${stream.stream_id}`, now.toISOString());
        }

        db.prepare(`
          UPDATE revenue_streams SET streamed_usdc = streamed_usdc + ?, platform_fee_usdc = platform_fee_usdc + ?
          WHERE stream_id = ?
        `).run(to_stream, platform_fee, stream.stream_id);

        total_moved += to_stream;
      }

      // Check if stream is complete
      if (should_have_streamed >= stream.total_usdc) {
        db.prepare("UPDATE revenue_streams SET status = 'completed', completed_at = ? WHERE stream_id = ?")
          .run(now.toISOString(), stream.stream_id);
      }
    }

    if (total_moved > 0) {
      db.prepare('UPDATE bank_stats SET total_streamed_volume_usdc = total_streamed_volume_usdc + ?, last_updated = ?')
        .run(total_moved, now.toISOString());
    }
  });
  txn();

  return { streams_processed: active.length, total_moved_usdc: Math.round(total_moved * 1e6) / 1e6 };
}

module.exports = { createStream, pauseStream, resumeStream, cancelStream, getStream, getStreamsForDid, processStreams };
