// §9.3① 归并语义：avg 重算、分页一致性、count_distinct 并集、min/max 空片与 NULL。
// 归并写错不会报错，只会安静地给出错误的数字——这里用不均匀分布构造，确保正误结果不同。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeRecords, mergeCount, mergeSum, mergeMinMax, mergeAvg, mergeCountDistinct, mergeGroupBy,
} from '../src/core/merger.js';
import { CARDINALITY_EXCEEDED } from '../src/errors.js';

test('avg 必须用 Σsum/Σcount 重算：片A avg=100(10条)、片B avg=1000(2条) → 250，不是 550（T34、§7.5.2）', () => {
  // 每片 rows 为 [sum, count]（编译器已展开为 __sum_x, __cnt_x）
  const slices = [
    { instance: 'shard-a', rows: [[1000, 10]] },
    { instance: 'shard-b', rows: [[2000, 2]] },
  ];
  const avg = mergeAvg(slices, 0, 1);
  assert.equal(avg, 250); // (1000+2000)/(10+2)=250，绝不可 (100+1000)/2=550
});

test('avg：Σcnt=0 → null（空片忽略）', () => {
  const slices = [
    { instance: 'shard-a', rows: [[0, 0]] },
    { instance: 'shard-b', rows: [] },
  ];
  assert.equal(mergeAvg(slices, 0, 1), null);
});

test('分页一致性：offset+limit 分片取数后归并 = 取全量再切片（T33、§7.5.3）', () => {
  // 全局数据：按 key 排序，3 个实例交错分布
  const globalRows = [];
  for (let key = 0; key < 60; key++) {
    globalRows.push({ key, inst: `s-${key % 3}` });
  }
  globalRows.sort((a, b) => a.key - b.key); // 全局序

  const offset = 5;
  const limit = 12;
  // 每片取前 offset+limit 行（不带 OFFSET）——模拟 executor 的 per-slice LIMIT
  const slices = ['s-0', 's-1', 's-2'].map((inst) => ({
    instance: inst,
    rows: globalRows
      .filter((r) => r.inst === inst)
      .slice(0, offset + limit)
      .map((r) => [r.key]),
  }));
  const merged = mergeRecords({
    slices,
    columns: ['key'],
    sort: [{ field: 'key', desc: false }],
    tieBreakers: [],
    useInstanceTie: false,
    offset,
    limit,
  });
  const expected = globalRows.slice(offset, offset + limit).map((r) => [r.key]);
  assert.deepEqual(merged.rows, expected);
});

test('全局排序：跨实例交错时间戳严格全局有序（T32）', () => {
  const slices = [
    { instance: 'a', rows: [['2026-09-01'], ['2026-09-03']] },
    { instance: 'b', rows: [['2026-09-02'], ['2026-09-04']] },
  ];
  const { rows } = mergeRecords({
    slices, columns: ['created_at'],
    sort: [{ field: 'created_at', desc: false }], tieBreakers: [], useInstanceTie: false,
    offset: 0, limit: 100,
  });
  assert.deepEqual(rows.map((r) => r[0]), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
});

test('多片合并后截断：3 片各 5 行，limit 8 → 返回 8 行全局有序（T31）', () => {
  const slices = ['a', 'b', 'c'].map((inst) => ({
    instance: inst,
    rows: [1, 2, 3, 4, 5].map((v) => [inst === 'a' ? v * 10 : inst === 'b' ? v * 10 + 2 : v * 10 + 4, v]),
  }));
  const { rows } = mergeRecords({
    slices,
    columns: ['key', 'v'],
    sort: [{ field: 'key', desc: false }],
    tieBreakers: ['v'],
    useInstanceTie: false,
    offset: 0,
    limit: 8,
  });
  assert.equal(rows.length, 8);
  const keys = rows.map((r) => r[0]);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] <= keys[i]);
});

test('hasMore：窗口外仍有数据时为 true', () => {
  const slices = [{ instance: 'a', rows: [[1], [2], [3], [4], [5]] }];
  const r1 = mergeRecords({ slices, columns: ['k'], sort: [{ field: 'k', desc: false }], tieBreakers: [], useInstanceTie: false, offset: 0, limit: 3 });
  assert.equal(r1.rows.length, 3);
  assert.equal(r1.hasMore, true);
  const r2 = mergeRecords({ slices, columns: ['k'], sort: [{ field: 'k', desc: false }], tieBreakers: [], useInstanceTie: false, offset: 0, limit: 10 });
  assert.equal(r2.hasMore, false);
});

test('count 归并：各片相加（T31 计数）', () => {
  const slices = [
    { instance: 'a', rows: [[5]] },
    { instance: 'b', rows: [[0]] },
    { instance: 'c', rows: [[7]] },
  ];
  assert.equal(mergeCount(slices), 12);
});

test('sum 归并：各片相加，NULL 不参与，全空返回 null', () => {
  const slices = [
    { instance: 'a', rows: [[100]] },
    { instance: 'b', rows: [[null]] },
    { instance: 'c', rows: [[200]] },
  ];
  assert.equal(mergeSum(slices), 300);
  assert.equal(mergeSum([{ instance: 'a', rows: [[null]] }]), null);
});

test('min/max：空片必须忽略，NULL 不参与（T35、§7.5.1）', () => {
  const slices = [
    { instance: 'a', rows: [] },
    { instance: 'b', rows: [[null]] },
    { instance: 'c', rows: [[50], [10]] },
  ];
  assert.equal(mergeMinMax(slices, 'min'), 10);
  assert.equal(mergeMinMax(slices, 'max'), 50);
  assert.equal(mergeMinMax([{ instance: 'a', rows: [] }, { instance: 'b', rows: [[null]] }], 'min'), null);
});

test('min/max：字符串与数字混合按确定性比较', () => {
  const slices = [
    { instance: 'a', rows: [['2026-01-05']] },
    { instance: 'b', rows: [['2026-01-01'], ['2026-01-10']] },
  ];
  assert.equal(mergeMinMax(slices, 'min'), '2026-01-01');
  assert.equal(mergeMinMax(slices, 'max'), '2026-01-10');
});

test('count_distinct：两片重叠值 → 并集计数正确（T36、§7.5.4）', () => {
  const slices = [
    { instance: 'a', rows: [['wx'], ['alipay'], ['wx']] },
    { instance: 'b', rows: [['alipay'], ['jd']] },
  ];
  assert.equal(mergeCountDistinct(slices, 10000), 3); // {wx, alipay, jd}
});

test('count_distinct：基数超上限 → CARDINALITY_EXCEEDED，不静默降级（T37）', () => {
  const slices = [
    { instance: 'a', rows: Array.from({ length: 5 }, (_, i) => [`v${i}`]) },
  ];
  assert.throws(() => mergeCountDistinct(slices, 3), (e) => {
    assert.equal(e.code, CARDINALITY_EXCEEDED);
    assert.match(e.details.suggestion, /groupBy/);
    return true;
  });
});

test('groupBy：sum/count/min/max 组内归并，某分组只在一个片出现是正常的（§7.5.1）', () => {
  const slices = [
    { instance: 'a', rows: [['paid', 100, 3, 100, 100], ['refund', 50, 1, 50, 50]] },
    { instance: 'b', rows: [['paid', 200, 2, 200, 200], ['pending', 30, 5, 30, 30]] },
  ];
  const merged = mergeGroupBy({
    slices,
    columns: ['status', 'sum(amount)', 'count(amount)', 'min(amount)', 'max(amount)'],
    groupBy: ['status'],
    metrics: [
      { field: 'amount', op: 'sum', alias: 'sum(amount)' },
      { field: 'amount', op: 'count', alias: 'count(amount)' },
      { field: 'amount', op: 'min', alias: 'min(amount)' },
      { field: 'amount', op: 'max', alias: 'max(amount)' },
    ],
    maxDistinctCardinality: 10000,
  });
  const byStatus = new Map(merged.rows.map((r) => [r[0], r]));
  assert.deepEqual([...byStatus.get('paid').slice(1)], [300, 5, 100, 200]);
  assert.deepEqual([...byStatus.get('refund').slice(1)], [50, 1, 50, 50]);
  assert.deepEqual([...byStatus.get('pending').slice(1)], [30, 5, 30, 30]);
});

test('groupBy + avg：Σsum/Σcnt 重算', () => {
  const slices = [
    { instance: 'a', rows: [['paid', 1000, 10]] },
    { instance: 'b', rows: [['paid', 2000, 2]] },
  ];
  const merged = mergeGroupBy({
    slices,
    columns: ['status', '__sum_amount', '__cnt_amount'],
    groupBy: ['status'],
    metrics: [{ field: 'amount', op: 'avg', alias: 'avg(amount)' }],
    maxDistinctCardinality: 10000,
  });
  assert.equal(merged.columns[1], 'avg(amount)');
  assert.equal(merged.rows[0][1], 250);
});

test('groupBy + count_distinct：独立去重值对 → 组内并集（T36 分组版）', () => {
  const groupResults = [
    { instance: 'a', rows: [['paid', 3], ['refund', 1]] }, // [status, count(amount)]
    { instance: 'b', rows: [['paid', 2]] },
  ];
  const distinctResults = [
    { instance: 'a', rows: [['paid', 'wx'], ['paid', 'alipay'], ['refund', 'jd']] },
    { instance: 'b', rows: [['paid', 'alipay'], ['paid', 'jd']] },
  ];
  const merged = mergeGroupBy({
    slices: groupResults,
    columns: ['status', 'count(amount)'],
    groupBy: ['status'],
    metrics: [
      { field: 'amount', op: 'count', alias: 'count(amount)' },
      { field: 'channel', op: 'count_distinct', alias: 'count_distinct(channel)' },
    ],
    maxDistinctCardinality: 10000,
    distinct: [{ alias: 'count_distinct(channel)', slices: distinctResults }],
  });
  const byStatus = new Map(merged.rows.map((r) => [r[0], r]));
  assert.equal(byStatus.get('paid')[2], 3); // {wx, alipay, jd}
  assert.equal(byStatus.get('refund')[2], 1); // {jd}
});

test('groupBy + count_distinct：单分片基数超限 → CARDINALITY_EXCEEDED', () => {
  const distinctResults = [
    { instance: 'a', rows: Array.from({ length: 6 }, (_, i) => ['g1', `v${i}`]) },
  ];
  assert.throws(() => mergeGroupBy({
    slices: [{ instance: 'a', rows: [['g1', 6]] }],
    columns: ['g', 'count(g)'],
    groupBy: ['g'],
    metrics: [{ field: 'g', op: 'count', alias: 'count(g)' }, { field: 'v', op: 'count_distinct', alias: 'cd' }],
    maxDistinctCardinality: 5,
    distinct: [{ alias: 'cd', slices: distinctResults }],
  }), (e) => e.code === CARDINALITY_EXCEEDED);
});

test('tie-breaker：_instance 虚拟键由归并层按实例名补齐全局唯一（§7.5.5 方案2）', () => {
  // 各实例主键各自从 1 自增，无 instance tie 时顺序不确定；开启后以实例名兜底
  const slices = [
    { instance: 'b', rows: [[100, 'b-data']] },
    { instance: 'a', rows: [[100, 'a-data']] },
  ];
  const withTie = mergeRecords({
    slices, columns: ['id', 'payload'],
    sort: [{ field: 'id', desc: false }], tieBreakers: ['id'],
    useInstanceTie: true, offset: 0, limit: 10,
  });
  assert.deepEqual(withTie.rows.map((r) => r[1]), ['a-data', 'b-data']);
});
