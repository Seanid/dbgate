// 计划生成确定性（§7.1）：给定 config + appid + table，输出恒定，不缓存（C6）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../src/plan/planner.js';
import { buildTableScope } from '../src/plan/tableScope.js';
import { makeConfig } from './helpers.js';
import { PLAN_TOO_BROAD, APPID_INVALID, TABLE_NOT_FOUND, PARAM_INVALID } from '../src/errors.js';
import { splitDatabases } from '../src/config/schema.js';

function setup(overrides = {}) {
  const config = makeConfig(overrides);
  const scope = buildTableScope(config);
  return { config, scope };
}

test('fanout：orders → 3 个 target，实例正确（T19）', () => {
  const { config, scope } = setup();
  const plan = buildPlan({ config, scope, appid: 'app_1001', table: 'orders' });
  assert.equal(plan.targetCount, 3);
  assert.deepEqual(plan.targets.map((t) => t.instance), ['shard-a', 'shard-b', 'shard-c']);
  for (const t of plan.targets) {
    assert.equal(t.database, 'app_prod');
    assert.equal(t.table, 'orders_app_1001');
  }
  assert.equal(plan.traversal, 'fanout');
  assert.equal(plan.estimatedCost, 'medium');
});

test('物理表名归一化：ADPOA-KE → user_loan_summary_adpoa_ke（T11）', () => {
  const { config, scope } = setup();
  const plan = buildPlan({ config, scope, appid: 'ADPOA-KE', table: 'user_loan_summary' });
  assert.equal(plan.shardSuffix, 'adpoa_ke');
  for (const t of plan.targets) assert.equal(t.table, 'user_loan_summary_adpoa_ke');
});

test('确定性：同一输入两次调用输出完全一致（T12、C6）', () => {
  const { config, scope } = setup();
  const p1 = buildPlan({ config, scope, appid: 'app_1001', table: 'orders' });
  const p2 = buildPlan({ config, scope, appid: 'app_1001', table: 'orders' });
  assert.equal(JSON.stringify(p1), JSON.stringify(p2));
});

test('表级 members 覆盖：order_summary → 仅 shard-a（T20）', () => {
  const { config, scope } = setup();
  const plan = buildPlan({ config, scope, appid: 'app_1001', table: 'order_summary' });
  assert.equal(plan.targetCount, 1);
  assert.equal(plan.targets[0].instance, 'shard-a');
});

test('sharded=false：直接用逻辑表名，不做归一化（§4.1）', () => {
  const { config, scope } = setup();
  const plan = buildPlan({ config, scope, appid: 'adpoa-ke', table: 'global_config' });
  assert.equal(plan.targets[0].table, 'global_config');
  assert.equal(plan.sharded, false);
});

test('route：payment 业务按 appid 定位单一实例（T29）', () => {
  const { config, scope } = setup();
  const p1 = buildPlan({ config, scope, appid: 'adpoa-ke', table: 'report_daily' });
  assert.equal(p1.targetCount, 1);
  assert.equal(p1.targets[0].instance, 'shard-a');
  const p2 = buildPlan({ config, scope, appid: 'adpoa-sz', table: 'report_daily' });
  assert.equal(p2.targets[0].instance, 'shard-b');
  assert.equal(p2.traversal, 'route');
});

test('route：未映射 appid → 拒绝（PARAM_INVALID，不静默漏数据，§7.2）', () => {
  const { config, scope } = setup();
  assert.throws(
    () => buildPlan({ config, scope, appid: 'app_1001', table: 'report_daily' }),
    (e) => e.code === PARAM_INVALID && /route/.test(e.message),
  );
});

test('目标数上限：20 个成员 → PLAN_TOO_BROAD，含 suggestion（T28、§7.3）', () => {
  const instances = {};
  const members = [];
  for (let i = 0; i < 20; i++) {
    const name = `s-${i}`;
    instances[name] = { host: '10.0.0.1', port: 3306, user: 'u', password: 'p', database: 'app_prod' };
    members.push({ instance: name });
  }
  const { config, scope } = setup({
    instances,
    tableRoutes: [],
    bizTypes: { order: { traversal: 'fanout', members, failurePolicy: 'bestEffort' } },
    tables: { wide: { bizType: 'order' } },
  });
  assert.throws(() => buildPlan({ config, scope, appid: 'app_1001', table: 'wide' }), (e) => {
    assert.equal(e.code, PLAN_TOO_BROAD);
    assert.equal(e.details.targetCount, 20);
    assert.equal(e.details.limit, 16);
    assert.match(e.details.suggestion, /filters/);
    return true;
  });
});

test('非法 appid：65 字符 → APPID_INVALID，报错含实际长度（T15）', () => {
  const { config, scope } = setup();
  const longAppid = 'a'.repeat(60); // prefix 'orders'=6 + 1 + 60 = 67 > 64
  assert.throws(() => buildPlan({ config, scope, appid: longAppid, table: 'orders' }), (e) => {
    assert.equal(e.code, APPID_INVALID);
    assert.match(e.message, /长度 67 超过上限 64/);
    return true;
  });
});

test('非法 appid：含非法字符 → APPID_INVALID，不进 SQL（T14）', () => {
  const { config, scope } = setup();
  assert.throws(() => buildPlan({ config, scope, appid: 'a`b', table: 'orders' }), (e) => e.code === APPID_INVALID);
});

test('表不存在 → TABLE_NOT_FOUND（T07）', () => {
  const { config, scope } = setup();
  assert.throws(() => buildPlan({ config, scope, appid: 'app_1001', table: 'mysql.user' }), (e) => e.code === TABLE_NOT_FOUND);
});

test('member.tablePrefix 覆盖 table.tablePrefix 覆盖逻辑表名（§4.1 优先级）', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    bizTypes: {
      arch: { traversal: 'fanout', members: [{ instance: 'shard-a', tablePrefix: 'mem_prefix' }] },
    },
    tables: { t1: { bizType: 'arch', tablePrefix: 'tab_prefix' } },
  });
  const scope = buildTableScope(cfg);
  const plan = buildPlan({ config: cfg, scope, appid: 'app_1001', table: 't1' });
  assert.equal(plan.targets[0].table, 'mem_prefix_app_1001');
});

test('跨业务 fanout：bizType="order,order_archive" → 并集 4 个 target，plan.bizType 为数组', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    tables: { cross: { bizType: 'order,order_archive', tablePrefix: 'cross' } },
  });
  const scope = buildTableScope(cfg);
  const plan = buildPlan({ config: cfg, scope, appid: 'app_1001', table: 'cross' });
  assert.deepEqual(plan.bizType, ['order', 'order_archive']);
  assert.equal(plan.targetCount, 4);
  assert.deepEqual(plan.targets.map((t) => t.instance), ['shard-a', 'shard-b', 'shard-c', 'archive-1']);
  // §4.1 前缀优先级：member.tablePrefix(orders_arch) > table.tablePrefix(cross) > 逻辑表名
  assert.deepEqual(
    plan.targets.map((t) => t.table),
    ['cross_app_1001', 'cross_app_1001', 'cross_app_1001', 'orders_arch_app_1001'],
  );
});

test('实例多 database：database="db1,db2" → 每库一个 target（逗号分隔遍历查询，§3.2）', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    instances: {
      'shard-a': { host: '10.0.0.11', port: 3306, user: 'agent_ro', password: 'x', database: 'app_prod,app_archive', connectionLimit: 8, lazy: false },
    },
    bizTypes: { order: { traversal: 'fanout', members: [{ instance: 'shard-a' }], failurePolicy: 'bestEffort' } },
    tables: { orders: { bizType: 'order', tablePrefix: 'orders', sharded: true } },
  });
  const scope = buildTableScope(cfg);
  const plan = buildPlan({ config: cfg, scope, appid: 'app_1001', table: 'orders' });
  assert.equal(plan.targetCount, 2);
  assert.deepEqual(
    plan.targets.map((t) => `${t.instance}:${t.database}`),
    ['shard-a:app_prod', 'shard-a:app_archive'],
  );
  // 物理表名不因库而异
  assert.deepEqual(plan.targets.map((t) => t.table), ['orders_app_1001', 'orders_app_1001']);
});

test('实例多 database + 多成员 → 目标数 = 成员数 × 库数；maxTargetsPerQuery 在其后拦截', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    instances: {
      'shard-a': { host: '10.0.0.11', port: 3306, user: 'u', password: 'p', database: 'db1,db2,db3' },
      'shard-b': { host: '10.0.0.12', port: 3306, user: 'u', password: 'p', database: 'db1,db2' },
    },
    bizTypes: { order: { traversal: 'fanout', members: [{ instance: 'shard-a' }, { instance: 'shard-b' }], failurePolicy: 'bestEffort' } },
    tables: { orders: { bizType: 'order', tablePrefix: 'orders' } },
  });
  const scope = buildTableScope(cfg);
  const plan = buildPlan({ config: cfg, scope, appid: 'app_1001', table: 'orders' });
  assert.equal(plan.targetCount, 5); // 3 + 2
  assert.deepEqual(
    plan.targets.map((t) => `${t.instance}:${t.database}`),
    ['shard-a:db1', 'shard-a:db2', 'shard-a:db3', 'shard-b:db1', 'shard-b:db2'],
  );
});

test('splitDatabases：逗号拆分去空格；单库原样返回', () => {
  assert.deepEqual(splitDatabases({ database: 'a,b , c' }), ['a', 'b', 'c']);
  assert.deepEqual(splitDatabases({ database: 'app_prod' }), ['app_prod']);
  assert.deepEqual(splitDatabases({ database: ' ' }), []);
});
