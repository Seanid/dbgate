// 启动引导：加载配置（V1~V9）→ 表路由求值冻结（V7/V8）→ 连接池 → 元数据 → 跨实例一致性（V10）→ 查询内核 → 接入层。
// 用法：
//   npm start           → HTTP（127.0.0.1:8787）
//   npm run mcp         → MCP stdio
//   node src/bootstrap.js http|mcp
import pino from 'pino';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config/loader.js';
import { buildTableScope, formatScope } from './plan/tableScope.js';
import { collectAppids } from './plan/appidRegistry.js';
import { PoolManager } from './core/pools.js';
import { MetaService } from './meta/service.js';
import { checkConsistency } from './meta/consistency.js';
import { AuditLogger, DEFAULT_LOG_DIR } from './audit/logger.js';
import { QueryCore } from './core/queryCore.js';
import { createTokenValidator } from './auth/token.js';
import { startHttp } from './http/server.js';
import { startMcp } from './mcp/entry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCOPE_FILE = path.join(DEFAULT_LOG_DIR, 'table-scope.json');

async function main() {
  const transport = process.argv[2] ?? 'http';
  if (!['http', 'mcp'].includes(transport)) {
    console.error('用法: node src/bootstrap.js http|mcp');
    process.exit(2);
  }

  // 1. 配置加载 + 启动期校验（V1~V9）
  const config = loadConfig();
  config.appids = collectAppids(config); // 供一致性校验抽样

  // 2. 表路由求值 → 决议表冻结（V7/V8、§5.5）
  const scope = buildTableScope(config);
  await writeFile(SCOPE_FILE, JSON.stringify({ frozenAt: scope.frozenAt, tables: scope.byTable }, null, 2), 'utf8');

  const log = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'dbgate' },
  });

  console.log('DBGate 表路由决议表（已冻结到 logs/table-scope.json）');
  console.log('表 tableKey                命中规则                  实例范围');
  console.log(formatScope(scope));

  // 3. 基础设施
  const audit = new AuditLogger({ log });
  const pools = new PoolManager(config, log);
  const meta = new MetaService({ config, pools });
  const tokenValidator = createTokenValidator(config);
  const queryCore = new QueryCore({ config, scope, pools, meta, audit, log, tokenValidator });

  // 4. 跨实例 schema 一致性校验（V10、§8.3）
  const { warnings, checked } = await checkConsistency({ config, scope, poolManager: pools, meta, log });
  for (const w of warnings) log.warn({ consistency: true }, w);
  log.info({ checked }, '跨实例 schema 一致性校验完成');

  // 5. 启动接入层
  let server = null;
  if (transport === 'http') {
    server = await startHttp({ config, queryCore, audit, pools, log });
  } else {
    server = await startMcp({ config, queryCore, log });
  }

  // 6. 优雅退出
  const shutdown = async (signal) => {
    log.info({ signal }, '正在关闭…');
    try { if (server?.close) await server.close(); } catch { /* 忽略 */ }
    try { await pools.close(); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(`[DBGate] 启动失败：${e?.message ?? e}`);
  process.exit(1);
});
