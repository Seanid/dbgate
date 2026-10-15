// Fastify HTTP 服务：仅监听 127.0.0.1（§8.1 L1）。
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';
import { DbGateError } from '../errors.js';

function statusFor(code) {
  switch (code) {
    case 'AUTH_MISSING':
    case 'AUTH_INVALID': return 401;
    case 'APPID_NOT_ALLOWED':
    case 'TABLE_NOT_ALLOWED': return 403;
    case 'TABLE_NOT_FOUND': return 404;
    case 'QUERY_TIMEOUT': return 408;
    case 'PARTIAL_FAILURE':
    case 'INSTANCE_UNAVAILABLE': return 502;
    default: return 400;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {QueryCore} deps.queryCore
 * @param {AuditLogger} deps.audit
 * @param {PoolManager} deps.pools
 * @param {object} deps.log pino
 */
export async function startHttp({ config, queryCore, audit, pools, log }) {
  const app = Fastify({ loggerInstance: log });
  // 统一错误 → 响应信封（§6.4）。鉴权钩子抛出的 DbGateError 也在这里转成 401 等。
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof DbGateError) {
      reply.code(statusFor(error.code)).send({
        ok: false,
        requestId: req.requestId ?? null,
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      });
      return;
    }
    if (error?.statusCode && error.statusCode < 500) {
      // 入参结构错误（zod / fastify 校验）
      reply.code(error.statusCode).send({
        ok: false,
        requestId: req.requestId ?? null,
        error: { code: 'PARAM_INVALID', message: error.message },
      });
      return;
    }
    req.log?.error({ err: error }, '未处理的服务端错误');
    reply.code(500).send({
      ok: false,
      requestId: req.requestId ?? null,
      error: { code: 'DB_ERROR', message: '服务端内部错误，请查看日志' },
    });
  });
  await registerRoutes(app, { config, queryCore, audit, pools });
  await app.listen({ host: config.http.host, port: config.http.port });
  log.info({ host: config.http.host, port: config.http.port }, 'HTTP 服务已启动');
  return app;
}
