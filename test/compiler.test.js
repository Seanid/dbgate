// §9.3④ 编译产物断言：每操作符、值只在 params、tie-breaker、隔离列在每个 target 上都存在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileSelect, compileCount, compileAggregate, compileDistinct, compileDistinctGroup,
  expandMetrics, normalizeIsolation, SUPPORTED_OPS,
} from '../src/core/compiler.js';
import { buildFieldMap, validateFilters, validateSort } from '../src/core/fieldGuard.js';
import { APPID_MISMATCH, OPERATOR_NOT_ALLOWED, FIELD_NOT_ALLOWED } from '../src/errors.js';

const ISOLATION = { column: 'app_id', value: 'app_1001' };
const BASE = {
  database: 'app_prod',
  table: 'orders_app_1001',
  columns: ['id', 'amount', 'created_at'],
  filters: [],
  sort: [{ field: 'created_at', desc: true }],
  limit: 100,
  offset: 0,
  isolationColumn: ISOLATION.column,
  isolationValue: ISOLATION.value,
  tieBreakers: ['id'],
};

function buildFieldMapFor(fieldsConfig) {
  return buildFieldMap({ fields: fieldsConfig }, []);
}

const FIELDS = {
  id: { filterable: true, sortable: true },
  app_id: { locked: true },
  status: { filterable: true },
  amount: { filterable: true, sortable: true, aggregatable: true },
  channel: { filterable: true },
  created_at: { filterable: true, sortable: true },
  user_phone: { filterable: false, sortable: false, mask: 'phone' },
};

test('表名来自配置原文且被反引号包裹（§6.5.2）', () => {
  const { sql, params } = compileSelect(BASE);
  assert.match(sql, /FROM `app_prod`\.`orders_app_1001`/);
  // 隔离列值只出现在 params 首位（表名中的 app_1001 是物理表后缀，属正常）
  assert.equal(params[0], 'app_1001');
  // 值不在 SQL 文本：过滤值 'paid' 等不得出现
  const { sql: sql2 } = compileSelect({ ...BASE, filters: [{ field: 'status', op: 'eq', value: 'paid' }] });
  assert.ok(!sql2.includes("'paid'"));
  assert.ok(!sql2.includes('paid'));
});

test('隔离列恒定注入：每个 target 的 SQL 都含 app_id = ?（§6.5.3）', () => {
  // 模拟 3 个 target 各编译一次
  for (let i = 0; i < 3; i++) {
    const { sql, params } = compileSelect({ ...BASE, table: `orders_app_1001_${i}` });
    assert.match(sql, /`app_id` = \?/);
    assert.equal(params[0], 'app_1001');
  }
});

test('值全部出现在 params，绝不进入 SQL 文本（C4）', () => {
  const filters = [
    { field: 'status', op: 'eq', value: 'paid' },
    { field: 'amount', op: 'gte', value: 199.5 },
    { field: 'channel', op: 'in', value: ['wx', 'alipay'] },
    { field: 'created_at', op: 'between', value: ['2026-01-01', '2026-12-31'] },
  ];
  // 用与表名后缀不同的隔离值，确保能严格断言“值不出现在 SQL 文本”
  const { sql, params } = compileSelect({ ...BASE, table: 'orders_x', isolationValue: 'app_7777', filters });
  // 占位符数量与 params 一致
  const placeholders = (sql.match(/\?/g) ?? []).length;
  assert.equal(placeholders, params.length);
  // 任何参数值（字符串化）不得出现在 SQL 中
  for (const p of params) {
    assert.ok(!sql.includes(String(p)), `参数值 ${p} 不应出现在 SQL 文本中`);
  }
  assert.ok(!sql.includes("'paid'"));
  assert.ok(!sql.includes('alipay'));
});

test('每操作符编译（§6.5.4）', () => {
  const cases = [
    [{ field: 'status', op: 'eq', value: 'x' }, /`status` = \?/, 1],
    [{ field: 'status', op: 'ne', value: 'x' }, /`status` <> \?/, 1],
    [{ field: 'amount', op: 'gt', value: 1 }, /`amount` > \?/, 1],
    [{ field: 'amount', op: 'gte', value: 1 }, /`amount` >= \?/, 1],
    [{ field: 'amount', op: 'lt', value: 1 }, /`amount` < \?/, 1],
    [{ field: 'amount', op: 'lte', value: 1 }, /`amount` <= \?/, 1],
    [{ field: 'status', op: 'like', value: 'pa%' }, /`status` LIKE \?/, 1],
    [{ field: 'channel', op: 'in', value: ['a', 'b'] }, /`channel` IN \(\?,\?\)/, 2],
    [{ field: 'channel', op: 'not_in', value: ['a'] }, /`channel` NOT IN \(\?\)/, 1],
    [{ field: 'amount', op: 'between', value: [1, 2] }, /`amount` BETWEEN \? AND \?/, 2],
    [{ field: 'status', op: 'is_null' }, /`status` IS NULL/, 0],
    [{ field: 'status', op: 'not_null' }, /`status` IS NOT NULL/, 0],
  ];
  for (const [f, re, nParams] of cases) {
    const { sql, params } = compileSelect({ ...BASE, filters: [f] });
    assert.match(sql, re);
    assert.equal(params.length, 3 + nParams); // 隔离列 1 + limit 1 + offset 1 + nParams
  }
});

test('操作符枚举完整性', () => {
  assert.deepEqual(
    [...SUPPORTED_OPS].sort(),
    ['between', 'eq', 'gt', 'gte', 'in', 'is_null', 'like', 'lt', 'lte', 'ne', 'not_in', 'not_null'],
  );
});

test('ORDER BY 末尾恒定追加主键 tie-breaker（§6.5.5）', () => {
  const { sql } = compileSelect(BASE);
  assert.match(sql, /ORDER BY `created_at` DESC, `id` ASC/);
  // 无排序时也追加 tie-breaker
  const { sql: sql2 } = compileSelect({ ...BASE, sort: [] });
  assert.match(sql2, /ORDER BY `id` ASC/);
});

test('tie-breaker 去重：显式排了 id 就不再重复追加', () => {
  const { sql } = compileSelect({ ...BASE, sort: [{ field: 'id', desc: false }] });
  assert.match(sql, /ORDER BY `id` ASC/);
  const orderByPart = sql.split('ORDER BY')[1];
  assert.equal((orderByPart.match(/`id`/g) ?? []).length, 1);
});

test('LIMIT ? OFFSET ? 参数化', () => {
  const { sql, params } = compileSelect({ ...BASE, limit: 50, offset: 10 });
  assert.match(sql, /LIMIT \? OFFSET \?/);
  assert.equal(params[params.length - 2], 50);
  assert.equal(params[params.length - 1], 10);
});

test('隔离列规范化：eq 值一致 → 去除；不一致 → APPID_MISMATCH（§6.5.3）', () => {
  const f1 = [{ field: 'app_id', op: 'eq', value: 'app_1001' }];
  const out = normalizeIsolation(f1, 'app_id', 'app_1001');
  assert.equal(out.length, 0); // 已由系统注入，丢弃

  assert.throws(
    () => normalizeIsolation([{ field: 'app_id', op: 'eq', value: 'app_9999' }], 'app_id', 'app_1001'),
    (e) => e.code === APPID_MISMATCH,
  );
});

test('隔离列规范化：in 含请求 appid → 收窄为 eq；不含 → APPID_MISMATCH', () => {
  const out = normalizeIsolation([{ field: 'app_id', op: 'in', value: ['app_1001', 'app_9999'] }], 'app_id', 'app_1001');
  assert.equal(out.length, 1);
  assert.equal(out[0].op, 'eq');
  assert.equal(out[0].value, 'app_1001');

  assert.throws(
    () => normalizeIsolation([{ field: 'app_id', op: 'in', value: ['app_9999'] }], 'app_id', 'app_1001'),
    (e) => e.code === APPID_MISMATCH,
  );
});

test('非 eq/in 的隔离列条件 → APPID_MISMATCH', () => {
  assert.throws(
    () => normalizeIsolation([{ field: 'app_id', op: 'gte', value: 'x' }], 'app_id', 'app_1001'),
    (e) => e.code === APPID_MISMATCH,
  );
});

test('字段守卫：like 前导通配符 → OPERATOR_NOT_ALLOWED（T10）', () => {
  const fieldMap = buildFieldMapFor(FIELDS);
  const limits = { maxFilters: 10, maxInValues: 500 };
  assert.throws(
    () => validateFilters([{ field: 'status', op: 'like', value: '%abc' }], fieldMap, limits, 'app_id'),
    (e) => e.code === OPERATOR_NOT_ALLOWED,
  );
});

test('字段守卫：不可过滤/不存在字段 → FIELD_NOT_ALLOWED（T08）', () => {
  const fieldMap = buildFieldMapFor(FIELDS);
  const limits = { maxFilters: 10, maxInValues: 500 };
  assert.throws(() => validateFilters([{ field: 'user_phone', op: 'eq', value: '1' }], fieldMap, limits, 'app_id'), (e) => e.code === FIELD_NOT_ALLOWED);
  assert.throws(() => validateFilters([{ field: 'nope', op: 'eq', value: '1' }], fieldMap, limits, 'app_id'), (e) => e.code === FIELD_NOT_ALLOWED);
});

test('编译 count：COUNT(*) + 隔离列', () => {
  const { sql, params } = compileCount({ database: 'app_prod', table: 'orders_app_1001', filters: [], isolationColumn: 'app_id', isolationValue: 'app_1001' });
  assert.match(sql, /SELECT COUNT\(\*\) AS `cnt`/);
  assert.match(sql, /WHERE `app_id` = \?/);
  assert.deepEqual(params, ['app_1001']);
});

test('avg 展开为 SUM + COUNT（§7.5.2 实现约束）', () => {
  const expanded = expandMetrics([{ field: 'amount', op: 'avg' }]);
  assert.deepEqual(expanded, [
    { field: 'amount', op: 'sum', alias: '__sum_amount' },
    { field: 'amount', op: 'count', alias: '__cnt_amount' },
  ]);
});

test('编译分组聚合：groupBy + 指标 + avg 展开', () => {
  const metrics = expandMetrics([
    { field: 'amount', op: 'sum', alias: 'sum(amount)' },
    { field: 'amount', op: 'avg' },
  ]);
  const { sql, params } = compileAggregate({
    database: 'app_prod', table: 'orders_app_1001',
    groupBy: ['status'], metrics, filters: [], sort: [], limit: 10, offset: 0,
    isolationColumn: 'app_id', isolationValue: 'app_1001',
  });
  assert.match(sql, /GROUP BY `status`/);
  assert.match(sql, /SUM\(`amount`\) AS `sum\(amount\)`/);
  assert.match(sql, /SUM\(`amount`\) AS `__sum_amount`/);
  assert.match(sql, /COUNT\(`amount`\) AS `__cnt_amount`/);
  assert.equal(params[0], 'app_1001');
});

test('编译去重：compileDistinct 与 compileDistinctGroup', () => {
  const d = compileDistinct({ database: 'app_prod', table: 'orders_app_1001', field: 'channel', filters: [], isolationColumn: 'app_id', isolationValue: 'app_1001' });
  assert.match(d.sql, /SELECT DISTINCT `channel` AS `v`/);
  const g = compileDistinctGroup({ database: 'app_prod', table: 'orders_app_1001', groupBy: ['status'], field: 'channel', filters: [], isolationColumn: 'app_id', isolationValue: 'app_1001' });
  assert.match(g.sql, /SELECT DISTINCT `status`, `channel` AS `v`/);
});

test('缺失列 → NULL AS `col`（跨实例列漂移保持形状一致）', () => {
  const { sql } = compileSelect({ ...BASE, columns: ['id', 'amount'], nullColumns: ['created_at'] });
  assert.match(sql, /NULL AS `created_at`/);
  assert.match(sql, /`id`, `amount`/);
});

test('标识符转义：反引号按 MySQL 规则转义', () => {
  const weird = 'a`b';
  // 配置原文含反引号的列名（极端情况）应被转义而非拼接注入
  const { sql } = compileSelect({ ...BASE, columns: ['id', weird] });
  assert.ok(sql.includes('`a``b`'));
});
