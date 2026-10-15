// §8.2 token 可查表清单：tables 缺省 ["*"]（全部可查）、自定义表白名单、恒时比较。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenValidator } from '../src/auth/token.js';

const CFG = {
  tokens: [
    { token: 'tok-a', actor: 'all', allowApps: ['*'] },
    { token: 'tok-b', actor: 'orders-only', allowApps: ['app_1001'], tables: ['orders', 'order_*'] },
  ],
};

test('tables 缺省 = ["*"]（全部可查，兼容旧配置）', () => {
  const validate = createTokenValidator(CFG);
  const ctx = validate('tok-a');
  assert.deepEqual(ctx.tables, ['*']);
});

test('自定义 tables 表白名单原样透传', () => {
  const validate = createTokenValidator(CFG);
  const ctx = validate('tok-b');
  assert.deepEqual(ctx.tables, ['orders', 'order_*']);
});

test('token 错误返回 null', () => {
  const validate = createTokenValidator(CFG);
  assert.equal(validate('wrong-token'), null);
  assert.equal(validate(''), null);
  assert.equal(validate(null), null);
});

test('allowApps 与 actor 正常返回', () => {
  const validate = createTokenValidator(CFG);
  const ctx = validate('tok-b');
  assert.equal(ctx.actor, 'orders-only');
  assert.deepEqual(ctx.allowApps, ['app_1001']);
});
