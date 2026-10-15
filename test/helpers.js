// 测试共用：构造最小合法配置（与 §3.1 示例对齐）。
export function makeConfig(overrides = {}) {
  return {
    http: { host: '127.0.0.1', port: 8787 },
    limits: {
      defaultRows: 200,
      maxRows: 500,
      maxOffset: 10000,
      fanoutMaxOffset: 1000,
      queryTimeoutMs: 5000,
      maxFilters: 10,
      maxSortKeys: 3,
      maxInValues: 500,
      maxResponseBytes: 1048576,
      maxTargetsPerQuery: 16,
      maxConcurrency: 4,
      maxDistinctCardinality: 10000,
    },
    appId: { required: true, column: 'app_id', filterValue: 'raw' },
    missingTablePolicy: 'empty',
    runtime: { exposeTargets: true, metaCacheTtlSec: 300, onSchemaMismatch: 'warn', instanceHealthTtlSec: 30 },
    instances: {
      'shard-a': { host: '10.0.0.11', port: 3306, user: 'agent_ro', password: 'x', database: 'app_prod', connectionLimit: 8, lazy: false },
      'shard-b': { host: '10.0.0.12', port: 3306, user: 'agent_ro', password: 'x', database: 'app_prod', connectionLimit: 8, lazy: false },
      'shard-c': { host: '10.0.0.13', port: 3306, user: 'agent_ro', password: 'x', database: 'app_prod', connectionLimit: 8, lazy: false },
      'archive-1': { host: '10.0.0.20', port: 3306, user: 'agent_ro', password: 'x', database: 'app_archive', connectionLimit: 4, lazy: true },
    },
    bizTypes: {
      order: {
        traversal: 'fanout',
        members: [
          { instance: 'shard-a' }, { instance: 'shard-b' }, { instance: 'shard-c' },
        ],
        concurrency: 4,
        failurePolicy: 'bestEffort',
        warnOnMultiHit: true,
      },
      order_archive: {
        traversal: 'fanout',
        members: [{ instance: 'archive-1', tablePrefix: 'orders_arch' }],
        failurePolicy: 'strict',
      },
      payment: {
        traversal: 'route',
        route: { 'adpoa-ke': 'shard-a', 'adpoa-sz': 'shard-b' },
        members: [{ instance: 'shard-a' }, { instance: 'shard-b' }],
        failurePolicy: 'strict',
      },
    },
    tableRoutes: [
      { match: 'aaa_%', members: [{ instance: 'shard-a' }, { instance: 'shard-b' }], traversal: 'fanout' },
      { match: 'user_loan_%', bizType: 'order' },
      { match: 'report_%', bizType: 'payment', traversal: 'route' },
    ],
    tables: {
      orders: {
        bizType: 'order',
        tablePrefix: 'orders',
        defaultFields: '*',
        fields: {
          id: { filterable: true, sortable: true },
          app_id: { locked: true },
          amount: { filterable: true, sortable: true, aggregatable: true },
          created_at: { filterable: true, sortable: true },
          user_phone: { filterable: false, sortable: false, mask: 'phone' },
          internal_note: { returnable: false },
        },
      },
      order_items: { bizType: 'order', tablePrefix: 'order_items' },
      order_archive: { bizType: 'order_archive', tablePrefix: 'orders_arch' },
      order_summary: { bizType: 'order', members: [{ instance: 'shard-a' }], sharded: false },
      global_config: { bizType: 'payment', sharded: false },
      aaa_user: { bizType: 'order' },
      user_loan_summary: { bizType: 'order' },
      report_daily: { bizType: 'payment' },
    },
    tokens: [
      { token: 't1', actor: 'dev', allowApps: ['app_1001', 'app_1002', 'adpoa-ke', 'adpoa-sz'] },
    ],
    ...overrides,
  };
}

export function flat(rows) {
  return rows.map((r) => [...r]);
}
