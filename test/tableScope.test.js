// §9.3② 表路由求值：优先级 + 通配符 + 重叠 / 零命中 + 决议表稳定性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTableScope, matchesPattern, formatScope } from '../src/plan/tableScope.js';
import { makeConfig } from './helpers.js';
import { TABLE_ROUTE_CONFLICT, TABLE_ROUTE_EMPTY } from '../src/errors.js';

test('通配符语义：% 任意长度；_ 是普通字符（§5.3）', () => {
  assert.ok(matchesPattern('aaa_user', 'aaa_%'));
  assert.ok(!matchesPattern('aaa', 'aaa_%'));
  assert.ok(!matchesPattern('aaab', 'aaa_%'));
  // _ 是分隔符不是通配符：userXloanYsummaryA 不得匹配 user_loan_summary_%
  assert.ok(!matchesPattern('userXloanYsummaryA', 'user_loan_summary_%'));
  assert.ok(matchesPattern('user_loan_summary_adpoa_ke', 'user_loan_summary_%'));
  // 前缀匹配用于覆盖同一表所有 appid 分片
  assert.ok(matchesPattern('orders_app_1001', 'orders_%'));
  // 大小写不敏感
  assert.ok(matchesPattern('AAA_USER', 'aaa_%'));
});

test('三级优先级：tables.members > tableRoutes 首个命中 > bizType.members（逐级覆盖不合并，§5.4）', () => {
  const scope = buildTableScope(makeConfig());
  // order_summary：表级 members 只含 shard-a → 覆盖业务 3 成员
  assert.deepEqual(scope.byTable.order_summary.instances, ['shard-a']);
  // aaa_user：命中 tableRoutes[0]（aaa_%）→ shard-a, shard-b（覆盖业务 3 成员）
  assert.deepEqual(scope.byTable.aaa_user.instances, ['shard-a', 'shard-b']);
  assert.equal(scope.byTable.aaa_user.matchedRuleDesc, 'tableRoutes[0] · aaa_%');
  // orders：无规则命中 → 回落业务成员
  assert.deepEqual(scope.byTable.orders.instances, ['shard-a', 'shard-b', 'shard-c']);
  assert.equal(scope.byTable.orders.matchedRule, null);
  // report_daily：命中 tableRoutes[2]
  assert.equal(scope.byTable.report_daily.matchedRuleDesc, 'tableRoutes[2] · report_%');
});

test('匹配对象是 tableKey = tablePrefix ?? 逻辑表名（§5.2）', () => {
  const scope = buildTableScope(makeConfig());
  // order_archive 的 tablePrefix = orders_arch，规则 user_loan_% 不命中，回落业务成员
  assert.deepEqual(scope.byTable.order_archive.instances, ['archive-1']);
  assert.equal(scope.byTable.order_archive.tableKey, 'orders_arch');
});

test('traversal / failurePolicy / concurrency 独立解析（§5.4 MUST）', () => {
  const cfg = makeConfig({
    tableRoutes: [{ match: 'strict_%', bizType: 'order', failurePolicy: 'strict' }],
    tables: { strict_order: { bizType: 'order' } },
  });
  const scope = buildTableScope(cfg);
  const e = scope.byTable.strict_order;
  assert.equal(e.traversal, 'fanout'); // 规则未给 traversal → 继承业务 fanout
  assert.equal(e.failurePolicy, 'strict'); // 规则给了 failurePolicy → 覆盖业务 bestEffort
  assert.equal(e.concurrency, 4); // 规则未给 concurrency → 业务 4
});

test('重叠检测：两条规则命中同一表 → TABLE_ROUTE_CONFLICT（启动即失败）', () => {
  const cfg = makeConfig({
    tableRoutes: [
      { match: 'aaa_%', members: [{ instance: 'shard-a' }] },
      { match: 'aaa_user%', members: [{ instance: 'shard-b' }] }, // aaa_user 同时命中两条
    ],
  });
  assert.throws(() => buildTableScope(cfg), (e) => {
    assert.equal(e.code, TABLE_ROUTE_CONFLICT);
    assert.match(e.message, /aaa_user/);
    assert.match(e.message, /tableRoutes\[0\]/);
    return true;
  });
});

test('零命中检测：规则命中 0 张已声明表 → TABLE_ROUTE_EMPTY（启动即失败）', () => {
  const cfg = makeConfig({
    tableRoutes: [
      { match: 'never_matches_anything_%', members: [{ instance: 'shard-a' }] },
    ],
  });
  assert.throws(() => buildTableScope(cfg), (e) => {
    assert.equal(e.code, TABLE_ROUTE_EMPTY);
    assert.match(e.message, /never_matches_anything_%/);
    return true;
  });
});

test('零命中检测：把 _ 当通配符写错模式 → 零命中被拦（§5.5 最常见错误）', () => {
  // user_loan_summary 是已声明表；模式写成 user%loan%summary% 按我们的语义（仅 % 通配）会命中，
  // 因此用一个确实不命中的模式模拟写错场景
  const cfg = makeConfig({
    tableRoutes: [
      { match: 'userXloanYsummary_%', members: [{ instance: 'shard-a' }] }, // 真实表名是 user_loan_summary
    ],
  });
  assert.throws(() => buildTableScope(cfg), (e) => e.code === TABLE_ROUTE_EMPTY);
});

test('安全边界：规则只在已声明表上求值（§5.6）', () => {
  // 裁剪规则与表集一致：aaa_% 命中 aaa_user 与 aaa_secret，均入决议表
  const cfg = makeConfig({
    tableRoutes: [{ match: 'aaa_%', members: [{ instance: 'shard-a' }, { instance: 'shard-b' }] }],
    tables: { aaa_user: { bizType: 'order' }, aaa_secret: { bizType: 'order' } },
  });
  const scope = buildTableScope(cfg);
  assert.deepEqual(Object.keys(scope.byTable).sort(), ['aaa_secret', 'aaa_user']);
  assert.deepEqual(scope.byTable.aaa_user.instances, ['shard-a', 'shard-b']);
  assert.equal(scope.byTable.aaa_secret.matchedRule, 0);
  // 未声明表（如 aaa_super_secret）不进入决议表 → planner 拒查
  assert.equal(scope.byTable.aaa_super_secret, undefined);
});

test('决议表稳定性：同一配置两次求值 JSON 完全一致（快照可 diff）', () => {
  const cfg = makeConfig();
  const s1 = buildTableScope(cfg);
  const s2 = buildTableScope(cfg);
  // 只比较决议表本体（frozenAt 是时间戳，两次调用可能跨毫秒边界，不参与比较）
  assert.equal(JSON.stringify(s1.byTable), JSON.stringify(s2.byTable));
});

test('formatScope 输出包含关键列', () => {
  const scope = buildTableScope(makeConfig());
  const text = formatScope(scope);
  assert.match(text, /orders/);
  assert.match(text, /shard-a, shard-b, shard-c/);
  assert.match(text, /tableRoutes\[0\] · aaa_%/);
});

test('多业务 bizType="order,order_archive"：成员按各业务并集（同实例去重），策略取首个业务', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    tables: { cross: { bizType: 'order,order_archive', tablePrefix: 'cross' } },
  });
  const scope = buildTableScope(cfg);
  const e = scope.byTable.cross;
  assert.deepEqual(e.bizTypes, ['order', 'order_archive']);
  // order = shard-a/b/c，order_archive = archive-1 → 并集 4 个
  assert.deepEqual(e.instances, ['shard-a', 'shard-b', 'shard-c', 'archive-1']);
  assert.equal(e.traversal, 'fanout'); // 取首个业务 order
});

test('多业务并集去重：两业务含同一实例只查一次', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    bizTypes: {
      ...makeConfig().bizTypes,
      order_b: { traversal: 'fanout', members: [{ instance: 'shard-b' }, { instance: 'shard-c' }], failurePolicy: 'bestEffort' },
    },
    tables: { dup: { bizType: 'order,order_b' } },
  });
  const scope = buildTableScope(cfg);
  assert.deepEqual(scope.byTable.dup.instances, ['shard-a', 'shard-b', 'shard-c']);
});

test('多业务 route 映射合并：两业务 route 并集（声明顺序后者覆盖）', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    bizTypes: {
      r1: { traversal: 'route', route: { 'app_a': 'shard-a', 'app_x': 'shard-a' }, members: [{ instance: 'shard-a' }] },
      r2: { traversal: 'route', route: { 'app_b': 'shard-b', 'app_x': 'shard-b' }, members: [{ instance: 'shard-b' }] },
    },
    tables: { routed: { bizType: 'r1,r2' } },
  });
  const scope = buildTableScope(cfg);
  assert.deepEqual(scope.byTable.routed.routeByAppid, { app_a: 'shard-a', app_x: 'shard-b', app_b: 'shard-b' });
});

test('bizType 缺省 = 遍历全部业务成员并集（同名表两边都有）', () => {
  const cfg = makeConfig({
    tableRoutes: [],
    tables: { anywhere: { tablePrefix: 'anywhere' } }, // 无 bizType
  });
  const scope = buildTableScope(cfg);
  const e = scope.byTable.anywhere;
  // order = shard-a/b/c，order_archive = archive-1，payment = shard-a/b → 并集去重 4 个
  assert.deepEqual(e.bizTypes, ['order', 'order_archive', 'payment']);
  assert.deepEqual(e.instances, ['shard-a', 'shard-b', 'shard-c', 'archive-1']);
});
