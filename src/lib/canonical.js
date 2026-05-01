// JSON canonicalization (JCS, RFC 8785, simplified) +
// EIP-55 address checksum helper.
//
// canonicalAddress() is THE canonical way to convert a 40-hex EVM address
// to its EIP-55 form. Every public surface (openapi.json, x402 challenge,
// mpp receipt) MUST emit addresses through this helper, never via
// `.toLowerCase()` and never via interpolation of raw env values.
//
// Backed by ethers v6 `getAddress()` — battle-tested implementation, same
// library we already use for transferWithAuthorization.
//
// Treasury-fallback purge 2026-04-30 — Hole #6 / #11 / #12 mitigation.

'use strict';

const { ethers } = require('ethers');

const HEX40 = /^0x[a-fA-F0-9]{40}$/;

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    if (value[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + canonicalize(value[k]));
  }
  return '{' + parts.join(',') + '}';
}

function canonicalBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8');
}

/**
 * EIP-55 checksum encode. Input must be a 40-hex EVM address with 0x prefix.
 * Returns the canonical mixed-case form. Throws on invalid input.
 *
 * Uses ethers.getAddress() under the hood — RFC-correct, audited.
 */
function canonicalAddress(addr) {
  if (typeof addr !== 'string' || !HEX40.test(addr)) {
    throw new Error(`canonicalAddress: not a 40-hex EVM address: ${addr}`);
  }
  return ethers.getAddress(addr);
}

module.exports = { canonicalize, canonicalBytes, canonicalAddress };
