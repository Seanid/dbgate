// 分表后缀：归一化 + 字符集/长度校验（§4.2、§4.5）。
// 归一化规则写死：toLowerCase + '-'→'_'。不提供配置开关（MUST NOT）。
import { APPID_INVALID, err } from '../errors.js';

export const MAX_TABLE_NAME_LEN = 64;
const SUFFIX_RE = /^[a-z0-9_]+$/;

/** 归一化 appid：只用于拼物理表名，不回写条件值（§4.4）。 */
export function normalizeAppid(appid) {
  return String(appid).toLowerCase().replace(/-/g, '_');
}

/**
 * 后缀校验（计划阶段 MUST，任一不过即拒绝，§4.5）：
 * - 字符集：归一化后匹配 ^[a-z0-9_]+$
 * - 长度：len(prefix) + 1 + len(suffix) ≤ 64
 * 失败抛 APPID_INVALID（错误信息含实际长度）。
 * @returns {{ suffix: string, tableName: string }}
 */
export function validateSuffix({ appid, prefix }) {
  const raw = String(appid ?? '');
  const suffix = normalizeAppid(raw);
  if (!SUFFIX_RE.test(suffix)) {
    throw err(APPID_INVALID, `appid "${appid}" 归一化后为 "${suffix}"，含非法字符（仅允许小写字母、数字、下划线）`, { appid, normalized: suffix });
  }
  const tableName = prefix ? `${prefix}_${suffix}` : suffix;
  if (tableName.length > MAX_TABLE_NAME_LEN) {
    throw err(APPID_INVALID, `appid "${appid}" 拼接后的物理表名长度 ${tableName.length} 超过上限 ${MAX_TABLE_NAME_LEN}`, {
      appid,
      prefix,
      tableName,
      length: tableName.length,
      limit: MAX_TABLE_NAME_LEN,
    });
  }
  return { suffix, tableName };
}

/**
 * 拼物理表名：{tablePrefix}_{归一化(appid)}（§4.1 唯一规则）。
 * 调用方需保证前缀长度 + 后缀已通过 validateSuffix 校验。
 */
export function physicalTableName(prefix, appid) {
  return `${prefix}_${normalizeAppid(appid)}`;
}
