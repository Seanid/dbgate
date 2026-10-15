// MCP 工具层（§6.1）：7 个工具，没有任何工具接受 SQL（C5）。
// C3：本文件只 import queryCore，不 import executor/merger/compiler。
import { z } from 'zod';
import { extractBearer, requireToken } from '../auth/token.js';
import { AUTH_INVALID } from '../errors.js';

const filterSchema = z.object({
  field: z.string().min(1),
  op: z.string().min(1),
  value: z.any().optional(),
});
const sortSchema = z.object({
  field: z.string().min(1),
  desc: z.boolean().optional(),
});
const metricSchema = z.object({
  field: z.string().min(1).nullable().optional(),
  op: z.string().min(1),
  alias: z.string().optional(),
});

/**
 * 注册 7 个 MCP 工具。
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} deps
 * @param {QueryCore} deps.queryCore
 * @param {(t:string|null)=>object|null} deps.validateToken
 * @param {string|null} deps.defaultToken MCP 无 HTTP 头，token 取环境变量 DBGATE_TOKEN，缺省用首个配置 token
 */
export function registerTools(server, { queryCore, validateToken, defaultToken }) {
  const auth = (extra) => {
    const token = process.env.DBGATE_TOKEN ?? defaultToken;
    const actx = requireToken(validateToken, token);
    return {
      actor: actx.actor,
      allowApps: actx.allowApps,
      tables: actx.tables,
      transport: 'mcp',
      requestId: extra?.requestId ?? undefined,
    };
  };

  const text = (res) => {
    if (!res.ok) return JSON.stringify({ ok: false, error: res.error }, null, 2);
    // §7.7 第 3 条：partial 时 content.text 必须含一句人能看懂的话（部分 Agent 只读文本）
    let body = JSON.stringify(res.data, null, 2);
    if (res.data?.note) body += `\n\n${res.data.note}`;
    return body;
  };

  server.registerTool('list_apps',
    {
      description: '列出当前 token 可访问的 appid（appid 是权限边界与分表键）',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: text(await queryCore.listApps(auth())) }] }));

  server.registerTool('list_biz_types',
    {
      description: '列出业务类型、遍历模式（fanout/route）、成员实例数',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: text(await queryCore.listBizTypes(auth())) }] }));

  server.registerTool('list_tables',
    {
      description: '列出指定 appid 可访问的逻辑表、所属业务、注释',
      inputSchema: { appid: z.string().describe('业务方应用标识（必填）'), bizType: z.string().optional().describe('按业务类型过滤') },
    },
    async (args) => ({ content: [{ type: 'text', text: text(await queryCore.listTables(auth(), args)) }] }));

  server.registerTool('describe_table',
    {
      description: '查看表结构：字段定义 + 权限 + 业务类型 + 预计目标数 + 注意事项。发起查询前请先用本工具确认字段名与遍历范围',
      inputSchema: { appid: z.string().describe('业务方应用标识（必填）'), table: z.string().describe('逻辑表名') },
    },
    async (args) => ({ content: [{ type: 'text', text: text(await queryCore.describeTable(auth(), args)) }] }));

  server.registerTool('count_records',
    {
      description: '按 appid + 表 + 条件计数（跨实例归并后相加）',
      inputSchema: {
        appid: z.string().describe('业务方应用标识（必填）'),
        table: z.string().describe('逻辑表名'),
        bizType: z.string().optional().describe('传入则校验与表归属一致'),
        filters: z.array(filterSchema).optional().describe('过滤条件，字段名请先用 describe_table 确认'),
      },
    },
    async (args) => ({ content: [{ type: 'text', text: text(await queryCore.count(auth(), args)) }] }));

  server.registerTool('query_records',
    {
      description:
        '主查询：appid 必填；本表可能跨多个实例，服务端自动遍历并归并；' +
        '结果中 partial:true 表示部分实例失败、数据不完整；字段名请先用 describe_table 确认。不写 SQL。',
      inputSchema: {
        appid: z.string().describe('业务方应用标识（必填，数据隔离边界）'),
        table: z.string().describe('逻辑表名'),
        bizType: z.string().optional().describe('传入则校验与表归属一致'),
        fields: z.array(z.string()).optional().describe('返回字段，省略或 ["*"] = 全部可返回字段'),
        filters: z.array(filterSchema).optional().describe('AND 连接，op: eq/ne/gt/gte/lt/lte/in/not_in/like/between/is_null/not_null'),
        sort: z.array(sortSchema).optional().describe('排序，最多 3 键；服务端自动追加主键 tie-breaker'),
        limit: z.number().int().optional().describe('默认 200，上限 500'),
        offset: z.number().int().optional().describe('遍历模式下上限收紧为 1000，建议用 filters 收窄'),
      },
    },
    async (args) => ({ content: [{ type: 'text', text: text(await queryCore.query(auth(), args)) }] }));

  server.registerTool('aggregate_records',
    {
      description:
        '分组聚合：groupBy + metrics（sum/avg/min/max/count/count_distinct）。avg 由服务端按 Σsum/Σcount 重算；' +
        'count_distinct 超基数上限会返回 CARDINALITY_EXCEEDED，建议分次查询。不写 SQL。',
      inputSchema: {
        appid: z.string().describe('业务方应用标识（必填）'),
        table: z.string().describe('逻辑表名'),
        bizType: z.string().optional(),
        filters: z.array(filterSchema).optional(),
        groupBy: z.array(z.string()).describe('分组字段，至少一个'),
        metrics: z.array(metricSchema).describe('指标：{field, op}，op ∈ sum/avg/min/max/count/count_distinct'),
        sort: z.array(sortSchema).optional().describe('仅允许对 groupBy 字段排序'),
        limit: z.number().int().optional(),
        offset: z.number().int().optional(),
      },
    },
    async (args) => ({ content: [{ type: 'text', text: text(await queryCore.aggregate(auth(), args)) }] }));
}
