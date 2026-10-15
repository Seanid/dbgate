// ★ 归并器：全仓唯一实现跨片归并语义的地方（C2）。
// §7.5 全表：
//   records      各片合并 → 全局排序 → 截断（每片取 offset+limit，不可下推 OFFSET）
//   count/sum    各片相加
//   min/max      各片取极值（空片必须忽略，不可把 NULL 当 0）
//   avg          必须用 Σsum / Σcount 重算（MUST NOT 接收“已经是平均值”的输入）
//   count_distinct 各片去重值集合并集 → 计数（超基数上限即拒绝，MUST NOT 静默降级近似）
//   groupBy+指标  先按分组键收集各片结果，组内再套用上述规则
import { CARDINALITY_EXCEEDED, err } from '../errors.js';

/** NULL 视为最小（与 MySQL 排序语义一致：ASC 时 NULL 排最前）。 */
function compareScalar(a, b) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return -1;
  if (bNull) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const NULL_KEY = '__dbgate_null__';

/**
 * 记录查询归并（§7.5.1、§7.5.3）：
 * 各片已各自取 offset+limit 行（不带 OFFSET），这里合并 → 全局排序 → 跳过 offset → 取 limit。
 */
export function mergeRecords({ slices, columns, sort, tieBreakers, useInstanceTie, offset, limit }) {
  const colIndex = new Map(columns.map((c, i) => [String(c).toLowerCase(), i]));
  const sortKeys = [...(sort ?? [])];
  const tb = (tieBreakers ?? []).filter((t) => t !== '_instance');
  const keys = [
    ...sortKeys.map((s) => ({ field: s.field, desc: !!s.desc })),
    ...tb.map((f) => ({ field: f, desc: false })),
  ];
  const useInst = useInstanceTie;

  const flat = [];
  for (const slice of slices) {
    for (const row of slice.rows) flat.push({ inst: slice.instance, row });
  }

  flat.sort((x, y) => {
    for (const k of keys) {
      const idx = colIndex.get(String(k.field).toLowerCase());
      const a = idx === undefined ? null : x.row[idx];
      const b = idx === undefined ? null : y.row[idx];
      let c = compareScalar(a, b);
      if (k.desc) c = -c;
      if (c !== 0) return c;
    }
    if (useInst) {
      const c = compareScalar(x.inst, y.inst);
      if (c !== 0) return c;
    }
    return 0;
  });

  const total = flat.length;
  const rows = flat.slice(offset, offset + limit).map((f) => f.row);
  return { rows, hasMore: total > offset + limit };
}

/** count 归并：各片相加。slices 每片 rows=[[cnt]]。 */
export function mergeCount(slices) {
  let total = 0;
  for (const s of slices) for (const row of s.rows) total += num(row[0]);
  return total;
}

/** sum 归并：各片相加（NULL 不参与，全空返回 null）。slices 每片 rows=[[value]]。 */
export function mergeSum(slices) {
  let total = 0;
  let any = false;
  for (const s of slices) {
    for (const row of s.rows) {
      if (row[0] === null || row[0] === undefined) continue;
      total += num(row[0]);
      any = true;
    }
  }
  return any ? total : null;
}

/** min/max 归并：各片取极值。空片必须忽略，NULL 不参与（§7.5.1）。全空返回 null。 */
export function mergeMinMax(slices, op) {
  let best = null;
  let any = false;
  for (const s of slices) {
    for (const row of s.rows) {
      const v = row[0];
      if (v === null || v === undefined) continue;
      if (!any) { best = v; any = true; }
      else if (op === 'min') { if (compareScalar(v, best) < 0) best = v; }
      else if (compareScalar(v, best) > 0) best = v;
    }
  }
  return any ? best : null;
}

/**
 * avg 归并（§7.5.2）：必须用 Σsum / Σcount 重算。
 * 编译器已把 avg 展开为 __sum_x + __cnt_x 两个指标下推（MUST NOT 接收平均值）。
 * Σcnt=0 → null。
 */
export function mergeAvg(slices, sumIdx, cntIdx) {
  let sum = 0;
  let cnt = 0;
  for (const s of slices) {
    for (const row of s.rows) {
      sum += num(row[sumIdx]);
      cnt += num(row[cntIdx]);
    }
  }
  if (cnt === 0) return null;
  return sum / cnt;
}

/**
 * count_distinct 归并（§7.5.4）：各片去重值集合并集后计数。
 * 任一目标基数 > maxDistinctCardinality → CARDINALITY_EXCEEDED（MUST NOT 静默降级近似）。
 */
export function mergeCountDistinct(slices, maxDistinctCardinality) {
  const union = new Set();
  for (const s of slices) {
    const sliceSet = new Set();
    for (const row of s.rows) {
      const v = row[0];
      sliceSet.add(v === null || v === undefined ? NULL_KEY : v);
    }
    if (sliceSet.size > maxDistinctCardinality) {
      throw err(CARDINALITY_EXCEEDED,
        `count_distinct 基数 ${sliceSet.size} 超过上限 ${maxDistinctCardinality}`,
        { cardinality: sliceSet.size, limit: maxDistinctCardinality, suggestion: '建议改用 groupBy 分次查询' });
    }
    for (const v of sliceSet) union.add(v);
  }
  return union.size;
}

/**
 * groupBy + 指标归并（§7.5.1 最后一行）。
 * count_distinct 指标不随主查询下推 COUNT(DISTINCT)（那返回计数而非值），
 * 而是由独立“分组去重值对”查询提供（见 compiler.compileDistinctGroup），
 * 调用方通过 `distinct` 传入：[{ alias, slices: [{ rows: [gv..., v] }] }]。
 */
export function mergeGroupBy({ slices, columns, groupBy, metrics, maxDistinctCardinality, sort = [], limit = 200, offset = 0, distinct = [] }) {
  const colIndex = new Map(columns.map((c, i) => [String(c).toLowerCase(), i]));
  const gbIdx = groupBy.map((g) => colIndex.get(String(g).toLowerCase()));

  const metricPlan = metrics.map((m) => {
    const alias = m.alias ?? `${m.op}(${m.field})`;
    const plan = { field: m.field, op: m.op, alias };
    if (m.op === 'avg') {
      plan.sumIdx = colIndex.get(`__sum_${m.field}`);
      plan.cntIdx = colIndex.get(`__cnt_${m.field}`);
    } else if (m.op === 'count_distinct') {
      // 值集由 distinct 参数提供
    } else {
      plan.valIdx = colIndex.get(m.alias ?? `${m.op}(${m.field})`);
    }
    return plan;
  });

  // 预构建 count_distinct 的分组值集（单分片基数超限即拒绝，§7.5.4）
  const distinctSets = new Map(); // alias -> Map<groupKey, { sliceSets: Set[], union: Set }>
  for (const d of distinct) {
    const map = new Map();
    for (const s of d.slices) {
      for (const row of s.rows) {
        const gv = gbIdx.map((i) => (i === undefined ? null : row[i]));
        const key = JSON.stringify(gv);
        let entry = map.get(key);
        if (!entry) { entry = { sliceSets: [], union: new Set() }; map.set(key, entry); }
        let set = entry.sliceSets[entry.sliceSets.length - 1];
        if (!set || set.__closed) { set = new Set(); entry.sliceSets.push(set); }
        const v = row[row.length - 1];
        set.add(v === null || v === undefined ? NULL_KEY : v);
        entry.union.add(v === null || v === undefined ? NULL_KEY : v);
      }
      // 一个分片结束：之后的行属于下一个分片（分片基数独立检查）
      for (const entry of map.values()) {
        const last = entry.sliceSets[entry.sliceSets.length - 1];
        if (last) last.__closed = true;
      }
    }
    for (const entry of map.values()) {
      for (const set of entry.sliceSets) {
        if (set.size > maxDistinctCardinality) {
          throw err(CARDINALITY_EXCEEDED,
            `分组 count_distinct 单分片基数 ${set.size} 超过上限 ${maxDistinctCardinality}`,
            { cardinality: set.size, limit: maxDistinctCardinality, suggestion: '建议改用 groupBy 分次查询' });
        }
      }
    }
    distinctSets.set(d.alias, map);
  }

  // 主聚合
  const groups = new Map(); // groupKey -> { gv, sum:Map, cnt:Map, min:Map, max:Map }
  const order = [];
  for (const s of slices) {
    for (const row of s.rows) {
      const gv = gbIdx.map((i) => (i === undefined ? null : row[i]));
      const key = JSON.stringify(gv);
      let g = groups.get(key);
      if (!g) { g = { gv, sum: new Map(), cnt: new Map(), min: new Map(), max: new Map() }; groups.set(key, g); order.push(key); }
      for (const mp of metricPlan) {
        if (mp.op === 'avg') {
          const sum = num(mp.sumIdx === undefined ? null : row[mp.sumIdx]);
          const cnt = num(mp.cntIdx === undefined ? null : row[mp.cntIdx]);
          g.sum.set(mp.alias, (g.sum.get(mp.alias) ?? 0) + sum);
          g.cnt.set(mp.alias, (g.cnt.get(mp.alias) ?? 0) + cnt);
        } else if (mp.op === 'count') {
          const v = num(mp.valIdx === undefined ? null : row[mp.valIdx]);
          g.cnt.set(mp.alias, (g.cnt.get(mp.alias) ?? 0) + v);
        } else if (mp.op === 'sum') {
          const v = row[mp.valIdx];
          if (v !== null && v !== undefined) g.sum.set(mp.alias, (g.sum.get(mp.alias) ?? 0) + num(v));
        } else if (mp.op === 'min' || mp.op === 'max') {
          const v = row[mp.valIdx];
          if (v === null || v === undefined) continue;
          const bucket = mp.op === 'min' ? g.min : g.max;
          const cur = bucket.get(mp.alias);
          if (cur === undefined) bucket.set(mp.alias, v);
          else if (mp.op === 'min' ? compareScalar(v, cur) < 0 : compareScalar(v, cur) > 0) bucket.set(mp.alias, v);
        }
        // count_distinct 不在这里处理
      }
    }
  }

  const outCols = [...groupBy, ...metricPlan.map((m) => m.alias)];
  const rows = order.map((key) => {
    const g = groups.get(key);
    const row = [...g.gv];
    for (const mp of metricPlan) {
      if (mp.op === 'avg') {
        const sum = g.sum.get(mp.alias) ?? 0;
        const cnt = g.cnt.get(mp.alias) ?? 0;
        row.push(cnt === 0 ? null : sum / cnt);
      } else if (mp.op === 'sum') {
        row.push(g.sum.get(mp.alias) ?? null);
      } else if (mp.op === 'count') {
        row.push(g.cnt.get(mp.alias) ?? 0);
      } else if (mp.op === 'min') {
        row.push(g.min.get(mp.alias) ?? null);
      } else if (mp.op === 'max') {
        row.push(g.max.get(mp.alias) ?? null);
      } else if (mp.op === 'count_distinct') {
        const sets = distinctSets.get(mp.alias)?.get(key);
        row.push(sets ? sets.union.size : 0);
      } else {
        row.push(null);
      }
    }
    return row;
  });

  if (sort.length) {
    rows.sort((a, b) => {
      for (const s of sort) {
        const idx = outCols.indexOf(s.field);
        const c = compareScalar(a[idx], b[idx]);
        if (c !== 0) return s.desc ? -c : c;
      }
      return 0;
    });
  }
  return { columns: outCols, rows: rows.slice(offset, offset + limit) };
}
