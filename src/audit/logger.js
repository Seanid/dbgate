// 审计日志（§8.5）：JSONL，按天分文件 logs/audit-YYYY-MM-DD.jsonl。
// MUST：记录全部目标及其结果（targets[]）与 multiHit——fanout 架构下唯一可靠的追溯依据。
import { appendFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOG_DIR = path.resolve(__dirname, '../../logs');

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class AuditLogger {
  /**
   * @param {object} opts
   * @param {string} [opts.dir]
   * @param {object} opts.log pino（写审计异常用）
   */
  constructor({ dir = DEFAULT_LOG_DIR, log } = {}) {
    this.dir = dir;
    this.log = log ?? console;
    this.queue = Promise.resolve();
  }

  /**
   * 追加一条审计记录。按天分文件；串行落盘避免并发交错。
   * @param {object} entry 必含 ts/requestId/actor/transport；其余字段透传
   */
  write(entry) {
    this.queue = this.queue.then(async () => {
      const file = path.join(this.dir, `audit-${dayKey(new Date(entry.ts ?? Date.now()))}.jsonl`);
      await appendFile(file, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
    }).catch((e) => {
      this.log?.error?.({ err: e }, '审计写入失败');
    });
    return this.queue;
  }

  /**
   * 最近 N 条审计记录（跨最近的文件，/v1/audit/recent 用）。
   * @param {number} n
   */
  async recent(n = 50) {
    const all = [];
    try {
      const files = (await readdir(this.dir)).filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse();
      for (const f of files) {
        const text = await readFile(path.join(this.dir, f), 'utf8');
        const lines = text.split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try { all.push(JSON.parse(lines[i])); } catch { /* 跳过损坏行 */ }
          if (all.length >= n) break;
        }
        if (all.length >= n) break;
      }
    } catch { /* logs 目录不存在等：返回已有内容 */ }
    return all.slice(0, n);
  }
}
