/**
 * HiveBank Settlement Rails
 *
 * GET /v1/bank/settlement-rails — Dual settlement infrastructure:
 *   1. USDC on Base L2 (fast, public, EVM-native)
 *   2. USDCx on Aleo mainnet (ZK-private, Circle xReserve backed)
 */

const express = require('express');
const { ok }  = require('../ritz');
const router   = express.Router();

const SERVICE = 'hivebank';

router.get('/settlement-rails', (req, res) => {
  return ok(res, SERVICE, {
    rails: [
      {
        id: 'base-usdc',
        name: 'USDC on Base L2',
        asset: 'USDC',
        network: 'Base (Ethereum L2)',
        chain_id: 8453,
        contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        settlement_wallet: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
        explorer: 'https://basescan.org/address/0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
        finality_seconds: 2,
        privacy: 'public',
        status: 'active',
        use_case: 'Fast, low-cost EVM-native settlement. Default rail for all agent transactions.',
        onboard: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },
      {
        id: 'aleo-usdcx',
        name: 'USDCx on Aleo Mainnet',
        asset: 'USDCx',
        network: 'Aleo (L1 ZK blockchain)',
        program: 'hive_trust.aleo',
        backed_by: 'USDC via Circle xReserve (1:1, no third-party bridge)',
        interoperability: 'Circle CCTP — burn USDCx on Aleo, mint USDC on Base (and vice versa)',
        privacy: 'zero-knowledge — transaction amounts and counterparties are private by default',
        status: 'active',
        mainnet_launch: '2026-01-27',
        launch_partners: ['Toku', 'Request Finance', 'Dynamic', 'Blockdaemon', 'Chainalysis'],
        use_case: 'Privacy-preserving settlement for enterprise agents. Transaction amounts hidden by ZK proof. Reputation proven without revealing balance.',
        proof_generator: 'Nordic Mine — 115 Aleo PoSW miners',
        zk_program: 'GET https://hivetrust.onrender.com/v1/trust/zk-status',
        wallet_attestation: 'GET https://hivetrust.onrender.com/v1/trust/wallet-attestation',
      },
    ],
    bridge: {
      protocol: 'Circle xReserve + CCTP',
      description: 'Move between USDC (Base) and USDCx (Aleo) with no third-party bridge. Circle burns on source chain, mints on destination. 1:1 guaranteed.',
      supported_chains: ['Base', 'Aleo', 'Ethereum', 'Arbitrum', 'Optimism'],
      docs: 'https://www.circle.com/xreserve',
    },
    recommendation: 'Use Base USDC for speed and EVM compatibility. Use Aleo USDCx when transaction privacy is required or ZK proof of settlement is needed for compliance.',
  });
});

module.exports = router;
