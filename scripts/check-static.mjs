#!/usr/bin/env node
// §9.1 静态约束检查（CI 可执行）。退出码：0 全部通过；非 0 任一失败。
// 用法：node scripts/check-static.mjs
//
// S1 全仓 grep `SELECT `            → 仅命中 src/core/compiler.js（C1）
// S2 聚合合并逻辑定义                → 仅命中 src/core/merger.js（C2）
// S3 http/routes.js 与 mcp/tools.js import → 不得出现 executor/merger/compiler（C3）
// S4 编译产物断言（运行期）          → 所有值只出现在 params（C4）
// S5 全部入参 schema                 → 无 `sql` 字段（C5）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const failures = [];
let checks = 0;

function fail(name, detail) {
  checks++;
  failures.push(`[FAIL] ${name}\n       ${detail}`);
}
function pass(name) {
  checks++;
  console.log(`[PASS] ${name}`);
}

function walk(dir, out = []) {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}
const srcFiles = walk(join(ROOT, 'src'));
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

// ---- S1：SELECT 关键字只在 compiler.js（排除注释与字符串里的小写 select） ----
{
  const hits = [];
  for (const f of srcFiles) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      // 只看大写 SELECT（含空格），排除行注释
      const clean = line.replace(/\/\/.*$/, '');
      if (/\bSELECT\s/.test(clean)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  const allowed = ['src/core/compiler.js'];
  const bad = hits.filter((h) => !allowed.some((a) => h.startsWith(a)));
  if (bad.length === 0) pass('S1 SELECT 仅命中 src/core/compiler.js');
  else fail('S1 SELECT 仅命中 src/core/compiler.js', bad.join(', '));
}

// ---- S2：聚合合并逻辑的定义只在 merger.js ----
{
  const hits = [];
  for (const f of srcFiles) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const clean = line.replace(/\/\/.*$/, '');
      if (/export function merge\w+/.test(clean)) hits.push(`${rel(f)}:${i + 1}`);
      if (/throw err\(CARDINALITY_EXCEEDED/.test(clean)) hits.push(`${rel(f)}:${i + 1}`);
    });
  }
  const bad = hits.filter((h) => !h.startsWith('src/core/merger.js'));
  if (bad.length === 0) pass('S2 聚合合并逻辑定义仅命中 src/core/merger.js');
  else fail('S2 聚合合并逻辑定义仅命中 src/core/merger.js', bad.join(', '));
}

// ---- S3：接入层不得直接 import executor/merger/compiler ----
{
  const bad = [];
  for (const f of ['src/http/routes.js', 'src/mcp/tools.js']) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const line of text.split('\n')) {
      if (/^import/.test(line.trim()) && /(executor|merger|compiler)/.test(line)) {
        bad.push(`${f}: ${line.trim()}`);
      }
    }
  }
  if (bad.length === 0) pass('S3 routes.js / tools.js 不 import executor/merger/compiler');
  else fail('S3 routes.js / tools.js 不 import executor/merger/compiler', bad.join('; '));
}

// ---- S4：编译产物——值只出现在 params（C4）----
{
  try {
    const { compileSelect } = await import(pathToFileURL(join(ROOT, 'src/core/compiler.js')).href);
    const { sql, params } = compileSelect({
      database: 'app_prod',
      table: 'orders_x', // 表名与任何参数值错开，保证“值不出现在 SQL”断言无假阳性
      columns: ['id', 'amount', 'status'],
      filters: [
        { field: 'status', op: 'eq', value: "o'brien" }, // 单引号注入样本
        { field: 'amount', op: 'gte', value: 199.5 },
        { field: 'status', op: 'in', value: ['wx', 'alipay'] },
      ],
      sort: [{ field: 'id', desc: false }],
      limit: 25,
      offset: 3,
      isolationColumn: 'app_id',
      isolationValue: 'appid-9q',
      tieBreakers: ['id'],
    });
    const placeholders = (sql.match(/\?/g) ?? []).length;
    let bad = false;
    if (placeholders !== params.length) { bad = true; console.error(`   占位符 ${placeholders} ≠ params ${params.length}`); }
    for (const p of params) {
      if (sql.includes(String(p))) { bad = true; console.error(`   参数值出现在 SQL: ${p}`); }
    }
    if (!sql.includes("o'brien")) { /* 值未进 SQL：正确 */ }
    if (bad) fail('S4 编译产物：值只出现在 params', '见上方详情');
    else pass('S4 编译产物：值只出现在 params');
  } catch (e) {
    fail('S4 编译产物：值只出现在 params', `运行断言失败: ${e.message}`);
  }
}

// ---- S5：入参 schema 无 sql 字段 ----
{
  const targets = ['src/http/routes.js', 'src/mcp/tools.js'];
  const bad = [];
  for (const f of targets) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const clean = line.replace(/\/\/.*$/, '');
      if (/\bsql\s*:/.test(clean)) bad.push(`${f}:${i + 1}`);
    });
  }
  if (bad.length === 0) pass('S5 入参 schema 无 sql 字段');
  else fail('S5 入参 schema 无 sql 字段', bad.join(', '));
}

console.log(`\n静态检查完成：${checks - failures.length}/${checks} 通过`);
if (failures.length > 0) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
