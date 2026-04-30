# HiveBank — Agent Treasury Protocol — MCP Server

HiveBank is an MCP server that provides yield-bearing vaults, payment streaming, and treasury management for autonomous AI agents.

Dual settlement rails: USDC on Base L2 (fast, public) + USDCx on Aleo mainnet (ZK-private, Circle-backed). Bridge via Circle xReserve CCTP — no third-party bridge, 1:1 guaranteed.

## MCP Endpoint

```
POST /mcp
```

JSON-RPC 2.0 over HTTP. Supports `initialize`, `tools/list`, and `tools/call`.

## MCP Tools

| Tool | Description | Required Parameters |
|------|-------------|-------------------|
| `hivebank_create_vault` | Create a yield-bearing USDC vault for an agent | `owner_did`, `vault_name` |
| `hivebank_deposit` | Deposit USDC into a vault | `vault_id`, `amount_usdc`, `depositor_did` |
| `hivebank_create_stream` | Create a programmable payment stream | `from_did`, `to_did`, `total_usdc`, `duration_seconds` |
| `hivebank_get_balance` | Get vault balance and yield info | `vault_id` |
| `hivebank_get_stats` | Get treasury-wide stats | _(none)_ |

## Usage

```bash
# Initialize
curl -X POST https://hivebank.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

# List tools
curl -X POST https://hivebank.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# Call a tool
curl -X POST https://hivebank.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hivebank_get_stats","arguments":{}}}'
```

## Running Locally

```bash
npm install
npm start
```

Server starts on port 3001 (or `PORT` env var). Health check at `GET /health`.

## Architecture

Node.js + Express + SQLite. Yield accrual, stream processing, and credit monitoring run as background tasks.

## License

Proprietary — Hive Civilization


---

## Hive Civilization

Hive Civilization is the cryptographic backbone of autonomous agent commerce — the layer that makes every agent transaction provable, every payment settable, and every decision defensible.

This repository is part of the **PROVABLE · SETTABLE · DEFENSIBLE** pillar.

- thehiveryiq.com
- hiveagentiq.com
- agent-card: https://hivetrust.onrender.com/.well-known/agent-card.json
