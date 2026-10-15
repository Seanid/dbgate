#!/usr/bin/env node
// CLI：打印全部已声明表的实例范围决议表（§5.5）。
// 用法：node scripts/table-scope.js
// 只做配置读取 + 求值，不连接数据库。
import { loadConfig } from '../src/config/loader.js';
import { buildTableScope, formatScope } from '../src/plan/tableScope.js';
import { collectAppids, detectCollisions } from '../src/plan/appidRegistry.js';

try {
  const config = loadConfig();
  const scope = buildTableScope(config);

  const appids = collectAppids(config);
  const collisions = detectCollisions(appids);

  console.log('DBGate 表路由决议表（启动冻结）');
  console.log('================================');
  console.log('表 tableKey                命中规则                  实例范围');
  console.log(formatScope(scope));
  console.log('================================');
  console.log(`业务类型: ${Object.keys(config.bizTypes).join(', ')}`);
  console.log(`已声明表数: ${Object.keys(scope.byTable).length}`);
  console.log(`已知 appid 数: ${appids.length}${collisions.length ? `  ⚠ 碰撞 ${collisions.length} 组（启动将失败）` : ''}`);
  if (collisions.length) {
    for (const c of collisions) console.log(`  - "${c.a}" 与 "${c.b}" 归一化均为 "${c.normalized}"`);
  }
  console.log('\n配置校验: PASS（V1~V9）');
} catch (e) {
  console.error(`[DBGate] 启动校验失败：${e.message}`);
  process.exit(1);
}
