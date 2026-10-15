// appid 清单 + 归一化碰撞检测（§4.5、Q2）。
// 清单来源：所有 token 的 allowApps 并集（config.tokens）。
import { normalizeAppid } from './shard.js';

/** 收集全部已知 appid（token allowApps 并集）。 */
export function collectAppids(config) {
  const set = new Set();
  for (const t of config.tokens ?? []) {
    for (const a of t.allowApps ?? []) set.add(String(a));
  }
  return [...set];
}

/**
 * 碰撞检测：不同 appid 归一化后不得同名（§4.5）。
 * 例：`adpoa-ke` 与 `adpoa_ke` 归一化均为 `adpoa_ke` → 指向同一物理表，隔离被击穿。
 * @returns {Array<{a:string,b:string,normalized:string}>}
 */
export function detectCollisions(appids) {
  const map = new Map();
  const collisions = [];
  for (const appid of appids) {
    const n = normalizeAppid(appid);
    if (map.has(n)) {
      collisions.push({ a: map.get(n), b: appid, normalized: n });
    } else {
      map.set(n, appid);
    }
  }
  return collisions;
}

/** 授权模式是否为通配（含 `*`）。 */
export function isWildcardPattern(p) {
  return String(p).includes('*');
}

/**
 * 授权模式匹配（§8.2：token allowApps 与请求 appid 的匹配，支持通配）：
 * - `*` 匹配任意 appid（全通配）
 * - 以 `*` 结尾的前缀模式，如 `app_*` 匹配 `app_1001`、`adpoa-*` 匹配 `adpoa-ke`
 * - 其余按精确匹配
 * @param {string} pattern allowApps 中的授权项
 * @param {string} appid 请求 appid
 */
export function matchesAppid(pattern, appid) {
  const p = String(pattern);
  const a = String(appid);
  if (p === '*') return true;
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1);
    return a.startsWith(prefix);
  }
  if (p.includes('*')) {
    // 中间/多段通配：转为正则（仅支持 * 通配，其余字符按字面）
    const re = new RegExp(`^${p.split('*').map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(a);
  }
  return p === a;
}

/**
 * 把某个 token 的授权模式展开为实际可查 appid 清单。
 * - 含具体 appid 的项原样保留
 * - 通配项在 known 中展开匹配的具体 appid
 * - 展开结果为空时保留通配原样（避免输出空清单误导）
 * @param {string[]} allowApps token 授权模式
 * @param {string[]} known 已知 appid 全集（collectAppids）
 * @returns {{apps:string[], note?:string}}
 */
export function expandAppids(allowApps, known) {
  const patterns = [...(allowApps ?? [])];
  const concrete = patterns.filter((p) => !isWildcardPattern(p));
  const wildcards = patterns.filter(isWildcardPattern);
  const apps = new Set(concrete);
  for (const w of wildcards) {
    let hit = false;
    for (const k of known) {
      if (k !== w && matchesAppid(w, k)) { apps.add(k); hit = true; }
    }
    if (!hit) apps.add(w); // 无可展开的具体 appid：保留通配项本身
  }
  return { apps: [...apps].sort() };
}
