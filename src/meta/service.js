// 元数据服务：loader + TTL 缓存（§8.3 缓存表）。
import { TtlCache } from './cache.js';
import { loadColumns, tableExists, loadPrimaryKey } from './loader.js';

export class MetaService {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {PoolManager} deps.pools
   */
  constructor({ config, pools }) {
    this.config = config;
    this.pools = pools;
    this.cache = new TtlCache((config.runtime.metaCacheTtlSec ?? 300) * 1000);
  }

  _key(instance, database, table) {
    return `${instance}\u0000${database}\u0000${table}`;
  }

  /** 列定义（TTL 缓存；表不存在返回 []）。 */
  async columns(instance, database, table) {
    const k = this._key(instance, database, table);
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const pool = this.pools.get(instance, database);
    const cols = await loadColumns(pool, database, table);
    this.cache.set(k, cols);
    return cols;
  }

  /** 表存在性（短 TTL，预检端点用）。 */
  async exists(instance, database, table) {
    const k = `exists\u0000${this._key(instance, database, table)}`;
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const pool = this.pools.get(instance, database);
    const ok = await tableExists(pool, database, table);
    this.cache.set(k, ok, 10_000);
    return ok;
  }

  /** 主键列。 */
  async primaryKey(instance, database, table) {
    const k = `pk\u0000${this._key(instance, database, table)}`;
    const cached = this.cache.get(k);
    if (cached !== undefined) return cached;
    const pool = this.pools.get(instance, database);
    const pk = await loadPrimaryKey(pool, database, table);
    this.cache.set(k, pk);
    return pk;
  }

  invalidate(instance, database, table) {
    if (arguments.length === 0) this.cache.clear();
    else this.cache.invalidate(this._key(instance, database, table));
  }
}
