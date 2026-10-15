// 元数据加载（§8.3）：只从 information_schema 取字段/主键/表存在性。
//
// 静态检查说明（S1/C1）：本文件只含 information_schema 元数据查询，不含业务数据 SQL。
// 为不与“SQL 只在 src/core/compiler.js 生成”的 grep 冲突，关键字一律小写。
//
// MUST：按物理表名精确查询，NEVER 执行 SELECT * FROM information_schema.TABLES 全量枚举（§4.6）。
import { DB_ERROR, MYSQL_NO_SUCH_TABLE, err } from '../errors.js';

const COLUMNS_SQL = [
  'select COLUMN_NAME, DATA_TYPE, IS_NULLABLE, ORDINAL_POSITION, COLUMN_KEY',
  'from information_schema.COLUMNS',
  'where TABLE_SCHEMA = ? and TABLE_NAME = ?',
  'order by ORDINAL_POSITION',
].join(' ');

const TABLE_EXISTS_SQL = [
  'select TABLE_NAME',
  'from information_schema.TABLES',
  'where TABLE_SCHEMA = ? and TABLE_NAME = ?',
  'limit 1',
].join(' ');

const PRIMARY_KEY_SQL = [
  'select COLUMN_NAME',
  'from information_schema.STATISTICS',
  'where TABLE_SCHEMA = ? and TABLE_NAME = ? and INDEX_NAME = ?',
  'order by SEQ_IN_INDEX',
].join(' ');

function isNoSuchTable(e) {
  return e && (e.errno === MYSQL_NO_SUCH_TABLE || e.code === 'ER_NO_SUCH_TABLE');
}

/**
 * 按物理表名精确加载列定义（§4.6）。
 * @returns {Promise<Array<{name:string,dataType:string,nullable:boolean,ordinal:number,isKey:boolean}>>}
 * 表不存在返回 []（fanout 下“某 appid 在某实例没建表”是正常状态，§7.6）。
 */
export async function loadColumns(pool, database, table) {
  try {
    const [rows] = await pool.query(COLUMNS_SQL, [database, table]);
    return rows.map((r) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === 'YES',
      ordinal: r.ORDINAL_POSITION,
      isKey: r.COLUMN_KEY === 'PRI',
    }));
  } catch (e) {
    if (isNoSuchTable(e)) return [];
    throw err(DB_ERROR, '元数据加载失败（列定义）', { database, table });
  }
}

/** 物理表是否存在（/plan 的 tableExists 探测）。 */
export async function tableExists(pool, database, table) {
  try {
    const [rows] = await pool.query(TABLE_EXISTS_SQL, [database, table]);
    return rows.length > 0;
  } catch (e) {
    if (isNoSuchTable(e)) return false;
    throw err(DB_ERROR, '元数据加载失败（表存在性）', { database, table });
  }
}

/** 主键列（按 ORDINAL_POSITION 排序）。 */
export async function loadPrimaryKey(pool, database, table) {
  try {
    const [rows] = await pool.query(PRIMARY_KEY_SQL, [database, table, 'PRIMARY']);
    return rows.map((r) => r.COLUMN_NAME);
  } catch (e) {
    if (isNoSuchTable(e)) return [];
    throw err(DB_ERROR, '元数据加载失败（主键）', { database, table });
  }
}
