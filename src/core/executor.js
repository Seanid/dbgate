// 并行执行 + 并发控制 + 总超时预算（§7.4）。
// - 并发度 = min(limits.maxConcurrency, bizType.concurrency ?? ∞, targets.length)
// - queryTimeoutMs 是**整个 fan-out 的总预算**：记录起始时刻，每个目标可用时间 = 总预算 - 已消耗
// - MUST NOT 给每个目标各一份完整超时
// - 超时使用 SET SESSION MAX_EXECUTION_TIME = ?（对只读 SELECT 生效），配合兜底 conn.destroy()
// - MUST NOT 仅用 Promise.race 假装超时（MySQL 侧仍在跑，慢查询会吃干连接池）
import {
  DB_ERROR, INSTANCE_UNAVAILABLE, QUERY_TIMEOUT, SHARD_TABLE_MISSING,
  MYSQL_NO_SUCH_TABLE, MYSQL_MAX_EXEC_TIME,
} from '../errors.js';

const GRACE_AFTER_BUDGET_MS = 1500; // destroy 兜底比预算多给的余量

function classifyError(e) {
  const errno = e?.errno;
  const code = e?.code;
  if (errno === MYSQL_NO_SUCH_TABLE || code === 'ER_NO_SUCH_TABLE') return 'MISSING_TABLE';
  if (e?.__timeout) return 'QUERY_TIMEOUT';
  if (errno === MYSQL_MAX_EXEC_TIME || code === 'ER_QUERY_TIMEOUT' || code === 'ER_QUERY_INTERRUPTED' || errno === 1317) return 'QUERY_TIMEOUT';
  const connCodes = [
    'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EPIPE',
    'ER_ACCESS_DENIED_ERROR', 'PROTOCOL_CONNECTION_LOST', 'POOL_TIMEOUT',
    'ER_CON_COUNT_ERROR', 'ER_TOO_MANY_USER_CONNECTIONS', 'ER_USER_LIMIT_REACHED',
  ];
  if (connCodes.includes(code) || [1045, 1040, 1203, 1042, 2002, 2003].includes(errno)) return 'INSTANCE_UNAVAILABLE';
  return 'DB_ERROR';
}

/**
 * 执行一批单目标查询（一个 fan-out 的全部 target）。
 * @param {object} deps
 * @param {Array} deps.tasks [{ target:{instance,database,table}, sql, params, columnNames }]
 * @param {PoolManager} deps.pools
 * @param {object} deps.limits
 * @param {number} deps.concurrency 该查询的并发上限
 * @param {'empty'|'error'} deps.missingTablePolicy
 * @param {object} deps.log
 * @returns {Promise<Array>} 与 tasks 顺序无关的完成数组；每项
 *   { instance, table, ok, rowCount, rows, elapsedMs, missingTable?, error? }
 */
export async function runTargets({ tasks, pools, limits, concurrency, missingTablePolicy, log }) {
  const budgetMs = limits.queryTimeoutMs;
  const deadline = Date.now() + budgetMs;
  const limit = Math.max(1, Math.min(limits.maxConcurrency, concurrency ?? Infinity, tasks.length));

  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await runOne(tasks[i], deadline, { pools, missingTablePolicy, log });
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

async function runOne(task, deadline, { pools, missingTablePolicy, log }) {
  const t0 = Date.now();
  const target = task.target;
  const fail = (error, extra = {}) => ({
    instance: target.instance,
    database: target.database,
    table: target.table,
    ok: false,
    rowCount: 0,
    rows: [],
    elapsedMs: Date.now() - t0,
    error,
    ...extra,
  });
  const timeout = (extra = {}) => {
    const e = new Error(`目标执行超时（总预算 ${0}ms）`);
    e.__timeout = true;
    return e;
  };

  if (Date.now() >= deadline) return fail('QUERY_TIMEOUT');

  const pool = pools.get(target.instance, target.database);
  let conn = null;
  let destroyed = false;
  const destroyTimer = setTimeout(() => {
    destroyed = true;
    if (conn) { try { conn.destroy(); } catch { /* 忽略 */ } }
  }, deadline - t0 + GRACE_AFTER_BUDGET_MS);

  try {
    conn = await pool.getConnection();
    // mysql2/promise 的 getConnection() 返回 PromisePoolConnection：query/execute 已是 promise 接口，可直接 await
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timeout();
    // 服务端硬超时：对只读 SELECT 生效（§7.4 MUST）
    await conn.query('SET SESSION MAX_EXECUTION_TIME = ?', [Math.max(1, Math.floor(remaining))]);
    const [rows] = await conn.query({ sql: task.sql, values: task.params });
    const arr = rows.map((r) => task.columnNames.map((c) => (c in r && r[c] !== undefined ? r[c] : null)));
    return {
      instance: target.instance,
      database: target.database,
      table: target.table,
      ok: true,
      rowCount: arr.length,
      rows: arr,
      elapsedMs: Date.now() - t0,
      missingTable: false,
    };
  } catch (e) {
    const kind = classifyError(e);
    if (kind === 'MISSING_TABLE') {
      // fanout 下“某 appid 在某实例没建表”是正常状态（§7.6）：
      // 默认 empty → 空结果 ok:true（不置 partial）；policy=error → SHARD_TABLE_MISSING
      if (missingTablePolicy === 'error') return fail('SHARD_TABLE_MISSING', { missingTable: true });
      return {
        instance: target.instance,
        database: target.database,
        table: target.table,
        ok: true,
        rowCount: 0,
        rows: [],
        elapsedMs: Date.now() - t0,
        missingTable: true,
      };
    }
    if (kind === 'QUERY_TIMEOUT') return fail('QUERY_TIMEOUT');
    if (kind === 'INSTANCE_UNAVAILABLE') return fail('INSTANCE_UNAVAILABLE');
    // DB_ERROR：原始信息只进日志，不透传给 Agent（§6.4）
    log.error({ err: e, instance: target.instance, table: target.table, sql: task.sql }, '目标执行 DB_ERROR');
    return fail('DB_ERROR');
  } finally {
    clearTimeout(destroyTimer);
    if (conn) {
      try {
        if (destroyed) conn.destroy();
        else conn.release();
      } catch { /* 忽略 */ }
    }
  }
}
