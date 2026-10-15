// 字段守卫（§3.3、§6.5.6）：字段权限解析 + 入参校验。
// 未声明的列按 MySQL 元数据推导，权限取“全允许”（§3.3 MUST）。
import { FIELD_NOT_ALLOWED, OPERATOR_NOT_ALLOWED, PARAM_INVALID, LIMIT_EXCEEDED, err } from '../errors.js';
import { SUPPORTED_OPS } from './compiler.js';

/**
 * 合并字段定义：配置覆盖 + 元数据推导。
 * 返回 Map<小写名, fieldDef>，fieldDef.name 为**配置/元数据中的原始字符串**（C4：SQL 只出现配置原文）。
 */
export function buildFieldMap(tableConfig, metaColumns) {
  const map = new Map();
  for (const mc of metaColumns ?? []) {
    map.set(mc.name.toLowerCase(), {
      name: mc.name,
      dataType: mc.dataType,
      nullable: mc.nullable,
      ordinal: mc.ordinal,
      returnable: true,
      filterable: true,
      sortable: true,
      aggregatable: true,
      locked: false,
      mask: null,
    });
  }
  for (const [name, cfg] of Object.entries(tableConfig.fields ?? {})) {
    const key = String(name).toLowerCase();
    const base = map.get(key) ?? {
      name, dataType: null, nullable: true, ordinal: map.size + 1,
      returnable: true, filterable: true, sortable: true, aggregatable: true,
      locked: false, mask: null,
    };
    map.set(key, {
      ...base,
      name,
      returnable: cfg.returnable ?? true,
      filterable: cfg.filterable ?? true,
      sortable: cfg.sortable ?? true,
      aggregatable: cfg.aggregatable ?? true,
      locked: cfg.locked ?? false,
      mask: cfg.mask ?? null,
    });
  }
  return map;
}

function lookup(fieldMap, field) {
  if (typeof field !== 'string' || field.length === 0) return null;
  return fieldMap.get(field.toLowerCase()) ?? null;
}

/**
 * 解析 fields：省略或 ["*"] → 全部 returnable 字段（按 ORDINAL_POSITION 稳定排序，§8.4）。
 * 返回规范列名数组。
 */
export function resolveFields(fields, fieldMap) {
  if (fields === undefined || fields === null ||
      (Array.isArray(fields) && fields.length === 1 && fields[0] === '*') ||
      (typeof fields === 'string' && fields === '*')) {
    return [...fieldMap.values()]
      .filter((f) => f.returnable)
      .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.name.localeCompare(b.name))
      .map((f) => f.name);
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw err(PARAM_INVALID, 'fields 必须为非空数组或 "*"', { fields });
  }
  const out = [];
  for (const f of fields) {
    const def = lookup(fieldMap, f);
    if (!def) throw err(FIELD_NOT_ALLOWED, `字段 "${f}" 不存在`, { field: f });
    if (!def.returnable) throw err(FIELD_NOT_ALLOWED, `字段 "${f}" 不允许返回`, { field: f });
    out.push(def.name);
  }
  return out;
}

/**
 * 校验 filters（§6.5.4、§6.5.6）。返回规范化后的过滤器（字段名用配置原文）。
 * @param {Array} filters
 * @param {Map} fieldMap
 * @param {object} limits
 * @param {string} [isolationColumn] 允许 Agent 以 eq/in 指定隔离列（后续由编译器规范化）
 */
export function validateFilters(filters, fieldMap, limits, isolationColumn) {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters)) throw err(PARAM_INVALID, 'filters 必须为数组', { filters });
  if (filters.length > limits.maxFilters) {
    throw err(PARAM_INVALID, `filters 数量 ${filters.length} 超过上限 ${limits.maxFilters}`, { count: filters.length, limit: limits.maxFilters });
  }
  const out = [];
  filters.forEach((f, i) => {
    if (!f || typeof f !== 'object') throw err(PARAM_INVALID, `filters[${i}] 结构非法`, { index: i });
    const { field, op } = f;
    const def = lookup(fieldMap, field);
    if (!def) throw err(FIELD_NOT_ALLOWED, `过滤字段 "${field}" 不存在`, { field, index: i });
    const isIsolation = String(field).toLowerCase() === String(isolationColumn ?? '').toLowerCase();
    if (def.locked && !isIsolation) {
      throw err(FIELD_NOT_ALLOWED, `字段 "${field}" 为系统锁定字段，不得自行指定`, { field, index: i });
    }
    if (!def.filterable && !isIsolation) {
      throw err(FIELD_NOT_ALLOWED, `字段 "${field}" 不允许过滤`, { field, index: i });
    }
    if (!SUPPORTED_OPS.includes(op)) {
      throw err(OPERATOR_NOT_ALLOWED, `不支持的操作符 "${op}"`, { op, index: i });
    }
    const value = f.value;
    switch (op) {
      case 'in':
      case 'not_in': {
        if (!Array.isArray(value) || value.length === 0) {
          throw err(PARAM_INVALID, `filters[${i}].value 必须为非空数组`, { index: i });
        }
        if (value.length > limits.maxInValues) {
          throw err(PARAM_INVALID, `IN 元素数 ${value.length} 超过上限 ${limits.maxInValues}`, { count: value.length, limit: limits.maxInValues });
        }
        break;
      }
      case 'between': {
        if (!Array.isArray(value) || value.length !== 2) {
          throw err(PARAM_INVALID, `filters[${i}].value 必须为二元数组 [min, max]`, { index: i });
        }
        break;
      }
      case 'like': {
        const s = String(value ?? '');
        if (s.startsWith('%')) {
          // 禁止前导通配符：%abc 无法用索引，fanout 下代价被实例数放大（§6.5.4）
          throw err(OPERATOR_NOT_ALLOWED, `like 禁止前导通配符，只接受 "abc%" 形式`, { value: s, index: i });
        }
        break;
      }
      case 'is_null':
      case 'not_null':
        break; // 忽略 value
      default:
        if (value === undefined || value === null) {
          throw err(PARAM_INVALID, `filters[${i}] 缺少 value`, { index: i, op });
        }
    }
    out.push({ field: def.name, op, value });
  });
  return out;
}

/**
 * 校验 sort（§6.5.6）。返回规范化后的排序键。
 */
export function validateSort(sort, fieldMap, limits) {
  if (sort === undefined || sort === null) return [];
  if (!Array.isArray(sort)) throw err(PARAM_INVALID, 'sort 必须为数组', { sort });
  if (sort.length > limits.maxSortKeys) {
    throw err(PARAM_INVALID, `sort 键个数 ${sort.length} 超过上限 ${limits.maxSortKeys}`, { count: sort.length, limit: limits.maxSortKeys });
  }
  const out = [];
  sort.forEach((s, i) => {
    if (!s || typeof s !== 'object') throw err(PARAM_INVALID, `sort[${i}] 结构非法`, { index: i });
    const def = lookup(fieldMap, s.field);
    if (!def) throw err(FIELD_NOT_ALLOWED, `排序字段 "${s.field}" 不存在`, { field: s.field, index: i });
    if (!def.sortable) throw err(FIELD_NOT_ALLOWED, `字段 "${s.field}" 不允许排序`, { field: s.field, index: i });
    out.push({ field: def.name, desc: !!s.desc });
  });
  return out;
}

/**
 * 校验 limit/offset（§6.5.6、§7.5.3）：
 * - limit > maxRows → PARAM_INVALID（缺省取 defaultRows）
 * - offset 超上限 → LIMIT_EXCEEDED（fanout 下收紧为 fanoutMaxOffset，附“请用 filters 收窄范围”）
 */
export function resolveLimitOffset({ limit, offset, traversal, limits }) {
  let l = limit;
  let o = offset;
  if (l === undefined || l === null) l = limits.defaultRows;
  if (o === undefined || o === null) o = 0;
  if (!Number.isInteger(l) || l <= 0) throw err(PARAM_INVALID, `limit 必须为正整数，收到 ${JSON.stringify(limit)}`, { limit });
  if (!Number.isInteger(o) || o < 0) throw err(PARAM_INVALID, `offset 必须为非负整数，收到 ${JSON.stringify(offset)}`, { offset });
  if (l > limits.maxRows) {
    throw err(PARAM_INVALID, `limit ${l} 超过上限 ${limits.maxRows}`, { limit: l, max: limits.maxRows });
  }
  const cap = traversal === 'fanout' ? limits.fanoutMaxOffset : limits.maxOffset;
  if (o > cap) {
    const details = traversal === 'fanout'
      ? { offset: o, limit: cap, suggestion: '请用 filters 收窄范围，或用时间条件分页' }
      : { offset: o, limit: cap };
    throw err(LIMIT_EXCEEDED,
      traversal === 'fanout'
        ? `遍历模式下 offset ${o} 超过上限 ${cap}；请用 filters 收窄范围`
        : `offset ${o} 超过上限 ${cap}`,
      details);
  }
  return { limit: l, offset: o };
}

/**
 * 校验聚合入参（groupBy + metrics + sort）。
 * @returns {{ groupBy: string[], metrics: Array }}
 */
export function validateAggregate({ groupBy, metrics, sort, fieldMap, limits }) {
  if (!Array.isArray(groupBy) || groupBy.length === 0) {
    throw err(PARAM_INVALID, 'groupBy 必须为非空数组', { groupBy });
  }
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw err(PARAM_INVALID, 'metrics 必须为非空数组', { metrics });
  }
  const gb = groupBy.map((g) => {
    const def = lookup(fieldMap, g);
    if (!def || !def.returnable) throw err(FIELD_NOT_ALLOWED, `分组字段 "${g}" 不允许`, { field: g });
    return def.name;
  });
  const ms = metrics.map((m, i) => {
    if (!m || typeof m !== 'object') throw err(PARAM_INVALID, `metrics[${i}] 结构非法`, { index: i });
    const def = m.field == null ? null : lookup(fieldMap, m.field);
    if (m.field != null && !def) throw err(FIELD_NOT_ALLOWED, `聚合字段 "${m.field}" 不存在`, { field: m.field });
    if (m.field != null && def && !def.aggregatable) throw err(FIELD_NOT_ALLOWED, `字段 "${m.field}" 不允许聚合`, { field: m.field });
    if (!['sum', 'avg', 'min', 'max', 'count', 'count_distinct'].includes(m.op)) {
      throw err(OPERATOR_NOT_ALLOWED, `不支持的聚合操作 "${m.op}"`, { op: m.op });
    }
    return { field: def?.name ?? null, op: m.op, alias: m.alias ?? null };
  });
  const st = validateSort(sort ?? [], fieldMap, limits);
  // 聚合排序只允许 groupBy 字段（安全且可预测）
  for (const s of st) {
    if (!gb.includes(s.field)) {
      throw err(FIELD_NOT_ALLOWED, `聚合查询的排序字段 "${s.field}" 必须属于 groupBy`, { field: s.field });
    }
  }
  return { groupBy: gb, metrics: ms, sort: st };
}
