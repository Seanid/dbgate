// ★ 查询内核：MCP 与 HTTP 共用的唯一入口（C3）。
// 流程：鉴权上下文 → appid 校验 → 表校验 → 计划 → 字段守卫 → 每 target 编译 → 并行执行 → 归并 → 脱敏 → 审计。
// 校验与脱敏位于内核层（§2.3 MUST）。
import { randomUUID } from 'node:crypto';
import { buildPlan } from '../plan/planner.js';
import { matchesAppid, expandAppids } from '../plan/appidRegistry.js';
import { resolveBizNames } from '../plan/tableScope.js';
import { splitDatabases } from '../config/schema.js';
import {
  buildFieldMap, resolveFields, validateFilters, validateSort, resolveLimitOffset, validateAggregate,
} from './fieldGuard.js';
import {
  compileSelect, compileCount, compileAggregate, expandMetrics, compileDistinctGroup,
} from './compiler.js';
import { runTargets } from './executor.js';
import { mergeRecords, mergeCount, mergeGroupBy } from './merger.js';
import { maskValue } from './mask.js';
import {
  APPID_REQUIRED, APPID_NOT_ALLOWED, APPID_INVALID, TABLE_NOT_FOUND, TABLE_NOT_ALLOWED, BIZ_TYPE_NOT_FOUND,
  PARTIAL_FAILURE, err,
} from '../errors.js';

/** 按字节上限截断 rows（整行丢弃，置 truncated，不报错，§6.5.6）。 */
function truncateByBytes(rows, maxBytes) {
  if (maxBytes <= 0) return { rows: [], truncated: rows.length > 0 };
  const sizes = [];
  let total = 0;
  for (const r of rows) {
    const s = JSON.stringify(r).length;
    sizes.push(s);
    total += s;
  }
  if (total <= maxBytes) return { rows, truncated: false };
  let keep = rows.length;
  while (keep > 0 && total > maxBytes) total -= sizes[--keep];
  return { rows: rows.slice(0, keep), truncated: true };
}

export class QueryCore {
  /**
   * @param {object} deps
   * @param {object} deps.config 已校验配置
   * @param {object} deps.scope 启动期决议表
   * @param {PoolManager} deps.pools
   * @param {MetaService} deps.meta
   * @param {AuditLogger} deps.audit
   * @param {object} deps.log pino
   */
  constructor({ config, scope, pools, meta, audit, log, tokenValidator }) {
    this.config = config;
    this.scope = scope;
    this.pools = pools;
    this.meta = meta;
    this.audit = audit;
    this.log = log;
    // HTTP 路由层与 MCP 工具层共用同一份 token 校验（此处仅托管，校验仍发生在接入层）
    this.tokenValidator = tokenValidator;
  }

  // —— 通用校验 ——

  _assertAppid(ctx, appid) {
    if (appid === undefined || appid === null || String(appid).length === 0) {
      throw err(APPID_REQUIRED, '缺少 appid（必填）');
    }
    const s = String(appid);
    // 先做字符集预检（§4.5）：归一化后不可能合法的 appid 直接拒绝（反引号/点号/中文等），不进 SQL
    if (!/^[a-z0-9_-]+$/i.test(s)) {
      throw err(APPID_INVALID, `appid "${s}" 含非法字符（仅允许字母、数字、-、_）`, { appid: s });
    }
    // 授权匹配支持通配（§8.2）：`*` 全通配、`app_*` 前缀通配、其余精确匹配
    if (!ctx.allowApps.some((p) => matchesAppid(p, s))) {
      throw err(APPID_NOT_ALLOWED, `appid "${s}" 不在当前 token 授权范围`, { appid: s });
    }
    return s;
  }

  _assertTable(ctx, table) {
    if (!this.config.tables[table]) {
      throw err(TABLE_NOT_FOUND, `逻辑表 "${table}" 不在配置中`, { table });
    }
    // 可查表清单与 token 绑定（§8.2）：token.tables 缺省 ["*"] = 全部可查；支持前缀通配
    if (!(ctx.tables ?? ['*']).some((p) => matchesAppid(p, table))) {
      throw err(TABLE_NOT_ALLOWED, `表 "${table}" 不在当前 token 可查表清单`, { table, tables: ctx.tables ?? ['*'] });
    }
  }

  _assertBizType(entry, bizType) {
    if (bizType === undefined || bizType === null) return;
    if (!entry.bizTypes.includes(bizType)) {
      throw err(BIZ_TYPE_NOT_FOUND,
        `传入 bizType "${bizType}" 与表 "${entry.logicalName}" 的归属业务 "${entry.bizTypes.join(', ')}" 不一致`, {
          bizType,
          actualBizType: entry.bizTypes,
          table: entry.logicalName,
        });
    }
  }

  _newCtx(ctx) {
    return {
      actor: ctx?.actor ?? 'unknown',
      allowApps: ctx?.allowApps ?? [],
      tables: ctx?.tables ?? ['*'],
      transport: ctx?.transport ?? 'internal',
      requestId: ctx?.requestId ?? randomUUID(),
    };
  }

  _audit(ctx, entry) {
    try {
      this.audit.write({
        ts: new Date().toISOString(),
        requestId: ctx.requestId,
        actor: ctx.actor,
        transport: ctx.transport,
        ...entry,
      });
    } catch (e) {
      this.log.error({ err: e }, '审计写入失败');
    }
  }

  /** 汇总 target 结果（信封与审计共用）。 */
  _summaries(results) {
    return results.map((r) => ({
      instance: r.instance,
      database: r.database,
      table: r.table,
      ok: r.ok,
      rowCount: r.rowCount,
      elapsedMs: r.elapsedMs,
      ...(r.missingTable ? { missingTable: true } : {}),
      ...(r.error ? { error: r.error } : {}),
    }));
  }

  /** 加载各 target 元数据并做列并集。 */
  async _loadUnionColumns(plan) {
    const perTarget = await Promise.all(plan.targets.map(async (t) => {
      try {
        return { target: t, cols: await this.meta.columns(t.instance, t.database, t.table) };
      } catch (e) {
        return { target: t, cols: [], error: e };
      }
    }));
    const byName = new Map();
    for (const { cols } of perTarget) {
      for (const c of cols) {
        const k = String(c.name).toLowerCase();
        if (!byName.has(k) || byName.get(k).ordinal > c.ordinal) byName.set(k, c);
      }
    }
    return { union: [...byName.values()].sort((a, b) => a.ordinal - b.ordinal), perTarget };
  }

  /** 每 target 的列存在性拆分（缺失列 → NULL AS）。 */
  _splitColumns(cols, perTargetMeta) {
    const byName = new Map((perTargetMeta?.cols ?? []).map((c) => [String(c.name).toLowerCase(), c]));
    const present = [];
    const missing = [];
    for (const c of cols) {
      if (byName.has(String(c).toLowerCase())) present.push(c);
      else missing.push(c);
    }
    return { present, missing };
  }

  /** union 元数据中是否存在指定列（不区分大小写）。 */
  _unionHasColumn(union, col) {
    if (!col) return false;
    const k = String(col).toLowerCase();
    return (union ?? []).some((c) => String(c.name).toLowerCase() === k);
  }

  /**
   * 隔离列解析（§6.5.3）：分表（sharded）恒注入；非分表在表真实存在该列时也注入
   * （全局配置表如 group_config/message_template 带 app_id 列，必须按 appid 过滤），
   * 列不存在则不注入（避免 Unknown column）。
   */
  _resolveIsolationColumn(entry, union) {
    const candidate = entry.appidColumn ?? this.config.appId.column;
    return entry.sharded || this._unionHasColumn(union, candidate) ? candidate : null;
  }

  /**
   * tie-breaker 解析（§7.5.5）：配置显式给定优先；
   * 否则从真实表主键自动取（union 元数据的 isKey 列）；无主键 → []（不追加，避免 Unknown column）。
   */
  _resolveTieBreakers(plan, union) {
    if (Array.isArray(plan.mergeTieBreaker) && plan.mergeTieBreaker.length > 0) {
      return plan.mergeTieBreaker;
    }
    const keys = (union ?? []).filter((c) => c.isKey).map((c) => c.name);
    return keys.length > 0 ? keys : [];
  }

  _applyMasks(rows, columns, fieldMap) {
    const masks = columns.map((c) => fieldMap.get(String(c).toLowerCase())?.mask ?? null);
    if (!masks.some(Boolean)) return rows;
    return rows.map((row) => row.map((v, i) => (masks[i] ? maskValue(masks[i], v) : v)));
  }

  _makeNote(failed) {
    const names = failed.map((r) => r.instance).join(', ');
    const n = failed.length;
    return `注意：本次查询有 ${n} 个实例（${names}）连接失败，以上结果不包含该实例的数据，总量可能偏低。`;
  }

  // —— 对外操作（均返回响应信封 { ok, requestId, data | error }）——

  async listApps(ctx) {
    ctx = this._newCtx(ctx);
    try {
      // 可查 appid 清单与 token 绑定：通配模式在已知 appid 中展开（§8.2）
      const known = this.config.appids ?? [];
      const { apps, note } = expandAppids(ctx.allowApps, known);
      const data = { apps };
      if (note) data.note = note;
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e);
    }
  }

  async listBizTypes(ctx) {
    ctx = this._newCtx(ctx);
    try {
      const bizTypes = Object.entries(this.config.bizTypes).map(([name, b]) => ({
        name,
        traversal: b.traversal ?? 'fanout',
        memberCount: b.members.length,
        instances: b.members.map((m) => m.instance),
        databaseCount: b.members.reduce((sum, m) => sum + splitDatabases(this.config.instances[m.instance]).length, 0),
        failurePolicy: b.failurePolicy ?? 'bestEffort',
      }));
      return { ok: true, requestId: ctx.requestId, data: { bizTypes } };
    } catch (e) {
      return this._error(ctx, e);
    }
  }

  async listTables(ctx, { appid, bizType }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      this._assertAppid(ctx, appid);
      if (bizType !== undefined && bizType !== null && !this.config.bizTypes[bizType]) {
        throw err(BIZ_TYPE_NOT_FOUND, `业务类型 "${bizType}" 不存在`, { bizType });
      }
      // 可查表清单与 token 绑定（§8.2）：按 token.tables 授权展开为实际可查表
      // （["*"] = 全部；order_* = 前缀通配；其余精确匹配），不是全局配置原样返回
      const authorizedTables = ctx.tables ?? ['*'];
      const declared = Object.keys(this.config.tables);
      const visible = authorizedTables.some((p) => matchesAppid(p, '*'))
        ? declared
        : declared.filter((name) => authorizedTables.some((p) => matchesAppid(p, name)));
      const tables = visible
        .filter((name) => {
          const t = this.config.tables[name];
          const bizNames = resolveBizNames(t.bizType, Object.keys(this.config.bizTypes));
          return bizType === undefined || bizType === null || bizNames.includes(bizType);
        })
        .map((name) => {
          const t = this.config.tables[name];
          return {
            table: name,
            bizType: resolveBizNames(t.bizType, Object.keys(this.config.bizTypes)),
            tablePrefix: t.tablePrefix ?? null,
            sharded: t.sharded !== false,
            comment: t.comment ?? null,
          };
        });
      this._audit(ctx, { appid, bizType: bizType ?? null, table: null, op: 'list_tables', ok: true, elapsedMs: Date.now() - t0 });
      return { ok: true, requestId: ctx.requestId, data: { appid, authorizedTables, tables } };
    } catch (e) {
      return this._error(ctx, e);
    }
  }

  async describeTable(ctx, { appid, table }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      const appidS = this._assertAppid(ctx, appid);
      this._assertTable(ctx, table);
      const entry = this.scope.byTable[table];
      this._assertBizType(entry, undefined);
      const plan = buildPlan({ config: this.config, scope: this.scope, appid: appidS, table });
      const { union } = await this._loadUnionColumns(plan);
      // 隔离列：分表恒注入；非分表在表真实存在该列时注入（全局配置表带 app_id 列，必须按 appid 过滤）
      const isolationColumn = this._resolveIsolationColumn(entry, union);
      const fieldMap = buildFieldMap(entry, union);
      const notes = [];
      if (plan.traversal === 'fanout') {
        notes.push(`本表数据分布在 ${entry.members.length} 个实例上，查询将遍历全部实例后归并`);
        notes.push(`遍历模式下 offset 上限收紧为 ${this.config.limits.fanoutMaxOffset}，建议用 filters 收窄范围`);
      }
      if (entry.sharded) {
        notes.push(`物理表名 = ${entry.tablePrefix ?? table}_${plan.shardSuffix}（分表）`);
      }
      if (isolationColumn) {
        notes.push(`隔离列 "${isolationColumn}" 由系统强制注入，无需也不应自行指定`);
      }
      if (plan.traversal === 'fanout' && !(plan.mergeTieBreaker ?? []).includes('_instance')) {
        notes.push('遍历模式下请确认主键全局唯一（雪花/集中式序列），否则跨实例分页可能不稳定；可配置 mergeTieBreaker 含 "_instance"');
      }
      const fields = [...fieldMap.values()]
        .sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || a.name.localeCompare(b.name))
        .map((f) => ({
          name: f.name,
          dataType: f.dataType,
          nullable: f.nullable,
          returnable: f.returnable,
          filterable: f.filterable,
          sortable: f.sortable,
          aggregatable: f.aggregatable,
          locked: f.locked,
          mask: f.mask,
        }));
      const data = {
        table,
        bizType: entry.bizTypes,
        traversal: plan.traversal,
        memberCount: entry.members.length,
        estimatedTargets: plan.targetCount,
        appidColumn: isolationColumn,
        sharded: entry.sharded,
        mergeTieBreaker: this._resolveTieBreakers(plan, union),
        fields,
        notes,
      };
      this._audit(ctx, { appid: appidS, bizType: entry.bizTypes, table, traversal: plan.traversal, op: 'describe_table', ok: true, elapsedMs: Date.now() - t0 });
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e);
    }
  }

  async plan(ctx, { appid, table }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      const appidS = this._assertAppid(ctx, appid);
      this._assertTable(ctx, table);
      const plan = buildPlan({ config: this.config, scope: this.scope, appid: appidS, table });
      // tableExists：按物理表名精确探测（§8.3），失败标 null + error
      const exists = await Promise.all(plan.targets.map(async (t) => {
        try {
          return { instance: t.instance, exists: await this.meta.exists(t.instance, t.database, t.table) };
        } catch {
          return { instance: t.instance, exists: null };
        }
      }));
      const existsMap = new Map(exists.map((e) => [e.instance, e.exists]));
      const targets = plan.targets.map((t) => ({
        instance: t.instance,
        database: t.database,
        table: t.table,
        tableExists: existsMap.get(t.instance) ?? false,
        ...(existsMap.get(t.instance) === null ? { error: 'INSTANCE_UNAVAILABLE' } : {}),
      }));
      const data = {
        appid: appidS,
        table,
        bizType: plan.bizType,
        traversal: plan.traversal,
        matchedRule: plan.matchedRule,
        shardSuffix: plan.shardSuffix,
        targets,
        targetCount: plan.targetCount,
        estimatedCost: plan.estimatedCost,
      };
      this._audit(ctx, { appid: appidS, bizType: plan.bizType, table, traversal: plan.traversal, op: 'plan', ok: true, elapsedMs: Date.now() - t0 });
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e);
    }
  }

  async query(ctx, { appid, table, bizType, fields, filters, sort, limit, offset }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      const appidS = this._assertAppid(ctx, appid);
      this._assertTable(ctx, table);
      const entry = this.scope.byTable[table];
      this._assertBizType(entry, bizType);
      const plan = buildPlan({ config: this.config, scope: this.scope, appid: appidS, table });
      const lo = resolveLimitOffset({ limit, offset, traversal: plan.traversal, limits: this.config.limits });
      const { union, perTarget } = await this._loadUnionColumns(plan);
      // 隔离列：分表恒注入；非分表在表真实存在该列时注入（全局配置表带 app_id 列，必须按 appid 过滤）
      const isolationColumn = this._resolveIsolationColumn(entry, union);
      const isolationValue = isolationColumn
        ? (this.config.appId.filterValue === 'normalized' ? plan.shardSuffix : appidS)
        : undefined;
      const fieldMap = buildFieldMap(entry, union);
      const cols = resolveFields(fields, fieldMap);
      const flts = validateFilters(filters, fieldMap, this.config.limits, isolationColumn);
      const sts = validateSort(sort, fieldMap, this.config.limits);
      const tieBreakers = this._resolveTieBreakers(plan, union);

      const tasks = plan.targets.map((t, i) => {
        const { present, missing } = this._splitColumns(cols, perTarget[i]);
        const { sql, params } = compileSelect({
          database: t.database,
          table: t.table,
          columns: present,
          nullColumns: missing,
          filters: flts,
          sort: sts,
          limit: lo.limit,
          offset: lo.offset,
          isolationColumn,
          isolationValue,
          tieBreakers,
        });
        return { target: t, sql, params, columnNames: cols };
      });

      const results = await runTargets({
        tasks,
        pools: this.pools,
        limits: this.config.limits,
        concurrency: plan.concurrency,
        missingTablePolicy: this.config.missingTablePolicy,
        log: this.log,
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0 && plan.failurePolicy === 'strict') {
        throw err(PARTIAL_FAILURE, `部分目标失败（strict 策略）：${failed.map((r) => r.instance).join(', ')}`,
          { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) });
      }
      const okSlices = results.filter((r) => r.ok);
      const merged = mergeRecords({
        slices: okSlices,
        columns: cols,
        sort: sts,
        tieBreakers,
        useInstanceTie: (plan.mergeTieBreaker ?? []).includes('_instance'),
        offset: lo.offset,
        limit: lo.limit,
      });
      const masked = this._applyMasks(merged.rows, cols, fieldMap);
      const { rows, truncated } = truncateByBytes(masked, this.config.limits.maxResponseBytes);
      const multiHit = plan.warnOnMultiHit && results.filter((r) => r.ok && !r.missingTable && r.rowCount > 0).length > 1;

      const data = {
        appid: appidS,
        bizType: plan.bizType,
        partial: failed.length > 0,
        columns: cols,
        rows,
        rowCount: rows.length,
        truncated,
        hasMore: merged.hasMore,
        elapsedMs: Date.now() - t0,
        ...(failed.length ? { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) } : {}),
        ...(multiHit ? { multiHit: true } : {}),
        ...(failed.length ? { note: this._makeNote(failed) } : {}),
      };
      if (this.config.runtime.exposeTargets) data.targets = this._summaries(results);

      this._audit(ctx, {
        appid: appidS, bizType: plan.bizType, table, traversal: plan.traversal,
        shardSuffix: plan.shardSuffix, targets: this._summaries(results),
        partial: failed.length > 0, multiHit,
        fields: cols, filters: flts, rowCount: rows.length, truncated,
        elapsedMs: Date.now() - t0, ok: true,
      });
      if (multiHit) this.log.warn({ appid: appidS, table, multiHit: true }, '多实例同时命中非空数据（warnOnMultiHit）：数据可能重复或配置错误');
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e, { appid, table });
    }
  }

  async count(ctx, { appid, table, bizType, filters }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      const appidS = this._assertAppid(ctx, appid);
      this._assertTable(ctx, table);
      const entry = this.scope.byTable[table];
      this._assertBizType(entry, bizType);
      const plan = buildPlan({ config: this.config, scope: this.scope, appid: appidS, table });
      const { union } = await this._loadUnionColumns(plan);
      // 隔离列：分表恒注入；非分表在表真实存在该列时注入（全局配置表带 app_id 列，必须按 appid 过滤）
      const isolationColumn = this._resolveIsolationColumn(entry, union);
      const isolationValue = isolationColumn
        ? (this.config.appId.filterValue === 'normalized' ? plan.shardSuffix : appidS)
        : undefined;
      const fieldMap = buildFieldMap(entry, union);
      const flts = validateFilters(filters, fieldMap, this.config.limits, isolationColumn);

      const tasks = plan.targets.map((t) => {
        const { sql, params } = compileCount({
          database: t.database, table: t.table, filters: flts, isolationColumn, isolationValue,
        });
        return { target: t, sql, params, columnNames: ['cnt'] };
      });
      const results = await runTargets({
        tasks, pools: this.pools, limits: this.config.limits, concurrency: plan.concurrency,
        missingTablePolicy: this.config.missingTablePolicy, log: this.log,
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0 && plan.failurePolicy === 'strict') {
        throw err(PARTIAL_FAILURE, `部分目标失败（strict 策略）：${failed.map((r) => r.instance).join(', ')}`,
          { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) });
      }
      const total = mergeCount(results.filter((r) => r.ok));
      const data = {
        appid: appidS,
        bizType: plan.bizType,
        partial: failed.length > 0,
        count: total,
        elapsedMs: Date.now() - t0,
        ...(failed.length ? { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) } : {}),
        ...(failed.length ? { note: this._makeNote(failed) } : {}),
      };
      if (this.config.runtime.exposeTargets) data.targets = this._summaries(results);
      this._audit(ctx, {
        appid: appidS, bizType: plan.bizType, table, traversal: plan.traversal,
        shardSuffix: plan.shardSuffix, targets: this._summaries(results),
        partial: failed.length > 0, multiHit: false,
        fields: null, filters: flts, rowCount: total, truncated: false,
        elapsedMs: Date.now() - t0, ok: true,
      });
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e, { appid, table });
    }
  }

  async aggregate(ctx, { appid, table, bizType, filters, groupBy, metrics, sort, limit, offset }) {
    ctx = this._newCtx(ctx);
    const t0 = Date.now();
    try {
      const appidS = this._assertAppid(ctx, appid);
      this._assertTable(ctx, table);
      const entry = this.scope.byTable[table];
      this._assertBizType(entry, bizType);
      const plan = buildPlan({ config: this.config, scope: this.scope, appid: appidS, table });
      const lo = resolveLimitOffset({ limit, offset, traversal: plan.traversal, limits: this.config.limits });
      const { union } = await this._loadUnionColumns(plan);
      // 隔离列：分表恒注入；非分表在表真实存在该列时注入（全局配置表带 app_id 列，必须按 appid 过滤）
      const isolationColumn = this._resolveIsolationColumn(entry, union);
      const isolationValue = isolationColumn
        ? (this.config.appId.filterValue === 'normalized' ? plan.shardSuffix : appidS)
        : undefined;
      const fieldMap = buildFieldMap(entry, union);
      const flts = validateFilters(filters, fieldMap, this.config.limits, isolationColumn);
      const agg = validateAggregate({ groupBy, metrics, sort, fieldMap, limits: this.config.limits });
      const expanded = expandMetrics(agg.metrics); // avg → __sum_ + __cnt_
      const distinctMetrics = agg.metrics.filter((m) => m.op === 'count_distinct');

      const groupTasks = plan.targets.map((t) => {
        const { sql, params } = compileAggregate({
          database: t.database, table: t.table,
          groupBy: agg.groupBy, metrics: expanded, filters: flts,
          sort: agg.sort, limit: lo.limit, offset: lo.offset,
          isolationColumn, isolationValue,
        });
        return { target: t, sql, params, columnNames: [...agg.groupBy, ...expanded.map((m) => m.alias)] };
      });
      // count_distinct：独立的分组去重值对查询（不能下推 COUNT(DISTINCT)）
      const distinctTasks = [];
      for (const dm of distinctMetrics) {
        for (const t of plan.targets) {
          const { sql, params } = compileDistinctGroup({
            database: t.database, table: t.table,
            groupBy: agg.groupBy, field: dm.field, filters: flts,
            isolationColumn, isolationValue,
          });
          distinctTasks.push({ target: t, sql, params, columnNames: [...agg.groupBy, 'v'], metric: dm });
        }
      }

      const allTasks = [...groupTasks, ...distinctTasks];
      const results = await runTargets({
        tasks: allTasks,
        pools: this.pools,
        limits: this.config.limits,
        concurrency: plan.concurrency,
        missingTablePolicy: this.config.missingTablePolicy,
        log: this.log,
      });
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0 && plan.failurePolicy === 'strict') {
        throw err(PARTIAL_FAILURE, `部分目标失败（strict 策略）：${failed.map((r) => r.instance).join(', ')}`,
          { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) });
      }
      const okAll = results.filter((r) => r.ok);
      // runTargets 的结果数组与 allTasks 按下标一一对应（executor 按 next++ 写入 results[i]）
      const groupResults = results.slice(0, groupTasks.length);
      const distinctResults = results.slice(groupTasks.length);
      // 按 metric 切分 distinct 结果（distinctTasks 顺序 = distinctMetrics × targets）
      const distinctByMetric = new Map();
      distinctTasks.forEach((task, i) => {
        const alias = task.metric.alias ?? `count_distinct(${task.metric.field})`;
        if (!distinctByMetric.has(alias)) distinctByMetric.set(alias, { slices: [] });
        distinctByMetric.get(alias).slices.push(distinctResults[i]);
      });
      const merged = mergeGroupBy({
        slices: groupResults,
        columns: [...agg.groupBy, ...expanded.map((m) => m.alias)],
        groupBy: agg.groupBy,
        metrics: agg.metrics,
        maxDistinctCardinality: this.config.limits.maxDistinctCardinality,
        sort: agg.sort,
        limit: lo.limit,
        offset: lo.offset,
        distinct: [...distinctByMetric.values()],
      });
      const { rows, truncated } = truncateByBytes(merged.rows, this.config.limits.maxResponseBytes);
      const data = {
        appid: appidS,
        bizType: plan.bizType,
        partial: failed.length > 0,
        columns: merged.columns,
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Date.now() - t0,
        ...(failed.length ? { failedTargets: failed.map((r) => ({ instance: r.instance, database: r.database, table: r.table, error: r.error })) } : {}),
        ...(failed.length ? { note: this._makeNote(failed) } : {}),
      };
      if (this.config.runtime.exposeTargets) data.targets = this._summaries(results);
      this._audit(ctx, {
        appid: appidS, bizType: plan.bizType, table, traversal: plan.traversal,
        shardSuffix: plan.shardSuffix, targets: this._summaries(results),
        partial: failed.length > 0, multiHit: false,
        fields: null, filters: flts, rowCount: rows.length, truncated,
        elapsedMs: Date.now() - t0, ok: true,
      });
      return { ok: true, requestId: ctx.requestId, data };
    } catch (e) {
      return this._error(ctx, e, { appid, table });
    }
  }

  _error(ctx, e, extra = {}) {
    const code = e?.code ?? 'DB_ERROR';
    // DB_ERROR 原始信息只进日志，不透传（§6.4）
    const message = code === 'DB_ERROR' ? '数据库侧报错，请查看服务端日志' : (e?.message ?? '未知错误');
    this._audit(ctx, {
      ...extra,
      op: extra.op,
      ok: false,
      errorCode: code,
      errorMessage: code === 'DB_ERROR' ? undefined : message,
      elapsedMs: 0,
    });
    return {
      ok: false,
      requestId: ctx.requestId,
      error: {
        code,
        message,
        ...(e?.details ? { details: e.details } : {}),
      },
    };
  }
}
