// 每个 (实例, database) 一个独立连接池（§1.1、§7.4）。
// 一个实例可绑定多个 database（逗号分隔，§3.2）：每个库各自建池，查询按库遍历。
// lazy=false 创建池（mysql2 惰性连接，不实际连库）；lazy=true 首次使用时才创建。
// 健康探测带 TTL 缓存与短超时，避免探测拖慢请求。
import mysql from 'mysql2/promise';
import { INSTANCE_UNAVAILABLE, err } from '../errors.js';
import { splitDatabases } from '../config/schema.js';

const SHORT_TIMEOUT_MS = 3000;

export class PoolManager {
  /**
   * @param {object} config 已校验配置（config.instances）
   * @param {object} log pino logger
   */
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.pools = new Map(); // "instance\u0000database" -> mysql pool
    this.healthCache = new Map(); // key -> { at, status }
  }

  /** 实例的全部 database（拆分逗号分隔）。 */
  databasesOf(instanceName) {
    const cfg = this.config.instances[instanceName];
    if (!cfg) throw err(INSTANCE_UNAVAILABLE, `未知实例 "${instanceName}"`, { instance: instanceName });
    return splitDatabases(cfg);
  }

  _key(instanceName, database) {
    return `${instanceName}\u0000${database}`;
  }

  /** 取得 (实例, database) 连接池（按需创建）。database 缺省时取该实例首个库。 */
  get(instanceName, database) {
    const cfg = this.config.instances[instanceName];
    if (!cfg) throw err(INSTANCE_UNAVAILABLE, `未知实例 "${instanceName}"`, { instance: instanceName });
    if (!database) database = splitDatabases(cfg)[0];
    const key = this._key(instanceName, database);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = mysql.createPool({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database,
        connectionLimit: cfg.connectionLimit ?? 8,
        connectTimeout: SHORT_TIMEOUT_MS,
        waitForConnections: true,
        charset: 'utf8mb4',
        namedPlaceholders: false,
      });
      pool.on('connection', (conn) => {
        // pool 的 connection 事件回调收到的是底层原生 callback 连接（非 PromisePoolConnection），
        // 用 callback 风格执行会话级只读设置，避免 promise 接口误用
        conn.query('SET SESSION TRANSACTION READ ONLY', () => {});
        conn.query('SET SESSION sql_mode = ?', ['STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'], () => {});
      });
      this.pools.set(key, pool);
      this.log.info({ instance: instanceName, database }, '连接池已创建');
    }
    return pool;
  }

  /**
   * 单 (实例, database) 连通探测（TTL 缓存，默认 30s，§8.3）。不抛错，返回状态。
   * @returns {Promise<{instance:string, database:string, connected:boolean, latencyMs?:number, error?:string}>}
   */
  async probe(instanceName, database, { ttlMs } = {}) {
    ttlMs = ttlMs ?? (this.config.runtime?.instanceHealthTtlSec ?? 30) * 1000;
    const key = this._key(instanceName, database ?? this.databasesOf(instanceName)[0]);
    const cached = this.healthCache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) return cached.status;
    const status = await this._probeNow(instanceName, database ?? this.databasesOf(instanceName)[0]);
    this.healthCache.set(key, { at: Date.now(), status });
    return status;
  }

  async _probeNow(instanceName, database) {
    const start = Date.now();
    try {
      const pool = this.get(instanceName, database);
      // pool.query 为 promise 版：自动租借连接执行并释放，避免 getConnection() 返回 callback 连接的问题
      await pool.query('select 1'); // 健康探测非数据查询；用小写关键字以维持 S1「SELECT 仅命中 compiler.js」
      return { instance: instanceName, database, connected: true, latencyMs: Date.now() - start };
    } catch (e) {
      return { instance: instanceName, database, connected: false, latencyMs: Date.now() - start, error: 'INSTANCE_UNAVAILABLE' };
    }
  }

  /** 探测全部 (实例, database)（/health 用）。 */
  async probeAll() {
    const pairs = [];
    for (const [name, cfg] of Object.entries(this.config.instances)) {
      for (const database of splitDatabases(cfg)) pairs.push({ instance: name, database });
    }
    return Promise.all(pairs.map(({ instance, database }) => this.probe(instance, database)));
  }

  async close() {
    await Promise.all(
      [...this.pools.values()].map(async (p) => {
        try { await p.end(); } catch { /* 忽略 */ }
      }),
    );
    this.pools.clear();
    this.healthCache.clear();
  }
}
