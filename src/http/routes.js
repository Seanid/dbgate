// HTTP 路由（§6.2）：10 个端点，仅 /health 免鉴权。
// 入参 schema（zod）中不存在任何 `sql` 字段（C5）；C3：本文件只 import queryCore。
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extractBearer, requireToken } from '../auth/token.js';
import {
  AUTH_MISSING, AUTH_INVALID, APPID_MISMATCH, APPID_NOT_ALLOWED,
  TABLE_NOT_FOUND, QUERY_TIMEOUT, PARTIAL_FAILURE, INSTANCE_UNAVAILABLE,
} from '../errors.js';

// 文档目录（项目根）：/docs 端点对外暴露 README.md / TABLES.md（免鉴权，与 /health 一致）
const DOC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = {
  readme: { file: 'README.md', title: 'DBGate 使用文档', contentType: 'text/markdown; charset=utf-8' },
  tables: { file: 'TABLES.md', title: '可查表清单（U3+L3）', contentType: 'text/markdown; charset=utf-8' },
  api: { file: 'API.md', title: 'HTTP 接口与 MCP 工具说明', contentType: 'text/markdown; charset=utf-8' },
};

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

const recordsBody = z.object({
  bizType: z.string().optional(),
  appid: z.string().optional(),
  fields: z.array(z.string()).optional(),
  filters: z.array(filterSchema).optional(),
  sort: z.array(sortSchema).optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});
const countBody = z.object({
  bizType: z.string().optional(),
  appid: z.string().optional(),
  filters: z.array(filterSchema).optional(),
});
const aggregateBody = z.object({
  bizType: z.string().optional(),
  appid: z.string().optional(),
  filters: z.array(filterSchema).optional(),
  groupBy: z.array(z.string()).optional(),
  metrics: z.array(metricSchema).optional(),
  sort: z.array(sortSchema).optional(),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});

function statusFor(code) {
  switch (code) {
    case AUTH_MISSING:
    case AUTH_INVALID: return 401;
    case APPID_NOT_ALLOWED: return 403;
    case TABLE_NOT_FOUND: return 404;
    case QUERY_TIMEOUT: return 408;
    case PARTIAL_FAILURE:
    case INSTANCE_UNAVAILABLE: return 502;
    default: return 400;
  }
}

/**
 * 注册全部端点。
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerRoutes(app, { config, queryCore, audit, pools }) {
  // 鉴权（§8.2）：除 /health、/docs 外均需 Bearer Token
  app.addHook('preHandler', async (req) => {
    if (req.url === '/health' || req.url.startsWith('/docs')) return;
    const token = extractBearer(req.headers.authorization);
    const authCtx = requireToken(queryCore.tokenValidator, token);
    req.auth = authCtx;
    req.requestId = randomUUID();
  });

  const ctx = (req) => ({
    actor: req.auth.actor,
    allowApps: req.auth.allowApps,
    tables: req.auth.tables,
    transport: 'http',
    requestId: req.requestId,
  });

  const send = (reply, res) => {
    if (res.ok) return reply.send(res);
    return reply.code(statusFor(res.error.code)).send(res);
  };

  const paramErr = (reply, requestId, message) => send(reply, {
    ok: false,
    requestId,
    error: { code: 'PARAM_INVALID', message },
  });

  // 路径 appid 与请求体 appid 一致性（APPID_MISMATCH，§6.4）
  const checkBodyAppid = (reply, body, pathAppid, requestId) => {
    if (body && body.appid !== undefined && body.appid !== null && String(body.appid) !== String(pathAppid)) {
      send(reply, {
        ok: false,
        requestId,
        error: { code: APPID_MISMATCH, message: `路径 appid "${pathAppid}" 与请求体 appid "${body.appid}" 不一致` },
      });
      return false;
    }
    return true;
  };

  // GET /health — 免鉴权：健康检查 + 各实例连通状态 + 表数量（§4.6 SHOULD）
  app.get('/health', async (_req, reply) => {
    const probes = await pools.probeAll();
    reply.send({
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      version: '1.0.0',
      tableCount: Object.keys(config.tables).length,
      instanceCount: Object.keys(config.instances).length,
      instances: probes,
    });
  });

  // GET /docs — 免鉴权：对外暴露的文档索引（README / TABLES）
  app.get('/docs', async (_req, reply) => {
    const docs = Object.entries(DOCS).map(([name, d]) => ({
      name,
      title: d.title,
      url: `/docs/${name}`,
    }));
    reply.send({ ok: true, data: { docs } });
  });

  // GET /docs/:name — 免鉴权：返回文档原文（text/markdown）
  app.get('/docs/:name', async (req, reply) => {
    const entry = DOCS[req.params.name];
    if (!entry) {
      return reply.code(404).send({
        ok: false,
        error: { code: 'DOC_NOT_FOUND', message: `文档 "${req.params.name}" 不存在；可用 /docs 查看清单` },
      });
    }
    try {
      const content = await readFile(path.join(DOC_DIR, entry.file), 'utf8');
      reply.header('content-type', entry.contentType).send(content);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return reply.code(404).send({
          ok: false,
          error: { code: 'DOC_NOT_FOUND', message: `文档文件 ${entry.file} 不存在` },
        });
      }
      return reply.code(500).send({ ok: false, error: { code: 'DOC_READ_ERROR', message: '文档读取失败' } });
    }
  });

  // GET /v1/apps
  app.get('/v1/apps', async (req, reply) => {
    const res = await queryCore.listApps(ctx(req));
    send(reply, res);
  });

  // GET /v1/biz-types
  app.get('/v1/biz-types', async (req, reply) => {
    const res = await queryCore.listBizTypes(ctx(req));
    send(reply, res);
  });

  // GET /v1/apps/:appid/tables
  app.get('/v1/apps/:appid/tables', async (req, reply) => {
    const { appid } = req.params;
    const res = await queryCore.listTables(ctx(req), { appid, bizType: req.query?.bizType });
    send(reply, res);
  });

  // GET /v1/apps/:appid/tables/:table/schema
  app.get('/v1/apps/:appid/tables/:table/schema', async (req, reply) => {
    const { appid, table } = req.params;
    const res = await queryCore.describeTable(ctx(req), { appid, table });
    send(reply, res);
  });

  // GET /v1/apps/:appid/tables/:table/plan — 执行计划预检
  app.get('/v1/apps/:appid/tables/:table/plan', async (req, reply) => {
    const { appid, table } = req.params;
    const res = await queryCore.plan(ctx(req), { appid, table });
    send(reply, res);
  });

  // POST /v1/apps/:appid/tables/:table/records
  app.post('/v1/apps/:appid/tables/:table/records', async (req, reply) => {
    const { appid, table } = req.params;
    const parsed = recordsBody.safeParse(req.body ?? {});
    if (!parsed.success) return paramErr(reply, req.requestId, `请求体校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (!checkBodyAppid(reply, parsed.data, appid, req.requestId)) return;
    const res = await queryCore.query(ctx(req), { appid, table, ...parsed.data });
    send(reply, res);
  });

  // POST /v1/apps/:appid/tables/:table/aggregate
  app.post('/v1/apps/:appid/tables/:table/aggregate', async (req, reply) => {
    const { appid, table } = req.params;
    const parsed = aggregateBody.safeParse(req.body ?? {});
    if (!parsed.success) return paramErr(reply, req.requestId, `请求体校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (!checkBodyAppid(reply, parsed.data, appid, req.requestId)) return;
    const res = await queryCore.aggregate(ctx(req), { appid, table, ...parsed.data });
    send(reply, res);
  });

  // POST /v1/apps/:appid/tables/:table/count
  app.post('/v1/apps/:appid/tables/:table/count', async (req, reply) => {
    const { appid, table } = req.params;
    const parsed = countBody.safeParse(req.body ?? {});
    if (!parsed.success) return paramErr(reply, req.requestId, `请求体校验失败：${parsed.error.issues.map((i) => i.message).join('; ')}`);
    if (!checkBodyAppid(reply, parsed.data, appid, req.requestId)) return;
    const res = await queryCore.count(ctx(req), { appid, table, ...parsed.data });
    send(reply, res);
  });

  // GET /v1/audit/recent
  app.get('/v1/audit/recent', async (req, reply) => {
    const n = Math.min(500, Number(req.query?.n ?? 50) || 50);
    const entries = await audit.recent(n);
    send(reply, { ok: true, requestId: req.requestId, data: { entries } });
  });
}
