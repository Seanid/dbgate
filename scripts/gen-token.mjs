#!/usr/bin/env node
// D7 工具之一：生成访问 token（48 位十六进制强随机）。
// 用法：
//   node scripts/gen-token.mjs                      # 打印新 token + local.json 片段
//   node scripts/gen-token.mjs --actor report-bot   # 指定 actor
//   node scripts/gen-token.mjs --apps app_1001,app_1002 --write
//                                                    # 追加写入 config/local.json（先读后写，保留原文件）
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LOCAL_PATH = join(ROOT, 'config', 'local.json');

function parseArgs(argv) {
  const out = { actor: 'agent', apps: [], write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--actor') out.actor = argv[++i];
    else if (a === '--apps') out.apps = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--write') out.write = true;
    else {
      console.error(`未知参数: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function loadLocal() {
  if (!existsSync(LOCAL_PATH)) return { tokens: [] };
  const raw = readFileSync(LOCAL_PATH, 'utf8');
  // local.json 可能含注释（JSONC）——此处仅追加，不改动原内容结构；
  // 用最小剥离（去 // 行注释与 /* */ 块注释）后 JSON.parse，失败则原样返回空结构并提示。
  try {
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    const obj = JSON.parse(stripped);
    return { obj, raw };
  } catch {
    console.error(`无法解析 ${LOCAL_PATH}（请检查 JSON/JSONC 语法），未做任何写入。`);
    process.exit(1);
  }
}

const { actor, apps, write } = parseArgs(process.argv.slice(2));
const token = randomBytes(24).toString('hex');

const entry = { token, actor, allowApps: apps };
console.log('新 token（只显示一次，请妥善保存）:');
console.log(`  ${token}`);
console.log('\n写入 config/local.json 的片段:');
console.log(JSON.stringify({ tokens: [entry] }, null, 2));

if (write) {
  const { obj } = loadLocal();
  if (!Array.isArray(obj.tokens)) obj.tokens = [];
  obj.tokens.push(entry);
  writeFileSync(LOCAL_PATH, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  console.log(`\n已追加写入 ${LOCAL_PATH}（共 ${obj.tokens.length} 个 token）。`);
  console.log('提醒：修改配置后重启服务；不要在仓库中提交该文件。');
}
