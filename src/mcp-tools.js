const vault = require('./services/vault');
const streaming = require('./services/streaming');
const db = require('./services/db');

const TOOL_DEFINITIONS = [
  {
    name: 'hivebank_create_vault',
    description: 'Create a yield-bearing USDC vault for an autonomous agent. Returns vault ID, DID, and initial balance.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_did: { type: 'string', description: 'Decentralized identifier (DID) of the vault owner' },
        vault_name: { type: 'string', description: 'Human-readable name for the vault' },
        vault_type: { type: 'string', description: 'Vault type (e.g. standard, high-yield)', default: 'standard' }
      },
      required: ['owner_did', 'vault_name']
    }
  },
  {
    name: 'hivebank_deposit',
    description: 'Deposit USDC into an agent vault. Returns updated balance and transaction ID.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_id: { type: 'string', description: 'Target vault ID' },
        amount_usdc: { type: 'number', description: 'Amount of USDC to deposit' },
        depositor_did: { type: 'string', description: 'DID of the depositor' }
      },
      required: ['vault_id', 'amount_usdc', 'depositor_did']
    }
  },
  {
    name: 'hivebank_create_stream',
    description: 'Create a programmable per-second payment stream between two agents. Funds flow continuously from sender to receiver over the specified duration.',
    inputSchema: {
      type: 'object',
      properties: {
        from_did: { type: 'string', description: 'Sender DID' },
        to_did: { type: 'string', description: 'Receiver DID' },
        total_usdc: { type: 'number', description: 'Total USDC to stream over the duration' },
        duration_seconds: { type: 'number', description: 'Stream duration in seconds' },
        memo: { type: 'string', description: 'Optional memo describing the payment purpose' }
      },
      required: ['from_did', 'to_did', 'total_usdc', 'duration_seconds']
    }
  },
  {
    name: 'hivebank_get_balance',
    description: 'Get vault balance, yield earned, and deposit history for an agent vault.',
    inputSchema: {
      type: 'object',
      properties: {
        vault_id: { type: 'string', description: 'Vault ID to look up' }
      },
      required: ['vault_id']
    }
  },
  {
    name: 'hivebank_get_stats',
    description: 'Get treasury-wide statistics: total vaults, deposits, active streams, yield generated, and streamed volume.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function executeCreateVault(params) {
  const { owner_did, vault_name, vault_type } = params;
  if (!owner_did) return { error: 'owner_did is required' };
  if (!vault_name) return { error: 'vault_name is required' };
  const result = vault.createVault(owner_did);
  if (result.error) return result;
  return { ...result, vault_name, vault_type: vault_type || 'standard' };
}

function executeDeposit(params) {
  const { vault_id, amount_usdc, depositor_did } = params;
  if (!vault_id) return { error: 'vault_id is required' };
  if (!amount_usdc) return { error: 'amount_usdc is required' };
  if (!depositor_did) return { error: 'depositor_did is required' };
  // Look up the DID for this vault
  const v = db.prepare('SELECT did FROM vaults WHERE vault_id = ?').get(vault_id);
  if (!v) return { error: 'Vault not found' };
  return vault.deposit(v.did, amount_usdc, 'mcp_deposit');
}

function executeCreateStream(params) {
  const { from_did, to_did, total_usdc, duration_seconds, memo } = params;
  if (!from_did) return { error: 'from_did is required' };
  if (!to_did) return { error: 'to_did is required' };
  if (!total_usdc) return { error: 'total_usdc is required' };
  if (!duration_seconds) return { error: 'duration_seconds is required' };
  return streaming.createStream(from_did, to_did, total_usdc, duration_seconds, memo);
}

function executeGetBalance(params) {
  const { vault_id } = params;
  if (!vault_id) return { error: 'vault_id is required' };
  const v = db.prepare('SELECT did FROM vaults WHERE vault_id = ?').get(vault_id);
  if (!v) return { error: 'Vault not found' };
  return vault.getVault(v.did);
}

function executeGetStats() {
  const stats = db.prepare('SELECT * FROM bank_stats WHERE id = 1').get();
  const total_vaults = db.prepare('SELECT COUNT(*) as count FROM vaults').get().count;
  const active_streams = db.prepare("SELECT COUNT(*) as count FROM revenue_streams WHERE status = 'active'").get().count;
  return {
    total_vaults,
    total_deposits_usdc: stats.total_deposits_usdc,
    total_yield_generated_usdc: stats.total_yield_generated_usdc,
    active_streams,
    total_streamed_volume_usdc: stats.total_streamed_volume_usdc
  };
}

function handleMcpRequest(req, res) {
  const { jsonrpc, id, method, params } = req.body;

  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Invalid Request: must use JSON-RPC 2.0' }
    });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hivebank', version: '1.0.0' }
      }
    });
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOL_DEFINITIONS }
    });
  }

  if (method === 'tools/call') {
    const toolName = params && params.name;
    const toolArgs = (params && params.arguments) || {};
    let result;

    switch (toolName) {
      case 'hivebank_create_vault':
        result = executeCreateVault(toolArgs);
        break;
      case 'hivebank_deposit':
        result = executeDeposit(toolArgs);
        break;
      case 'hivebank_create_stream':
        result = executeCreateStream(toolArgs);
        break;
      case 'hivebank_get_balance':
        result = executeGetBalance(toolArgs);
        break;
      case 'hivebank_get_stats':
        result = executeGetStats();
        break;
      default:
        return res.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: ${toolName}` }
        });
    }

    const isError = !!result.error;
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError
      }
    });
  }

  return res.json({
    jsonrpc: '2.0',
    id: id || null,
    error: { code: -32601, message: `Method not found: ${method}` }
  });
}

module.exports = { TOOL_DEFINITIONS, handleMcpRequest };
