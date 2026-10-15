// ★ 计划器：决议表 → targets[]（§7.1）。
// MUST 为纯函数：给定 config + appid + table，输出恒定，不缓存（C6）。
import { TABLE_NOT_FOUND, PLAN_TOO_BROAD, APPID_INVALID, PARAM_INVALID, err } from '../errors.js';
import { normalizeAppid, validateSuffix } from './shard.js';
import { splitDatabases } from '../config/schema.js';

/**
 * 生成一次查询的全部 target 集合。
 * - fanout：遍历业务/规则的全部成员（目标数 = 成员数）
 * - route：按 bizTypes[x].route 显式映射定位单一成员（目标数 = 1，§7.2）
 * @param {object} deps
 * @param {object} deps.config 已校验配置
 * @param {object} deps.scope  启动期冻结的表路由决议表
 * @param {string} deps.appid
 * @param {string} deps.table  逻辑表名
 */
export function buildPlan({ config, scope, appid, table }) {
  const t = config.tables[table];
  if (!t) throw err(TABLE_NOT_FOUND, `逻辑表 "${table}" 不在配置中`, { table });
  const entry = scope.byTable[table];
  const instances = config.instances;
  const shardSuffix = normalizeAppid(appid);

  // ① 归一化 + 字符集/长度校验（§4.5，分表场景）
  if (entry.sharded) {
    validateSuffix({ appid, prefix: entry.tablePrefix });
  }

  // ②→⑤ 成员 → targets（route 模式按 appid 显式映射定位单一成员）
  let members = entry.members;
  if (entry.traversal === 'route') {
    const route = entry.routeByAppid ?? {};
    const mappedInstance = route[String(appid)];
    if (!mappedInstance) {
      throw err(PARAM_INVALID,
        `业务 "${entry.bizTypes.join(', ')}" 为 route 遍历模式，但 appid "${appid}" 未在路由映射中，无法定位目标实例；` +
        '请检查配置 bizTypes 的 route 映射，或在映射不确定时改用 fanout（宁可多查，不能漏查）',
        { appid, bizType: entry.bizTypes, route });
    }
    members = [{ instance: mappedInstance }];
  }

  // ⑥ 拼物理表名 + 组装 targets（一个实例可绑定多个 database：逗号分隔 → 每库一个 target，均遍历查询）
  const targets = [];
  for (const m of members) {
    const prefix = m.tablePrefix ?? entry.tablePrefix ?? table;
    const physical = entry.sharded ? `${prefix}_${shardSuffix}` : table; // §4.1：sharded=false 直接逻辑表名
    const inst = instances[m.instance];
    for (const database of splitDatabases(inst)) {
      targets.push({
        instance: m.instance,
        database,
        table: physical,
        tablePrefix: prefix,
      });
    }
  }

  // 目标数上限拦截（§7.3）：计划生成后、执行前
  const maxTargets = config.limits.maxTargetsPerQuery;
  if (targets.length > maxTargets) {
    throw err(PLAN_TOO_BROAD,
      `本次查询将访问 ${targets.length} 个目标，超出上限 ${maxTargets}`,
      {
        targetCount: targets.length,
        limit: maxTargets,
        suggestion: '请通过 filters 收窄范围，或在配置中收窄该表的 members',
      });
  }

  return {
    appid,
    table,
    bizType: entry.bizTypes,       // 数组：跨业务遍历的归属业务集合
    traversal: entry.traversal,
    matchedRule: entry.matchedRuleDesc,
    shardSuffix,
    targets,
    targetCount: targets.length,
    estimatedCost: targets.length <= 2 ? 'low' : targets.length <= 6 ? 'medium' : 'high',
    failurePolicy: entry.failurePolicy,
    concurrency: entry.concurrency,
    warnOnMultiHit: entry.warnOnMultiHit,
    sharded: entry.sharded,
    appidColumn: entry.appidColumn,
    mergeTieBreaker: entry.mergeTieBreaker,
    scopeEntry: entry,
  };
}
