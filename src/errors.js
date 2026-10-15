// 统一错误类型与错误码（§6.4）。
// 启动期专用错误码（TABLE_ROUTE_CONFLICT / TABLE_ROUTE_EMPTY / CONFIG_INVALID / SCHEMA_MISMATCH）
// 只出现在启动校验中，不出现在 API 响应中。

export class DbGateError extends Error {
  /**
   * @param {string} code  §6.4 错误码
   * @param {string} message 面向 Agent / 用户的信息
   * @param {object} [details] 结构化附加信息
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DbGateError';
    this.code = code;
    this.details = details;
  }
}

export function err(code, message, details = undefined) {
  return new DbGateError(code, message, details);
}

// —— 启动期专用错误（不出现在 API 响应中）——
export const CONFIG_INVALID = 'CONFIG_INVALID';
export const TABLE_ROUTE_CONFLICT = 'TABLE_ROUTE_CONFLICT';
export const TABLE_ROUTE_EMPTY = 'TABLE_ROUTE_EMPTY';
export const SCHEMA_MISMATCH = 'SCHEMA_MISMATCH';

// —— API 错误码（§6.4）——
export const AUTH_MISSING = 'AUTH_MISSING';
export const AUTH_INVALID = 'AUTH_INVALID';
export const APPID_REQUIRED = 'APPID_REQUIRED';
export const APPID_NOT_ALLOWED = 'APPID_NOT_ALLOWED';
export const APPID_MISMATCH = 'APPID_MISMATCH';
export const APPID_INVALID = 'APPID_INVALID';
export const TABLE_NOT_FOUND = 'TABLE_NOT_FOUND';
export const TABLE_NOT_ALLOWED = 'TABLE_NOT_ALLOWED';
export const BIZ_TYPE_NOT_FOUND = 'BIZ_TYPE_NOT_FOUND';
export const FIELD_NOT_ALLOWED = 'FIELD_NOT_ALLOWED';
export const OPERATOR_NOT_ALLOWED = 'OPERATOR_NOT_ALLOWED';
export const PARAM_INVALID = 'PARAM_INVALID';
export const SHARD_TABLE_MISSING = 'SHARD_TABLE_MISSING';
export const PLAN_TOO_BROAD = 'PLAN_TOO_BROAD';
export const INSTANCE_UNAVAILABLE = 'INSTANCE_UNAVAILABLE';
export const PARTIAL_FAILURE = 'PARTIAL_FAILURE';
export const QUERY_TIMEOUT = 'QUERY_TIMEOUT';
export const CARDINALITY_EXCEEDED = 'CARDINALITY_EXCEEDED';
export const LIMIT_EXCEEDED = 'LIMIT_EXCEEDED';
export const DB_ERROR = 'DB_ERROR';

// MySQL 错误码
export const MYSQL_NO_SUCH_TABLE = 1146; // ER_NO_SUCH_TABLE
export const MYSQL_BAD_FIELD = 1054; // ER_BAD_FIELD_ERROR
export const MYSQL_ACCESS_DENIED = 1045; // ER_ACCESS_DENIED_ERROR
export const MYSQL_MAX_EXEC_TIME = 3024; // ER_QUERY_TIMEOUT(MAX_EXECUTION_TIME 触发)
export const MYSQL_LOCK_WAIT = 1205;
export const MYSQL_DEADLOCK = 1213;
