#!/usr/bin/env bash
# CI guard — fail the build if the OLD drained treasury address reappears
# in source, OR if a hardcoded `||` fallback for HOUSE_WALLET / TREASURY_WALLET
# is added.
#
# Rotated 2026-04-25 (PR #6 treasury-fallback-purge).
# Prior drained treasury (DEAD): 0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe
#
# HiveFilter: 22/22

set -euo pipefail

OLD_ADDR='0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe'
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Skip node_modules, .git, the guard script itself, AND the treasury helper
# (whose docstring intentionally references the old address as documentation).
EXCLUDES='--exclude-dir=node_modules --exclude-dir=.git --exclude=check-no-leaked-treasury.sh --exclude=treasury.js'

# 1) Hard fail on old treasury address embedded anywhere in non-helper source
if grep -rni $EXCLUDES "$OLD_ADDR" "$ROOT" >/dev/null 2>&1; then
  echo "❌ Old drained treasury address detected in source!"
  grep -rni $EXCLUDES "$OLD_ADDR" "$ROOT" || true
  echo
  echo "Rotated 2026-04-25. The previous treasury is DRAINED. Read via src/lib/treasury.js"
  exit 1
fi

# 2) Hard fail on hardcoded `||` fallback to any 0x... literal for HOUSE_WALLET/TREASURY_WALLET
if grep -rEn $EXCLUDES "process\.env\.(HOUSE_WALLET|TREASURY_WALLET) *\|\| *['\"]0x[a-fA-F0-9]{40}" "$ROOT" >/dev/null 2>&1; then
  echo "❌ Hardcoded || fallback for HOUSE_WALLET/TREASURY_WALLET detected — fail closed only."
  grep -rEn $EXCLUDES "process\.env\.(HOUSE_WALLET|TREASURY_WALLET) *\|\| *['\"]0x[a-fA-F0-9]{40}" "$ROOT" || true
  echo
  echo "Use require('./lib/treasury').getTreasuryAddress() instead — it throws on missing env."
  exit 1
fi

echo "✓ No old-treasury references and no hardcoded HOUSE_WALLET/TREASURY_WALLET fallbacks."
