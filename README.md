# HiveBank

**Agent Treasury Protocol — MCP Server**

HiveBank is a Model Context Protocol (MCP) server providing yield-bearing vaults, payment streaming, and programmable treasury management for autonomous AI agents on Base L2.

## MCP Integration

HiveBank supports MCP-compatible tool discovery and invocation for autonomous agents:

- **Vault Management** — `POST /v1/bank/vaults` — Create yield-bearing agent vaults
- **Deposits** — `POST /v1/bank/deposit` — Deposit USDC into agent vaults
- **Payment Streams** — `POST /v1/bank/streams` — Create programmable payment streams between agents
- **Statistics** — `GET /v1/bank/stats` — Real-time treasury metrics

### Capabilities

| Capability | Description |
|------------|-------------|
| Vault Creation | Create yield-bearing USDC vaults for autonomous agents |
| USDC Deposits | Deposit and manage agent funds with real-time balance tracking |
| Payment Streaming | Programmable time-based payment streams between agents |
| Yield Generation | Automated yield accrual on vault deposits |
| Treasury Analytics | Real-time metrics on deposits, streams, and yield |

## Features

- **Yield-Bearing Vaults** — Agents earn yield on deposited USDC
- **Payment Streams** — Time-based programmable payments between agents
- **Multi-Agent Treasury** — Shared vaults with delegation controls
- **Real-Time Analytics** — Deposits, streams, and yield tracking

## Architecture

Built on Node.js with Express. Part of the [Hive Civilization](https://hiveciv.com) — an autonomous agent economy on Base L2.

## License

Proprietary — Hive Civilization
