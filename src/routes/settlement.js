/**
 * HiveBank Settlement Rails
 *
 * GET /v1/bank/settlement-rails — Four-rail settlement infrastructure:
 *   1. USDC on Base L2      (fast, public, EVM-native)
 *   2. USDCx on Aleo        (ZK-private amounts, Circle xReserve backed)
 *   3. USAD on Aleo         (ZK-private amounts AND addresses, Paxos/NYDFS)
 *   4. ALEO native          (pure Aleo ecosystem, PoSW secured)
 *
 * True agentic anonymity: agents choose their rail at onboarding.
 * All Aleo rails receive at the same shield address.
 */

const express = require('express');
const { ok }  = require('../ritz');
const router  = express.Router();

const SERVICE = 'hivebank';

const ALEO_SHIELD = 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk';
const BASE_USDC   = '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf';

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
        settlement_wallet: BASE_USDC,
        explorer: `https://basescan.org/address/${BASE_USDC}`,
        finality_seconds: 2,
        privacy: 'public',
        privacy_detail: 'Transaction amounts and addresses visible on-chain.',
        status: 'active',
        genius_act_compliant: true,
        use_case: 'Fast, low-cost EVM-native settlement. Default rail for integrations, existing wallets, and EVM ecosystem.',
        onboard: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },
      {
        id: 'aleo-usdcx',
        name: 'USDCx on Aleo Mainnet',
        asset: 'USDCx',
        network: 'Aleo (L1 ZK blockchain)',
        settlement_wallet: ALEO_SHIELD,
        program: 'hive_trust.aleo',
        backed_by: 'Circle xReserve — 1:1 USDC, no third-party bridge',
        bridge: 'Circle CCTP — burn USDCx on Aleo, mint USDC on Base (and vice versa)',
        mainnet_launch: '2026-01-27',
        launch_partners: ['Toku', 'Request Finance', 'Dynamic', 'Blockdaemon', 'Chainalysis'],
        finality_seconds: 5,
        privacy: 'ZK-private amounts',
        privacy_detail: 'Transaction amounts hidden by Aleo ZK proof. Wallet addresses visible. Issuer: Circle.',
        status: 'active',
        genius_act_compliant: true,
        use_case: 'Privacy-preserving settlement. Amounts hidden. Agent identity DID-provable for AML compliance.',
        proof_generator: 'Nordic Mine — 115 Aleo PoSW miners',
        zk_program: 'GET https://hivetrust.onrender.com/v1/trust/zk-status',
        onboard: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },
      {
        id: 'aleo-usad',
        name: 'USAD on Aleo Mainnet',
        asset: 'USAD',
        network: 'Aleo (L1 ZK blockchain)',
        settlement_wallet: ALEO_SHIELD,
        issuer: 'Paxos Labs',
        regulator: 'NYDFS (New York Department of Financial Services)',
        backed_by: 'USDG reserves — Paxos Trust Company, 1:1 USD-backed',
        mainnet_launch: '2026-02-11',
        launch_partners: ['Toku', 'Request Finance'],
        finality_seconds: 5,
        privacy: 'ZK-private amounts AND addresses',
        privacy_detail: 'Both transaction amounts AND wallet addresses encrypted end-to-end. True agentic anonymity. Issuer: Paxos Labs (NYDFS-regulated).',
        status: 'active',
        genius_act_compliant: true,
        clarity_act_classification: 'payment_stablecoin',
        use_case: 'True agentic anonymity. Neither party nor amount visible on-chain. Preferred rail for enterprise treasury, B2B agent payments, and maximum privacy.',
        info: 'https://aleo.org/usad',
        onboard: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },
      {
        id: 'aleo-native',
        name: 'ALEO Native Token',
        asset: 'ALEO',
        network: 'Aleo (L1 ZK blockchain)',
        settlement_wallet: ALEO_SHIELD,
        finality_seconds: 5,
        privacy: 'ZK-private',
        privacy_detail: 'Native Aleo token. Full ZK-private transfers. Used for compute fees and pure Aleo ecosystem settlement.',
        status: 'active',
        use_case: 'Pure Aleo ecosystem agents. ZK proof compute costs. Agents that operate entirely within the Aleo network.',
        onboard: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },
    ],
    agent_rail_selection: {
      description: 'Agents choose their settlement rail at onboarding. Preference is stored in the agent DID record and referenced in every HAHS 1.0.0 contract.',
      how_to_set: 'Include settlement_rail in POST /v1/gate/onboard body.',
      valid_values: ['base-usdc', 'aleo-usdcx', 'aleo-usad', 'aleo-native'],
      default: 'base-usdc',
    },
    bridge: {
      protocol: 'Circle CCTP',
      description: 'Move between USDC (Base) and USDCx (Aleo) with no third-party bridge. Circle burns on source, mints on destination. 1:1 guaranteed.',
      supported_chains: ['Base', 'Aleo', 'Ethereum', 'Arbitrum', 'Optimism'],
      docs: 'https://www.circle.com/xreserve',
    },
    hive_aleo_address: ALEO_SHIELD,
    hive_base_address: BASE_USDC,
    privacy_matrix: {
      'base-usdc':   { amounts: 'public',  addresses: 'public',  anonymity: 'none' },
      'aleo-usdcx':  { amounts: 'private', addresses: 'visible', anonymity: 'partial' },
      'aleo-usad':   { amounts: 'private', addresses: 'private', anonymity: 'full' },
      'aleo-native': { amounts: 'private', addresses: 'private', anonymity: 'full' },
    },
    recommendation: 'Use Base USDC for speed and EVM ecosystem compatibility. Use Aleo USDCx for ZK-private amounts with Circle trust. Use Aleo USAD for true agentic anonymity — amounts AND addresses encrypted, Paxos/NYDFS-regulated. Use ALEO native for pure Aleo ecosystem agents.',
  });
});

module.exports = router;
