#!/usr/bin/env node
// CLI：打印单表执行计划（§10 配置变更后必做预检之一）。
// 用法：node scripts/plan.js <appid> <table>
// 纯计划计算，不连接数据库（目标表是否存在由 /plan 端点做 DB 探测）。
import { loadConfig } from '../src/config/loader.js';
import { buildTableScope } from '../src/plan/tableScope.js';
import { buildPlan } from '../src/plan/planner.js';

const [appid, table] = process.argv.slice(2);
if (!appid || !table) {
  console.error('用法: node scripts/plan.js <appid> <table>');
  console.error('示例: node scripts/plan.js app_1001 orders');
  process.exit(2);
}

try {
  const config = loadConfig();
  const scope = buildTableScope(config);
  const plan = buildPlan({ config, scope, appid, table });

  console.log(`计划预检: appid=${appid} table=${table}`);
  console.log('================================');
  console.log(`业务类型:    ${plan.bizType}`);
  console.log(`遍历模式:    ${plan.traversal}`);
  console.log(`命中规则:    ${plan.matchedRule ?? '(无，回落业务)'}`);
  console.log(`归一化后缀:  ${plan.shardSuffix}`);
  console.log(`分表:        ${plan.sharded ? `{前缀}_${plan.shardSuffix}` : '不分表（逻辑表名）'}`);
  console.log(`目标数:      ${plan.targetCount}（上限 ${config.limits.maxTargetsPerQuery}）`);
  console.log(`预估成本:    ${plan.estimatedCost}`);
  console.log(`失败策略:    ${plan.failurePolicy}`);
  console.log('--------------------------------');
  for (const t of plan.targets) {
    console.log(`  ${t.instance.padEnd(10)} ${t.database}/${t.table}`);
  }
  console.log('================================');
  console.log('预检通过：目标数符合预期；请人工确认每个成员实例都被覆盖到。');
} catch (e) {
  console.error(`[DBGate] 计划生成失败：${e.code ?? 'ERROR'}: ${e.message}`);
  if (e.details) console.error(JSON.stringify(e.details, null, 2));
  process.exit(1);
}
