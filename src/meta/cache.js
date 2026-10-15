// 元数据 TTL 缓存（§8.3）。
// 只缓存：字段元数据（metaCacheTtlSec）、实例连通状态（health）。
// 不缓存：执行计划（C6）、分表后缀（纯字符串运算）。

export class TtlCache {
  /**
   * @param {number} defaultTtlMs 默认 TTL（毫秒）
   */
  constructor(defaultTtlMs = 300_000) {
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  async getOrSet(key, producer, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await producer();
    this.set(key, value, ttlMs);
    return value;
  }

  invalidate(key) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}
