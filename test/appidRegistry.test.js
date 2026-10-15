// §8.2 授权通配：matchesAppid / expandAppids 语义（*、前缀*、精确）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesAppid, expandAppids, isWildcardPattern, collectAppids, detectCollisions,
} from '../src/plan/appidRegistry.js';

test('matchesAppid：* 匹配任意 appid', () => {
  assert.ok(matchesAppid('*', 'app_1001'));
  assert.ok(matchesAppid('*', 'adpoa-ke'));
  assert.ok(matchesAppid('*', 'x'));
});

test('matchesAppid：前缀通配 app_* 只匹配 app_ 前缀', () => {
  assert.ok(matchesAppid('app_*', 'app_1001'));
  assert.ok(matchesAppid('app_*', 'app_x'));
  assert.ok(!matchesAppid('app_*', 'adpoa-ke'));
  assert.ok(!matchesAppid('app_*', 'app'));
});

test('matchesAppid：adpoa-* 匹配 adpoa-ke 不匹配 adpoa_ke', () => {
  assert.ok(matchesAppid('adpoa-*', 'adpoa-ke'));
  assert.ok(!matchesAppid('adpoa-*', 'adpoa_ke'));
});

test('matchesAppid：无通配按精确匹配', () => {
  assert.ok(matchesAppid('app_1001', 'app_1001'));
  assert.ok(!matchesAppid('app_1001', 'app_1002'));
});

test('matchesAppid：中间通配（a*b）', () => {
  assert.ok(matchesAppid('app_*_x', 'app_1001_x'));
  assert.ok(!matchesAppid('app_*_x', 'app_1001_y'));
});

test('isWildcardPattern 识别通配', () => {
  assert.ok(isWildcardPattern('*'));
  assert.ok(isWildcardPattern('app_*'));
  assert.ok(!isWildcardPattern('app_1001'));
});

test('expandAppids：纯通配 * 且无已知具体 appid → 保留通配原样', () => {
  const { apps } = expandAppids(['*'], ['*']);
  assert.deepEqual(apps, ['*']);
});

test('expandAppids：app_* 在已知 appid 中展开', () => {
  const { apps } = expandAppids(['app_*'], ['app_1001', 'app_1002', 'adpoa-ke']);
  assert.deepEqual(apps, ['app_1001', 'app_1002']);
});

test('expandAppids：具体 appid 与通配并存，去重排序', () => {
  const { apps } = expandAppids(['adpoa-*', 'app_1001'], ['app_1001', 'adpoa-ke', 'adpoa-sz']);
  assert.deepEqual(apps, ['adpoa-ke', 'adpoa-sz', 'app_1001']);
});

test('collectAppids：并集含通配项原样保留', () => {
  const config = {
    tokens: [
      { token: 'a', actor: 'x', allowApps: ['app_1001'] },
      { token: 'b', actor: 'y', allowApps: ['*'] },
    ],
  };
  assert.deepEqual(collectAppids(config), ['app_1001', '*']);
});

test('detectCollisions 不受通配影响：* 是合法授权项不是 appid 分表键', () => {
  const config = {
    tokens: [{ token: 'a', actor: 'x', allowApps: ['*'] }],
  };
  assert.deepEqual(detectCollisions(collectAppids(config)), []);
});
