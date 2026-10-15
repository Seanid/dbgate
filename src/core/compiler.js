// ★ 编译器：全仓唯一生成业务 SQL 的地方（C1）。
// - 只负责把一次逻辑查询编译成单 target SQL；对“有几个 target”无感知（§6.5.1）
// - 字段名取自白名单/配置原文（§6.5.2），任何入参值只出现在 params（C4）
// - 隔离列恒定追加，对每个 target 都注入（§6.5.3）
// - ORDER BY 末尾恒定追加主键 tie-breaker（§6.5.5）
import { APPID_MISMATCH, OPERATOR_NOT_ALLOWED, err } from '../errors.js';

// §6.5.4 操作符枚举 → SQL 片段
const OP_SQL = {
  eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', in: 'IN', not_in: 'NOT IN', between: 'BETWEEN',
  is_null: 'IS NULL', not_null: 'IS NOT NULL',
};

export const SUPPORTED_OPS = Object.keys(OP_SQL);

/** 标识符加反引号（配置原文；反引号按 MySQL 规则转义为 ``）。 */
function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/**
 * §6.5.3 隔离列强制注入前的规范化：
 * - 未显式传隔离列条件 → 原样返回（系统恒定追加 = 请求 appid）
 * - 值一致 → 去除该条件（已由系统注入）
 * - 值不一致 / in 不含请求 appid → 直接拒绝 APPID_MISMATCH（MUST NOT 静默覆盖）
 * - in 且包含请求 appid → 收窄为 eq
 */
export function normalizeIsolation(filters, isolationColumn, isolationValue) {
  if (!isolationColumn) return filters ?? [];
  const out = [];
  for (const f of filters ?? []) {
    if (String(f.field).toLowerCase() !== String(isolationColumn).toLowerCase()) {
      out.push(f);
      continue;
    }
    const target = String(isolationValue);
    if (f.op === 'eq') {
      if (String(f.value) === target) continue; // 与系统注入一致，丢弃
      throw err(APPID_MISMATCH, `隔离列条件与请求 appid 不一致：filters 中 ${isolationColumn}=${JSON.stringify(f.value)}，请求 appid=${target}`);
    }
    if (f.op === 'in' && Array.isArray(f.value)) {
      const values = f.value.map((v) => String(v));
      if (values.includes(target)) {
        out.push({ field: isolationColumn, op: 'eq', value: isolationValue });
        continue;
      }
      throw err(APPID_MISMATCH, `隔离列 IN 条件不含请求 appid ${target}，拒绝查询`);
    }
    throw err(APPID_MISMATCH, `隔离列只允许 eq/in 条件，收到 op=${f.op}，拒绝查询`);
  }
  return out;
}

function buildWhere(filters, isolationColumn, isolationValue) {
  const clauses = [];
  const params = [];
  if (isolationColumn && isolationValue !== undefined) {
    clauses.push(`${quoteIdent(isolationColumn)} = ?`);
    params.push(isolationValue);
  }
  for (const f of filters) {
    const col = quoteIdent(f.field);
    switch (f.op) {
      case 'eq': clauses.push(`${col} = ?`); params.push(f.value); break;
      case 'ne': clauses.push(`${col} <> ?`); params.push(f.value); break;
      case 'gt': clauses.push(`${col} > ?`); params.push(f.value); break;
      case 'gte': clauses.push(`${col} >= ?`); params.push(f.value); break;
      case 'lt': clauses.push(`${col} < ?`); params.push(f.value); break;
      case 'lte': clauses.push(`${col} <= ?`); params.push(f.value); break;
      case 'like': clauses.push(`${col} LIKE ?`); params.push(f.value); break;
      case 'in': clauses.push(`${col} IN (${f.value.map(() => '?').join(',')})`); params.push(...f.value); break;
      case 'not_in': clauses.push(`${col} NOT IN (${f.value.map(() => '?').join(',')})`); params.push(...f.value); break;
      case 'between': clauses.push(`${col} BETWEEN ? AND ?`); params.push(f.value[0], f.value[1]); break;
      case 'is_null': clauses.push(`${col} IS NULL`); break;
      case 'not_null': clauses.push(`${col} IS NOT NULL`); break;
      default:
        throw err(OPERATOR_NOT_ALLOWED, `不支持的操作符 "${f.op}"`, { op: f.op });
    }
  }
  return { clause: clauses.join(' AND '), params };
}

function buildOrderBy(sort, tieBreakers) {
  const parts = [];
  const used = new Set();
  for (const s of sort ?? []) {
    const key = s.field.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    parts.push(`${quoteIdent(s.field)} ${s.desc ? 'DESC' : 'ASC'}`);
  }
  for (const tb of tieBreakers ?? ['id']) {
    if (tb === '_instance') continue; // 虚拟键，由归并层处理（§7.5.5）
    const key = String(tb).toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    parts.push(`${quoteIdent(tb)} ASC`);
  }
  return parts.join(', ');
}

/**
 * 编译记录查询（单 target）。
 * @param {object} q
 * @param {string} q.database
 * @param {string} q.table 物理表名
 * @param {string[]} q.columns 白名单解析后的列名（本 target 存在的列）
 * @param {string[]} [q.nullColumns] 本 target 缺失的列 → NULL AS `col`（跨实例列漂移时保持归并形状一致）
 * @param {Array} q.filters 已过守卫的过滤器
 * @param {Array} q.sort 已过守卫的排序键
 * @param {number} q.limit
 * @param {number} q.offset
 * @param {string} [q.isolationColumn]
 * @param {*} q.isolationValue
 * @param {string[]} [q.tieBreakers]
 * @returns {{ sql: string, params: Array }}
 */
export function compileSelect({ database, table, columns, nullColumns, filters, sort, limit, offset, isolationColumn, isolationValue, tieBreakers }) {
  const clean = normalizeIsolation(filters ?? [], isolationColumn, isolationValue);
  const where = buildWhere(clean, isolationColumn, isolationValue);
  const orderBy = buildOrderBy(sort ?? [], tieBreakers);
  const selectParts = [];
  for (const c of columns ?? []) selectParts.push(quoteIdent(c));
  for (const nc of nullColumns ?? []) selectParts.push(`NULL AS ${quoteIdent(nc)}`);
  const selectCols = selectParts.length ? selectParts.join(', ') : '*';
  const sql = [
    `SELECT ${selectCols}`,
    `FROM ${quoteIdent(database)}.${quoteIdent(table)}`,
    where.clause ? `WHERE ${where.clause}` : null,
    orderBy ? `ORDER BY ${orderBy}` : null,
    `LIMIT ? OFFSET ?`,
  ].filter(Boolean).join('\n');
  return { sql, params: [...where.params, limit, offset] };
}

/** 编译计数（单 target）。返回行 [{ cnt }]。 */
export function compileCount({ database, table, filters, isolationColumn, isolationValue }) {
  const clean = normalizeIsolation(filters ?? [], isolationColumn, isolationValue);
  const where = buildWhere(clean, isolationColumn, isolationValue);
  const sql = [
    `SELECT COUNT(*) AS \`cnt\``,
    `FROM ${quoteIdent(database)}.${quoteIdent(table)}`,
    where.clause ? `WHERE ${where.clause}` : null,
  ].filter(Boolean).join('\n');
  return { sql, params: where.params };
}

/**
 * §7.5.2：avg 在编译期就展开为 SUM + COUNT 两个指标下推，归并层只拿到分子分母。
 * @param {Array} metrics [{field, op, alias?}]
 * @returns {Array} 展开后的指标 [{field, op, alias}]
 */
export function expandMetrics(metrics) {
  const out = [];
  for (const m of metrics ?? []) {
    if (m.op === 'avg') {
      out.push({ field: m.field, op: 'sum', alias: `__sum_${m.field}` });
      out.push({ field: m.field, op: 'count', alias: `__cnt_${m.field}` });
    } else {
      out.push({ field: m.field, op: m.op, alias: m.alias ?? null });
    }
  }
  return out;
}

const METRIC_SQL = {
  sum: (col) => `SUM(${col})`,
  count: (col) => `COUNT(${col})`,
  count_distinct: (col) => `COUNT(DISTINCT ${col})`,
  min: (col) => `MIN(${col})`,
  max: (col) => `MAX(${col})`,
};

/** 编译分组聚合（单 target，指标已由 expandMetrics 展开）。 */
export function compileAggregate({ database, table, groupBy, metrics, filters, sort, limit, offset, isolationColumn, isolationValue }) {
  const clean = normalizeIsolation(filters ?? [], isolationColumn, isolationValue);
  const where = buildWhere(clean, isolationColumn, isolationValue);
  const selectParts = [];
  for (const g of groupBy ?? []) selectParts.push(quoteIdent(g));
  for (const m of metrics ?? []) {
    const fn = METRIC_SQL[m.op];
    if (!fn) throw err(OPERATOR_NOT_ALLOWED, `不支持的聚合操作 "${m.op}"`, { op: m.op });
    const col = m.field == null ? '*' : quoteIdent(m.field);
    const expr = m.op === 'count' && m.field == null ? 'COUNT(*)' : fn(col);
    selectParts.push(`${expr} AS ${quoteIdent(m.alias ?? `${m.op}(${m.field})`)}`);
  }
  const groupClause = groupBy?.length ? `GROUP BY ${groupBy.map(quoteIdent).join(', ')}` : null;
  const orderClause = sort?.length ? `ORDER BY ${sort.map((s) => `${quoteIdent(s.field)} ${s.desc ? 'DESC' : 'ASC'}`).join(', ')}` : null;
  const sql = [
    `SELECT ${selectParts.join(', ')}`,
    `FROM ${quoteIdent(database)}.${quoteIdent(table)}`,
    where.clause ? `WHERE ${where.clause}` : null,
    groupClause,
    orderClause,
    `LIMIT ? OFFSET ?`,
  ].filter(Boolean).join('\n');
  return { sql, params: [...where.params, limit, offset] };
}

/** 编译 count_distinct 的每片去重值查询（§7.5.4）。 */
export function compileDistinct({ database, table, field, filters, isolationColumn, isolationValue }) {
  const clean = normalizeIsolation(filters ?? [], isolationColumn, isolationValue);
  const where = buildWhere(clean, isolationColumn, isolationValue);
  const sql = [
    `SELECT DISTINCT ${quoteIdent(field)} AS \`v\``,
    `FROM ${quoteIdent(database)}.${quoteIdent(table)}`,
    where.clause ? `WHERE ${where.clause}` : null,
  ].filter(Boolean).join('\n');
  return { sql, params: where.params };
}

/**
 * 编译分组 count_distinct 的分组去重值对查询：SELECT DISTINCT groupBy..., field。
 * 返回行 = [groupBy 值..., v]。归并层按分组键求值集并集（§7.5.4）。
 */
export function compileDistinctGroup({ database, table, groupBy, field, filters, isolationColumn, isolationValue }) {
  const clean = normalizeIsolation(filters ?? [], isolationColumn, isolationValue);
  const where = buildWhere(clean, isolationColumn, isolationValue);
  const cols = [...groupBy.map((g) => quoteIdent(g)), `${quoteIdent(field)} AS \`v\``];
  const sql = [
    `SELECT DISTINCT ${cols.join(', ')}`,
    `FROM ${quoteIdent(database)}.${quoteIdent(table)}`,
    where.clause ? `WHERE ${where.clause}` : null,
  ].filter(Boolean).join('\n');
  return { sql, params: where.params };
}
