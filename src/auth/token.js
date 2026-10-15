// Bearer Token → actor + allowApps（§8.2：appid 是权限边界）。
// 恒定时间比较，避免时序侧信道泄露 token。
import { createHash, timingSafeEqual } from 'node:crypto';
import { AUTH_MISSING, AUTH_INVALID, err } from '../errors.js';

function digest(s) {
  return createHash('sha256').update(String(s), 'utf8').digest();
}

/**
 * 创建 token 校验器。
 * @param {object} config 已校验配置（config.tokens: [{token, actor, allowApps, tables?}]）
 * @returns {(token: string|null) => {actor:string, allowApps:string[], tables:string[]} | null}
 *   tables 缺省视为 ["*"]（全部可查）
 */
export function createTokenValidator(config) {
  const entries = (config.tokens ?? []).map((t) => ({ ...t, hash: digest(t.token) }));
  return (token) => {
    if (!token || typeof token !== 'string' || token.length === 0) return null;
    const h = digest(token);
    for (const e of entries) {
      if (e.hash.length === h.length && timingSafeEqual(e.hash, h)) {
        return { actor: e.actor, allowApps: [...e.allowApps], tables: [...(e.tables ?? ['*'])] };
      }
    }
    return null;
  };
}

/** 从 Authorization 头解析 token（"Bearer <token>"）。 */
export function extractBearer(authorization) {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
  return m ? m[1] : null;
}

export function requireToken(validate, token) {
  if (!token) throw err(AUTH_MISSING, '缺少访问令牌，请携带 Authorization: Bearer <token>');
  const ctx = validate(token);
  if (!ctx) throw err(AUTH_INVALID, '访问令牌无效');
  return ctx;
}
