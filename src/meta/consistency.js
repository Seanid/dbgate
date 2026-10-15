// 跨实例 schema 一致性校验（启动期 MUST，§8.3、V10）。
// 对每个业务，抽样各成员实例上的目标分片，比对列名集合与类型，必须包含隔离列。
// - warn（默认）：记日志继续
// - fail：拒绝启动（生产建议）
// 实例不可达：记录警告并跳过该实例（不可达属于运行时状态，不算 schema 漂移）。
import { SCHEMA_MISMATCH, err } from '../errors.js';
import { normalizeAppid } from '../plan/shard.js';
import { splitDatabases } from '../config/schema.js';

const SAMPLE_APPIDS = 2; // 每个实例抽样的 appid 数
const SAMPLE_TABLES_PER_BIZ = 4; // 每个业务抽样的逻辑表数
const OVERALL_BUDGET_MS = 15_000;

/**
 * 执行跨实例 schema 一致性校验。
 * @returns {Promise<{warnings: string[], checked: number}>}
 */
export async function checkConsistency({ config, scope, poolManager, meta, log }) {
  const onMismatch = config.runtime.onSchemaMismatch; // warn | fail
  const isolationColumnGlobal = config.appId.column;
  const appids = (config.appids ?? []); // 由 bootstrap 注入的已知 appid 清单
  const sampleAppids = appids.slice(0, SAMPLE_APPIDS);

  const warnings = [];
  let checked = 0;
  if (sampleAppids.length === 0) {
    log.warn('无已知 appid，跳过跨实例 schema 一致性校验');
    return { warnings, checked };
  }

  // 先并行探测各 (实例, database) 连通性；不可达跳过（记录警告）
  const pairs = [];
  for (const [name, cfg] of Object.entries(config.instances)) {
    for (const database of splitDatabases(cfg)) pairs.push({ instance: name, database });
  }
  const probes = await Promise.all(pairs.map(({ instance, database }) => poolManager.probe(instance, database, { ttlMs: 0 })));
  const connected = new Set(probes.filter((p) => p.connected).map((p) => `${p.instance}\u0000${p.database}`));
  const unreachable = probes.filter((p) => !p.connected)
    .map((p) => `${p.instance}::${p.database}`);
  if (unreachable.length) {
    warnings.push(`实例/库不可达，跳过其 schema 校验：${unreachable.join(', ')}`);
    log.warn({ targets: unreachable }, '实例/库不可达，跳过 schema 校验');
  }
  if (connected.size === 0) {
    log.warn('无可用实例/库，跳过跨实例 schema 一致性校验');
    return { warnings, checked };
  }

  const deadline = Date.now() + OVERALL_BUDGET_MS;

  for (const bizName of Object.keys(config.bizTypes)) {
    if (Date.now() > deadline) { warnings.push('一致性校验超过时间预算，剩余业务未校验'); break; }
    const tables = Object.values(scope.byTable)
      .filter((t) => (t.bizTypes ?? [t.bizType]).includes(bizName))
      .slice(0, SAMPLE_TABLES_PER_BIZ);

    for (const entry of tables) {
      const isolationColumn = entry.appidColumn ?? isolationColumnGlobal;
      const byInstance = new Map(); // "instance::database" -> columns[]

      for (const appid of sampleAppids) {
        const suffix = normalizeAppid(appid);
        const prefix = entry.tablePrefix;
        const physical = entry.sharded ? `${prefix}_${suffix}` : entry.logicalName;
        const targets = entry.instances
          .flatMap((instName) => splitDatabases(config.instances[instName])
            .map((database) => ({ key: `${instName}\u0000${database}`, instName, database })))
          .filter((t) => connected.has(t.key));

        for (const { key, instName, database } of targets) {
          const pool = poolManager.get(instName, database);
          let columns;
          try {
            columns = await meta.loadColumns(pool, database, physical);
          } catch (e) {
            warnings.push(`一致性校验读取失败：${instName}::${database}/${physical} - ${e.code ?? 'DB_ERROR'}`);
            continue;
          }
          checked++;
          const prev = byInstance.get(key);
          if (!prev) {
            byInstance.set(key, columns);
            continue;
          }
          // 同一实例不同抽样 appid 间不做交叉比较（属于正常的分表差异），只做实例/库间比较，
          // 因此这里用首个 appid 的代表结果作为该实例/库的基线。
        }
      }

      // 实例/库间比对（以首个可比较者为基线）
      const entriesArr = [...byInstance.entries()];
      if (entriesArr.length < 2) continue;
      const [baseKey, baseCols] = entriesArr[0];
      const baseName = baseKey.replace('\u0000', '::');
      const baseNames = baseCols.map((c) => c.name);
      const baseTypes = new Map(baseCols.map((c) => [c.name, c.dataType]));
      if (!baseNames.includes(isolationColumn)) {
        const msg = `表 ${entry.tableKey} 实例/库 ${baseName} 缺少隔离列 "${isolationColumn}"（appid 隔离将被击穿）`;
        record(msg);
      }
      for (const [instKey, cols] of entriesArr.slice(1)) {
        const instName = instKey.replace('\u0000', '::');
        const names = cols.map((c) => c.name);
        const types = new Map(cols.map((c) => [c.name, c.dataType]));
        const missing = baseNames.filter((n) => !names.includes(n));
        const extra = names.filter((n) => !baseNames.includes(n));
        const typeDiff = names.filter((n) => names.includes(n) && baseTypes.get(n) !== types.get(n));
        if (!names.includes(isolationColumn)) {
          record(`表 ${entry.tableKey} 实例/库 ${instName} 缺少隔离列 "${isolationColumn}"`);
        }
        if (missing.length) record(`表 ${entry.tableKey} 实例/库 ${instName} 缺少列：${missing.join(', ')}`);
        if (extra.length) record(`表 ${entry.tableKey} 实例/库 ${instName} 多出列：${extra.join(', ')}`);
        if (typeDiff.length) record(`表 ${entry.tableKey} 实例/库 ${instName} 列类型不一致：${typeDiff.join(', ')}`);
      }
    }
  }

  function record(msg) {
    warnings.push(msg);
    if (onMismatch === 'fail') {
      throw err(SCHEMA_MISMATCH, `跨实例 schema 不一致（onSchemaMismatch=fail）：${msg}`);
    }
    log.warn({ mismatch: msg }, '跨实例 schema 不一致');
  }

  return { warnings, checked };
}
