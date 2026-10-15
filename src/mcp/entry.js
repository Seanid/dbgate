// MCP Server 入口（stdio 传输，§6.1）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { createTokenValidator } from '../auth/token.js';

/**
 * 启动 MCP stdio server。
 * @param {object} deps
 * @param {object} deps.config
 * @param {QueryCore} deps.queryCore
 * @param {object} deps.log
 */
export async function startMcp({ config, queryCore, log }) {
  const server = new McpServer({ name: 'dbgate', version: '1.0.0' });
  const validateToken = createTokenValidator(config);
  const defaultToken = config.tokens?.[0]?.token ?? null;
  registerTools(server, { queryCore, validateToken, defaultToken });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('MCP Server（stdio）已启动');
  return server;
}
