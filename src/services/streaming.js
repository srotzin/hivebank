const { v4: uuidv4 } = require('uuid');
const db = require('./db');

async function createStream(from_did, to_did, total_usdc, duration_seconds, memo, verification_endpoint) {
  if (total_usdc <= 0) return { error: 'Total USDC must be positive' };
  if (duration_seconds <= 0) return { error: 'Duration must be positive' };

  const from_vault = await db.getOne('SELECT * FROM vaults WHERE did = $1', [from_did]);
  if (!from_vault) return { error: 'Sender vault not found' };
  if (Number(from_vault.balance_usdc) < total_usdc) return { error: 'Insufficient balance to fund stream' };

  const stream_id = `stream_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const rate_per_second_usdc = total_usdc / duration_seconds;
  const now = new Date().toISOString();
  const ends_at = new Date(Date.now() + duration_seconds * 1000).toISOString();

  await db.run(`
    INSERT INTO revenue_streams (stream_id, from_did, to_did, total_usdc, rate_per_second_usdc,
      streamed_usdc, platform_fee_usdc, duration_seconds, status, verification_endpoint, memo, started_at)
    VALUES ($1, $2, $3, $4, $5, 0, 0, $6, 'active', $7, $8, $9)
  `, [stream_id, from_did, to_did, total_usdc, rate_per_second_usdc, duration_seconds, verification_endpoint || null, memo || null, now]);

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

async function pauseStream(stream_id) {
  const stream = await db.getOne('SELECT * FROM revenue_streams WHERE stream_id = $1', [stream_id]);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status !== 'active') return { error: `Cannot pause stream in '${stream.status}' status` };

  const now = new Date().toISOString();
  await db.run("UPDATE revenue_streams SET status = 'paused', paused_at = $1 WHERE stream_id = $2",
    [now, stream_id]);

  return {
    stream_id,
    status: 'paused',
    streamed_so_far_usdc: Number(stream.streamed_usdc),
    paused_at: now
  };
}

async function resumeStream(stream_id) {
  const stream = await db.getOne('SELECT * FROM revenue_streams WHERE stream_id = $1', [stream_id]);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status !== 'paused') return { error: `Cannot resume stream in '${stream.status}' status` };

  const now = new Date().toISOString();
  await db.run("UPDATE revenue_streams SET status = 'active', paused_at = NULL WHERE stream_id = $1",
    [stream_id]);

  return {
    stream_id,
    status: 'active',
    resumed_at: now
  };
}

async function cancelStream(stream_id) {
  const stream = await db.getOne('SELECT * FROM revenue_streams WHERE stream_id = $1', [stream_id]);
  if (!stream) return { error: 'Stream not found' };
  if (stream.status === 'cancelled' || stream.status === 'completed') {
    return { error: `Stream already ${stream.status}` };
  }

  const now = new Date().toISOString();
  const refund = Number(stream.total_usdc) - Number(stream.streamed_usdc);
  const platform_fee = Number(stream.platform_fee_usdc);

  await db.run("UPDATE revenue_streams SET status = 'cancelled', cancelled_at = $1 WHERE stream_id = $2",
    [now, stream_id]);

  return {
    stream_id,
    status: 'cancelled',
    total_streamed_usdc: Number(stream.streamed_usdc),
    refund_usdc: Math.round(refund * 1e6) / 1e6,
    platform_fee_usdc: Math.round(platform_fee * 1e6) / 1e6
  };
}

async function getStream(stream_id) {
  const stream = await db.getOne('SELECT * FROM revenue_streams WHERE stream_id = $1', [stream_id]);
  if (!stream) return { error: 'Stream not found' };

  return {
    stream_id: stream.stream_id,
    from_did: stream.from_did,
    to_did: stream.to_did,
    rate_per_second: Number(stream.rate_per_second_usdc),
    total: Number(stream.total_usdc),
    streamed_so_far: Number(stream.streamed_usdc),
    remaining: Math.max(0, Number(stream.total_usdc) - Number(stream.streamed_usdc)),
    status: stream.status,
    started_at: stream.started_at
  };
}

async function getStreamsForDid(did) {
  const inbound = await db.getAll('SELECT * FROM revenue_streams WHERE to_did = $1 ORDER BY started_at DESC', [did]);
  const outbound = await db.getAll('SELECT * FROM revenue_streams WHERE from_did = $1 ORDER BY started_at DESC', [did]);
  return { inbound, outbound };
}

async function processStreams() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: active } = await client.query("SELECT * FROM revenue_streams WHERE status = 'active'");
    const now = new Date();
    let total_moved = 0;

    for (const stream of active) {
      const started = new Date(stream.started_at);
      const elapsed_seconds = (now.getTime() - started.getTime()) / 1000;
      const should_have_streamed = Math.min(Number(stream.total_usdc), Number(stream.rate_per_second_usdc) * elapsed_seconds);
      const to_stream = should_have_streamed - Number(stream.streamed_usdc);

      if (to_stream <= 0) continue;

      const platform_fee = to_stream * 0.001; // 0.1%
      const net_amount = to_stream - platform_fee;

      // Deduct from sender vault
      const { rows: [from_vault] } = await client.query(
        'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [stream.from_did]
      );
      if (from_vault && Number(from_vault.balance_usdc) >= to_stream) {
        const from_new_balance = Number(from_vault.balance_usdc) - to_stream;
        const from_tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
        await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [from_new_balance, from_vault.vault_id]);
        await client.query(`
          INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
          VALUES ($1, $2, $3, 'stream_out', $4, $5, 'stream', $6, $7)
        `, [from_tx_id, from_vault.vault_id, stream.from_did, to_stream, from_new_balance, `stream:${stream.stream_id}`, now.toISOString()]);

        // Credit to receiver vault
        const { rows: [to_vault] } = await client.query(
          'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [stream.to_did]
        );
        if (to_vault) {
          const to_new_balance = Number(to_vault.balance_usdc) + net_amount;
          const to_tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
          await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [to_new_balance, to_vault.vault_id]);
          await client.query(`
            INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
            VALUES ($1, $2, $3, 'stream_in', $4, $5, 'stream', $6, $7)
          `, [to_tx_id, to_vault.vault_id, stream.to_did, net_amount, to_new_balance, `stream:${stream.stream_id}`, now.toISOString()]);
        }

        await client.query(`
          UPDATE revenue_streams SET streamed_usdc = streamed_usdc + $1, platform_fee_usdc = platform_fee_usdc + $2
          WHERE stream_id = $3
        `, [to_stream, platform_fee, stream.stream_id]);

        total_moved += to_stream;
      }

      // Check if stream is complete
      if (should_have_streamed >= Number(stream.total_usdc)) {
        await client.query("UPDATE revenue_streams SET status = 'completed', completed_at = $1 WHERE stream_id = $2",
          [now.toISOString(), stream.stream_id]);
      }
    }

    if (total_moved > 0) {
      await client.query('UPDATE bank_stats SET total_streamed_volume_usdc = total_streamed_volume_usdc + $1, last_updated = $2',
        [total_moved, now.toISOString()]);
    }

    await client.query('COMMIT');

    return { streams_processed: active.length, total_moved_usdc: Math.round(total_moved * 1e6) / 1e6 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createStream, pauseStream, resumeStream, cancelStream, getStream, getStreamsForDid, processStreams };
