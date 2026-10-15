// §9.3③ 分表后缀：归一化确定性 + 碰撞 + 64 字符边界 + 拼名优先级。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAppid, validateSuffix, physicalTableName, MAX_TABLE_NAME_LEN,
} from '../src/plan/shard.js';
import { detectCollisions } from '../src/plan/appidRegistry.js';
import { APPID_INVALID } from '../src/errors.js';

test('归一化确定性：ADPOA-KE / adpoa-ke / adpoa_ke → 同一物理表名', () => {
  const a = physicalTableName('orders', 'ADPOA-KE');
  const b = physicalTableName('orders', 'adpoa-ke');
  const c = physicalTableName('orders', 'adpoa_ke');
  assert.equal(a, 'orders_adpoa_ke');
  assert.equal(b, a);
  assert.equal(c, a);
});

test('归一化只影响表名：- → _，大写转小写', () => {
  assert.equal(normalizeAppid('App-1001-X'), 'app_1001_x');
  assert.equal(normalizeAppid('app_1001'), 'app_1001');
});

test('碰撞检测：adpoa-ke 与 adpoa_ke 归一化后同名 → 检出', () => {
  const collisions = detectCollisions(['adpoa-ke', 'adpoa_ke', 'app_1001']);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].normalized, 'adpoa_ke');
});

test('碰撞检测：无碰撞清单返回空', () => {
  assert.deepEqual(detectCollisions(['adpoa-ke', 'app_1001', 'app_1002']), []);
});

test('64 字符边界：恰好 64 通过', () => {
  const prefix = 'x'.repeat(MAX_TABLE_NAME_LEN - 1 - 10); // 64 - 1 - len('abcdefghij')
  const { suffix, tableName } = validateSuffix({ appid: 'abcdefghij', prefix });
  assert.equal(suffix, 'abcdefghij');
  assert.equal(tableName.length, MAX_TABLE_NAME_LEN);
});

test('65 字符边界：超长 → APPID_INVALID，错误信息含实际长度', () => {
  const prefix = 'x'.repeat(MAX_TABLE_NAME_LEN - 10); // prefix 太长，加后缀必超
  try {
    validateSuffix({ appid: 'abcdefghij', prefix });
    assert.fail('应当抛出 APPID_INVALID');
  } catch (e) {
    assert.equal(e.code, APPID_INVALID);
    assert.match(e.message, /长度 \d+ 超过上限 64/);
    assert.ok(e.details.length > 64);
  }
});

test('字符集校验：反引号/点号/中文/空格 → APPID_INVALID', () => {
  for (const bad of ['app`x', 'a.b', '中文', 'a b', 'a/b']) {
    assert.throws(() => validateSuffix({ appid: bad, prefix: 'orders' }), (e) => e.code === APPID_INVALID, `${bad} 应当被拒`);
  }
});

test('合法字符：小写字母数字下划线连字符通过', () => {
  const r = validateSuffix({ appid: 'app-1001_x', prefix: 'orders' });
  assert.equal(r.suffix, 'app_1001_x');
  assert.equal(r.tableName, 'orders_app_1001_x');
});

test('物理表名 = {prefix}_{归一化 appid}（§4.1）', () => {
  assert.equal(physicalTableName('user_loan_summary', 'ADPOA-KE'), 'user_loan_summary_adpoa_ke');
  assert.equal(physicalTableName('orders_arch', 'app_1001'), 'orders_arch_app_1001');
});
