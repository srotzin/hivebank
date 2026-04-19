/**
 * usdc-transfer.js — Real on-chain USDC transfer on Base L2
 *
 * Uses ethers.js v6 to call transfer() on the USDC ERC-20 contract.
 * Private key loaded from env: HIVE_WALLET_PRIVATE_KEY
 * RPC: BASE_RPC_URL (defaults to https://mainnet.base.org, chain ID 8453)
 *
 * USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 * 6 decimal places: 1 USDC = 1_000_000 units
 *
 * Safe usage:
 *   const { sendUSDC, checkUSDCBalance } = require('./usdc-transfer');
 *   const result = await sendUSDC(recipientAddress, 1.00);   // 1.00 USDC
 */

const { ethers } = require('ethers');

// ─── Constants ────────────────────────────────────────────────────────────────
const USDC_CONTRACT_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const CHAIN_ID = 8453; // Base L2 mainnet

// Minimal ERC-20 ABI — only what we need
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// ─── Provider + Signer (lazy init) ───────────────────────────────────────────
let _provider = null;
let _signer   = null;
let _contract  = null;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(BASE_RPC_URL, {
      chainId: CHAIN_ID,
      name: 'base',
    });
  }
  return _provider;
}

function getSigner() {
  if (!_signer) {
    const pk = process.env.HIVE_WALLET_PRIVATE_KEY;
    if (!pk) {
      throw new Error('HIVE_WALLET_PRIVATE_KEY env var not set — cannot sign transactions');
    }
    // Accept with or without 0x prefix
    const normalizedPk = pk.startsWith('0x') ? pk : `0x${pk}`;
    _signer = new ethers.Wallet(normalizedPk, getProvider());
  }
  return _signer;
}

function getContract() {
  if (!_contract) {
    _contract = new ethers.Contract(USDC_CONTRACT_ADDRESS, ERC20_ABI, getSigner());
  }
  return _contract;
}

// ─── Check Hive wallet USDC balance ──────────────────────────────────────────
async function checkUSDCBalance() {
  try {
    const signer  = getSigner();
    const contract = getContract();
    const raw     = await contract.balanceOf(signer.address);
    const usdc    = Number(raw) / 1_000_000;
    return {
      address:      signer.address,
      balance_usdc: usdc,
      balance_raw:  raw.toString(),
      ok: true,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Send USDC on-chain ───────────────────────────────────────────────────────
/**
 * @param {string}  toAddress   — EVM recipient address (0x...)
 * @param {number}  amountUsdc  — amount in human USDC (e.g. 1.00 for $1)
 * @param {object}  opts        — optional: { gasLimit, maxPriorityFeePerGas }
 * @returns {object} { ok, tx_hash, amount_usdc, to, from, error? }
 */
async function sendUSDC(toAddress, amountUsdc, opts = {}) {
  // Guard: env var must exist
  if (!process.env.HIVE_WALLET_PRIVATE_KEY) {
    console.warn('[usdc-transfer] HIVE_WALLET_PRIVATE_KEY not set — transfer skipped (DB-only mode)');
    return {
      ok: false,
      skipped: true,
      reason: 'HIVE_WALLET_PRIVATE_KEY not configured',
      amount_usdc: amountUsdc,
      to: toAddress,
    };
  }

  // Guard: valid EVM address
  if (!toAddress || !ethers.isAddress(toAddress)) {
    return { ok: false, error: `Invalid recipient address: ${toAddress}` };
  }

  // Guard: positive amount
  if (!amountUsdc || amountUsdc <= 0) {
    return { ok: false, error: 'Amount must be > 0' };
  }

  // Convert to USDC units (6 decimals) — use BigInt arithmetic to avoid float precision
  const amountRaw = BigInt(Math.round(amountUsdc * 1_000_000));

  try {
    const contract = getContract();
    const signer   = getSigner();

    // Check balance before sending
    const balanceRaw = await contract.balanceOf(signer.address);
    if (balanceRaw < amountRaw) {
      const balanceHuman = Number(balanceRaw) / 1_000_000;
      return {
        ok: false,
        error: `Insufficient USDC balance: have ${balanceHuman.toFixed(6)}, need ${amountUsdc}`,
        wallet_balance_usdc: balanceHuman,
      };
    }

    // Build tx overrides
    const overrides = {};
    if (opts.gasLimit) overrides.gasLimit = BigInt(opts.gasLimit);

    console.log(`[usdc-transfer] Sending ${amountUsdc} USDC → ${toAddress} on Base L2`);

    const tx = await contract.transfer(toAddress, amountRaw, overrides);

    console.log(`[usdc-transfer] TX submitted: ${tx.hash}`);

    // Wait for 1 confirmation (Base is fast — ~2s blocks)
    const receipt = await tx.wait(1);

    console.log(`[usdc-transfer] Confirmed in block ${receipt.blockNumber} — hash: ${tx.hash}`);

    return {
      ok:           true,
      tx_hash:      tx.hash,
      block:        receipt.blockNumber,
      amount_usdc:  amountUsdc,
      amount_raw:   amountRaw.toString(),
      from:         signer.address,
      to:           toAddress,
      chain:        'base',
      chain_id:     CHAIN_ID,
      explorer_url: `https://basescan.org/tx/${tx.hash}`,
    };
  } catch (err) {
    console.error(`[usdc-transfer] Transfer failed: ${err.message}`);
    return {
      ok:    false,
      error: err.message,
      amount_usdc: amountUsdc,
      to:    toAddress,
    };
  }
}

// ─── Test-mode: 0.01 USDC probe ──────────────────────────────────────────────
/**
 * Send 0.01 USDC to a given address as a smoke-test.
 * Steve runs this once to verify the pipe works before enabling full bonuses.
 */
async function testTransfer(toAddress) {
  console.log('[usdc-transfer] Running 0.01 USDC smoke test...');
  return sendUSDC(toAddress, 0.01);
}

module.exports = { sendUSDC, checkUSDCBalance, testTransfer };
