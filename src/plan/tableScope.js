// ★ 表路由求值 → 决议表（启动冻结，§5）。
// 回答“哪类表名，去哪几个实例遍历查”。规则只在已声明的 tables 上求值（§5.6）。
import { TABLE_ROUTE_CONFLICT, TABLE_ROUTE_EMPTY, err } from '../errors.js';

/**
 * 通配符语义（§5.3）：`%` = 任意长度（含 0）任意字符；`_` 是普通字符，不是通配符。
 * 不支持 ? / [] / 正则。比较前双方统一转小写。
 * MUST NOT 使用 SQL LIKE 语义。
 */
export function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*');
  return new RegExp(`^${escaped}$`, 'i'); // 大小写不敏感（表名比较前统一小写）
}

export function matchesPattern(tableKey, pattern) {
  return patternToRegex(pattern).test(String(tableKey));
}

/**
 * 解析业务归属：支持逗号分隔多业务（"user,loan"）或单值（"user"），
 * 统一归一化为数组（§5.1：同一逻辑表可在多个业务下有同名物理表，需跨业务遍历）。
 * bizType 缺省（undefined/空）时返回 fallback（调用方传全部业务名）。
 */
export function resolveBizNames(bizType, fallback = []) {
  if (bizType === undefined || bizType === null || String(bizType).trim() === '') {
    return [...fallback];
  }
  const names = String(bizType).split(',').map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? names : [...fallback];
}

/**
 * 构建表路由决议表（§5.5）。
 * - 对全部已声明表求值一次：tableKey = tables[x].tablePrefix ?? 逻辑表名
 * - 实例范围三级优先级：tables[x].members > tableRoutes 首个命中 > bizTypes.members（逐级覆盖，不合并）
 * - traversal / failurePolicy / concurrency 各自独立解析（规则提供了就用，否则下沉到业务）
 * - 检测 TABLE_ROUTE_CONFLICT（同表多条规则命中）与 TABLE_ROUTE_EMPTY（规则零命中），默认拒绝启动
 *
 * @param {object} config 已通过 schema 校验的配置
 * @returns {{ byTable: Object, frozenAt: string }}
 */
export function buildTableScope(config) {
  const { tables, tableRoutes, bizTypes, limits } = config;
  const byTable = {};
  const ruleHitCounts = new Array(tableRoutes.length).fill(0);

  for (const [logicalName, t] of Object.entries(tables)) {
    const tableKey = t.tablePrefix ?? logicalName;
    // 归属业务可能为多值（"user,loan"）或缺省（= 全部业务）：成员按各业务并集合并（同实例去重），
    // 执行策略（traversal/failurePolicy/concurrency/warnOnMultiHit）取首个业务（建议各业务保持一致）
    const bizNames = resolveBizNames(t.bizType, Object.keys(bizTypes));
    const bizList = bizNames.map((n) => bizTypes[n]);
    const primaryBiz = bizList[0];

    // 求值：命中全部规则（用于冲突检测）与首个命中（用于解析）
    const hits = [];
    tableRoutes.forEach((rule, idx) => {
      if (matchesPattern(tableKey, rule.match)) hits.push(idx);
    });

    if (hits.length > 1) {
      throw err(TABLE_ROUTE_CONFLICT,
        `表路由冲突：表 "${tableKey}" 同时被 ${hits.map((h) => `tableRoutes[${h}] · ${tableRoutes[h].match}`).join('、')} 命中，` +
        '结果取决于书写顺序，顺序一改行为就变。请收敛为一条规则');
    }
    const matchedRuleIdx = hits.length === 1 ? hits[0] : null;
    if (matchedRuleIdx !== null) ruleHitCounts[matchedRuleIdx]++;

    // 三级优先级：成员范围（逐级覆盖，不做合并，§5.4）
    let members = null;
    if (Array.isArray(t.members) && t.members.length > 0) {
      members = t.members;
    } else if (matchedRuleIdx !== null) {
      const rule = tableRoutes[matchedRuleIdx];
      if (Array.isArray(rule.members) && rule.members.length > 0) {
        members = rule.members;
      } else {
        members = bizTypes[rule.bizType].members;
      }
    } else {
      // 多业务：各归属业务成员并集，按实例名去重（实例 = 库，重复只查一次）
      members = bizList.flatMap((b) => b.members)
        .filter((m, i, arr) => arr.findIndex((x) => x.instance === m.instance) === i);
    }

    // traversal / failurePolicy / concurrency 各自独立解析
    const rule = matchedRuleIdx !== null ? tableRoutes[matchedRuleIdx] : null;
    const traversal = rule?.traversal ?? primaryBiz.traversal ?? 'fanout';
    const failurePolicy = rule?.failurePolicy ?? primaryBiz.failurePolicy ?? 'bestEffort';
    const concurrency = rule?.concurrency ?? primaryBiz.concurrency ?? limits.maxConcurrency;
    const warnOnMultiHit = primaryBiz.warnOnMultiHit ?? false;
    // route 遍历映射：多业务时合并各归属业务的 route 映射（声明顺序后者覆盖）
    const routeByAppid = Object.assign({}, ...bizList.map((b) => b.route ?? {}));

    byTable[logicalName] = {
      logicalName,
      tableKey,
      tablePrefix: t.tablePrefix ?? null,
      bizType: t.bizType,
      bizTypes: bizNames,               // 数组：跨业务遍历依据
      traversal,
      failurePolicy,
      concurrency,
      warnOnMultiHit,
      members,
      instances: members.map((m) => m.instance),
      matchedRule: matchedRuleIdx !== null ? matchedRuleIdx : null,
      matchedRuleDesc: rule ? `tableRoutes[${matchedRuleIdx}] · ${rule.match}` : null,
      sharded: t.sharded !== false,
      appidColumn: t.appidColumn ?? null, // null → 使用全局 appId.column
      defaultFields: t.defaultFields ?? null,
      mergeTieBreaker: t.mergeTieBreaker ?? null, // null → 运行时从真实表主键自动解析（§7.5.5）
      fields: t.fields ?? {},
      routeByAppid: Object.keys(routeByAppid).length > 0 ? routeByAppid : null,
    };
  }

  // 零命中检测（§5.5）：规则命中 0 张已声明表 → 大概率模式写错（最常见：把 `_` 当通配符）
  for (let i = 0; i < tableRoutes.length; i++) {
    if (ruleHitCounts[i] === 0) {
      throw err(TABLE_ROUTE_EMPTY,
        `表路由规则零命中：tableRoutes[${i}] · "${tableRoutes[i].match}" 未命中任何已声明表。` +
        '请检查模式是否写错（注意 `_` 是普通字符而非通配符），或表是否已加入 tables');
    }
  }

  return {
    byTable,
    frozenAt: new Date().toISOString(),
  };
}

/** 把决议表格式化为启动日志/CLI 可读的文本。 */
export function formatScope(scope) {
  const rows = [];
  for (const t of Object.values(scope.byTable)) {
    rows.push(
      `${t.tableKey.padEnd(24)} ${(t.matchedRuleDesc ?? '(无，回落业务)').padEnd(24)} ${t.instances.join(', ')}`,
    );
  }
  return rows.join('\n');
}
