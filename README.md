# DBGate 网关

本地、只读、结构化的多实例 MySQL 查询服务。Agent 不写 SQL—— 通过 MCP Server（7 工具）或 HTTP REST（10 端点，仅 `127.0.0.1:8787`）用结构化参数查询，网关负责按 appid 分表、跨实例遍历、结果归并与审计。



* **只读**：连接层 `SET SESSION TRANSACTION READ ONLY`；每实例独立只读账号（仅 `GRANT SELECT, SHOW VIEW`）

* **分表**：物理表 = `{prefix}_{归一化 appid}`（`-`→`_`、大写转小写），appid 即租户即权限边界

* **遍历**：fanout 全部成员 /route 按 appid 定位单一实例；结果由归并层保证全局有序与分页一致

* **安全**：隔离列恒定注入、全部值参数化、DB\_ERROR 原始信息不进响应、JSONL 审计、启动期配置 / 表路由 / 碰撞 / 一致性校验



***

## 1. 目录结构



```
dbgate/
├── config/
│   ├── default.json        默认 limits（JSONC）
│   ├── biz.rules.jsonc     实例 / 业务 / 表路由 / 表声明（示例）
│   └── local.json          本机覆盖：实例密码、token（已 gitignore）
├── src/
│   ├── bootstrap.js        装配链 + 决议表落盘 + 优雅退出
│   ├── errors.js           全部错误码
│   ├── config/             loader（JSONC 深合并）/ schema（zod + V1~V9 校验）
│   ├── plan/               shard / appidRegistry / tableScope / planner
│   ├── core/               唯一 SQL 生成（compiler.js）、执行、归并、字段守卫、脱敏、查询内核
│   ├── meta/               information_schema 元数据、缓存、一致性校验
│   ├── http/               10 端点（127.0.0.1:8787）
│   ├── mcp/                MCP Server（7 工具）
│   ├── auth/               Bearer token（sha256 + timingSafeEqual）
│   └── audit/              JSONL 审计（logs/audit-YYYY-MM-DD.jsonl）
├── scripts/
│   ├── plan.js             CLI：单表计划
│   ├── table-scope.js      CLI：决议表
│   ├── gen-token.mjs       CLI：生成访问 token
│   ├── check-static.mjs    静态约束 S1~S5（CI 可执行）
│   └── verify-readonly.sh  只读账号建号 SQL / 权限验证（§8.2）
├── test/                   67 个用例（node --test），覆盖 §9.3 四组关键语义
└── logs/                   审计、决议表快照、运行日志
```

## 2. 安装

要求：Node.js ≥ 22（ESM）、npm。



```
npm install
```

## 3. 配置

三层配置按 `default.json < biz.rules.jsonc < local.json` 深合并（均按 JSONC 解析，允许注释与尾逗号）。任何结构或语义问题会在**启动前**一次性报出并拒绝启动。



| 文件                | 内容                                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default.json`    | 全局 limits（`maxConcurrency`、`queryTimeoutMs`、`maxTargetsPerQuery` 等）                                                                                                                                                                                                                         |
| `biz.rules.jsonc` | 实例连接（host/port/database）、业务（遍历方式 / 成员 / 路由映射）、表路由规则、表声明（含字段白名单 / 隔离列 / 脱敏）。`instances[*].database` **支持逗号分隔多库（如&#x20;**`"db1,db2"`**），查询时对该实例的每个库都遍历并归并**；`tables[*].bizType`**&#x20;支持单值（**`"user"`**）、多值（**`"user,loan"`**，同名表在两侧库都遍历归并）与缺省（= 遍历全部业务）**；`sharded:false` 表示精确表名的全局配置表（非分表） |
| `local.json`      | **本机私密覆盖**：实例密码（示例占位 `change-me`）、token 清单。已 gitignore                                                                                                                                                                                                                                      |

### 3.1 必改项（部署前）



1. **实例密码**：把 `config/local.json` 里每个实例的 `password: "change-me"` 换成只读账号密码。

2. **token**：用下面命令生成并追加写入；示例 token `dev-token-change-me` 只用于本地冒烟，不要对外使用。



```
node scripts/gen-token.mjs --actor report-bot --apps app_1001,app_1002 --write
```

**token 可查表清单（**`tables`**&#x20;字段）**：每个 token 除 `allowApps`（可查 appid，支持 `*`/`app_*` 通配）外，可另配 `tables` 写明该 token 的可查表清单，`["*"]` 表示全部可查（缺省即视为 `["*"]`）：



```
{
  "tokens": [
    {
      "token": "<生成的 token>",
      "actor": "report-bot",
      "allowApps": ["app_*"],          // appid 授权：* 全通配 / 前缀通配 / 精确
      "tables": ["orders", "order_*"]  // 可查表清单：["*"] = 全部；order_* = 前缀通配
    }
  ]
}
```

`list_tables` 返回该 token 授权展开后的可查表（`authorizedTables` 标注原始清单）；查询未授权表返回 `TABLE_NOT_ALLOWED`（HTTP 403）。**注意：**`tables`**&#x20;是 token 级字段，不是全局配置；不配置 = 全部可查。**

## 4. 只读账号（每实例一份）



```
# 打印建号 SQL（含随机密码），到每个实例分别执行
./scripts/verify-readonly.sh --sql

# 建号后逐个验证：SELECT 可用、CREATE/INSERT 被拒（ERROR 1142）、无 PROCESS/FILE/SUPER
export DBGATE_RO_PASS='<密码>'
./scripts/verify-readonly.sh --verify 10.0.0.11 app_prod
# 或按 config 里全部实例循环验证
./scripts/verify-readonly.sh --verify-all
```

建号 SQL 模板（§8.2）：



```
CREATE USER 'agent_ro'@'%' IDENTIFIED BY '<强随机密码>';
GRANT SELECT, SHOW VIEW ON `app_prod`.* TO 'agent_ro'@'%';
GRANT SELECT ON `information_schema`.* TO 'agent_ro'@'%';
FLUSH PRIVILEGES;
```

**MUST NOT** 授予 `PROCESS` / `FILE` / `SUPER`。验证：



```
mysql -h10.0.0.11 -uagent_ro -p app_prod -e "CREATE TABLE t(i int);"
# 期望：ERROR 1142 (42000): CREATE command denied
```

连接池预算：峰值连接数 = Σ(各实例 `connectionLimit`) ×（HTTP 与 MCP 两个入口各一份）。每个实例的 `connectionLimit` 应按「并发查询数 × 单查询目标数」倒推，并确认低于实例 `max_connections`。

## 5. 启动



```
npm start            # HTTP REST，监听 127.0.0.1:8787（仅本机）
npm run mcp          # MCP Server（stdio），配 MCP Inspector / Claude 等客户端
node src/bootstrap.js http   # 等价 npm start
node src/bootstrap.js mcp    # 等价 npm run mcp
```

启动时自动完成：配置校验 → 决议表冻结（`logs/table-scope.json`）→ 跨实例 schema 一致性检查（不可达实例跳过并警告）→ 监听。`SIGINT/SIGTERM` 优雅退出。

## 6. HTTP API（10 端点，Bearer 鉴权，`/health` 免鉴权）

所有入参均为结构化 JSON，**没有&#x20;**`sql`**&#x20;字段**。请求 `Authorization: Bearer <token>`；token 的 `allowApps` 决定可查 appid（路径与 body 的 appid 必须一致），`allowApps` 支持通配：`*` 全通配、`app_*`/`adpoa-*` 前缀通配、其余精确匹配。**可查表清单与 token 绑定**：token 的 `tables` 字段写明可查表（`["*"]` = 全部可查，缺省同义）；`list_tables` 返回该 token 授权展开后的表清单并标注 `authorizedTables`，查询未授权表返回 `TABLE_NOT_ALLOWED`（403）。



| Method | Path                                      | 说明                                                  |
| ------ | ----------------------------------------- | --------------------------------------------------- |
| GET    | `/health`                                 | 健康检查（免鉴权）                                           |
| GET    | `/docs`                                   | 对外暴露的文档索引：`readme`（本文件）/ `tables`（可查表清单，免鉴权）        |
| GET    | `/docs/readme`                            | README.md 原文（text/markdown，免鉴权）                     |
| GET    | `/docs/tables`                            | TABLES.md 原文（可查表清单，免鉴权）                             |
| GET    | `/v1/apps`                                | 当前 token 可访问的 appid 清单（通配在已知 appid 中展开）             |
| GET    | `/v1/biz-types`                           | 业务类型、遍历模式（fanout/route）、成员实例数                       |
| GET    | `/v1/apps/:appid/tables`                  | 可查表清单（含 `authorizedTables`，与 token.tables 绑定）       |
| GET    | `/v1/apps/:appid/tables/:table/schema`    | 字段元数据（先调它确认字段名）                                     |
| GET    | `/v1/apps/:appid/tables/:table/plan`      | 执行计划（目标数 / 成员 /matchedRule）                         |
| POST   | `/v1/apps/:appid/tables/:table/records`   | 条件查询（filters/sort/limit/offset/fields）              |
| POST   | `/v1/apps/:appid/tables/:table/count`     | 计数                                                  |
| POST   | `/v1/apps/:appid/tables/:table/aggregate` | 聚合（sum/count/avg/min/max/count\_distinct，可 groupBy） |
| GET    | `/v1/audit/recent?n=50`                   | 最近审计记录                                              |

统一响应信封：`{ ok, data | error, requestId, ... }`。错误码（节选）：`AUTH_MISSING`/`AUTH_INVALID`/`APPID_NOT_ALLOWED`/`APPID_MISMATCH`/`APPID_INVALID`/`TABLE_NOT_FOUND`/`TABLE_NOT_ALLOWED`/`FIELD_NOT_ALLOWED`/`OPERATOR_NOT_ALLOWED`/`PLAN_TOO_BROAD`/`LIMIT_EXCEEDED`/`PARTIAL_FAILURE`/`CARDINALITY_EXCEEDED`/`QUERY_TIMEOUT`/`INSTANCE_UNAVAILABLE`/`DB_ERROR` 等。

**关键语义**



* `partial: true` 表示本次查询有实例连接失败，返回的数据**不完整**（响应 `data.note` 含人话提示，如 "本次查询有 1 个实例（shard-c）连接失败…"）

* 表不存在（MySQL 1146）按空结果处理：`ok:true, rowCount:0, missingTable:true`，**不算 partial**

* DB\_ERROR 原始信息只进日志，不进入响应

* 隔离列条件由系统恒定注入：用户过滤里的 `app_id` 条件会被规范化（与路径 appid 一致则丢弃、冲突则 `APPID_MISMATCH`）。注入规则：**分表（sharded）恒注入；非分表在表真实存在该列时也注入**（全局配置表如 `group_config`/`message_template` 带 `app_id` 列，必须按 appid 过滤，否则会返回其他 appid 的数据）；列不存在则不注入（避免 Unknown column）

* 分页排序的 tie-breaker：配置 `mergeTieBreaker` 显式给定优先；否则**自动取真实表主键列**（information\_schema 元数据）；无主键的表不追加（避免 Unknown column）。配置含 `_instance` 时由归并层按实例名补齐全局唯一键

## 7. MCP Server（7 工具）



| 工具                  | 说明                                                               |
| ------------------- | ---------------------------------------------------------------- |
| `list_apps`         | 当前 token 可访问的 appid 清单（通配在已知 appid 中展开；appid 是权限边界与分表键）          |
| `list_biz_types`    | 业务类型、遍历模式（fanout/route）、成员实例数                                    |
| `list_tables`       | 指定 appid 可访问的逻辑表、所属业务、注释（含 `authorizedTables`，与 token.tables 绑定） |
| `describe_table`    | 字段定义 + 权限 + 业务类型 + 预计目标数（发起查询前先用它确认字段名与遍历范围）                     |
| `count_records`     | 计数（跨实例归并后相加）                                                     |
| `query_records`     | 主查询：appid 必填，可能跨实例自动归并，`partial:true` 表示数据不完整                    |
| `aggregate_records` | 分组聚合：groupBy + metrics（sum/avg/min/max/count/count\_distinct）    |

工具描述内置使用提醒：appid 必填 / 可能跨实例自动归并 / `partial:true` 表示数据不完整 / 字段名先用 `describe_table` 确认。token 取环境变量 `DBGATE_TOKEN`，缺省用首个配置 token。示例配置（MCP Inspector / Claude Desktop）：



```
{
  "mcpServers": {
    "dbgate": {
      "command": "node",
      "args": ["D:/gate/dbgate/src/bootstrap.js", "mcp"],
      "env": { "DBGATE_TOKEN": "<token>" }
    }
  }
}
```

## 8. CLI



```
node scripts/table-scope.js            # 决议表：每张已声明表最终落到哪些实例
node scripts/plan.js app_1001 orders   # 单表计划：目标数、每成员物理表、matchedRule
node scripts/gen-token.mjs --write     # 生成 token 并写入 local.json
node scripts/check-static.mjs          # 静态约束 S1~S5
```

## 9. 配置变更后必做预检

改过 `biz.rules.jsonc` / `local.json` 后，**先预检再启动**：



```
node scripts/table-scope.js                 # 1) 决议表：确认每张表的目标实例符合预期
node scripts/plan.js <appid> <table>        # 2) 单表计划：目标数、物理表名、matchedRule
curl -H "Authorization: Bearer <token>" \
  "http://127.0.0.1:8787/v1/apps/<appid>/tables/<table>/plan"   # 3) 线上视角再核对一遍
```

重点核对：目标数量、每个成员是否覆盖、`matchedRule` 指向哪条规则。典型事故 —— 新 appid 未进 route 映射导致 `PARAM_INVALID`、表路由规则改后出现零命中 / 重叠（启动会直接拒绝）。

## 10. 验证



```
npm test                # 67 个单元测试（归并语义/表路由/分表后缀/编译产物）
node scripts/check-static.mjs   # S1~S5 静态约束（SELECT 仅 compiler.js、聚合仅 merger.js 等）
```

## 11. 审计



* 每条查询一行：`logs/audit-YYYY-MM-DD.jsonl`（请求、appid、目标实例、行数、耗时、`multiHit` 等），串行写、按天滚动

* 决议表冻结：`logs/table-scope.json`，配置变更后 diff 必须可解释

## 12. 安全边界（纵深防御）



1. 入参 schema：无 `sql` 字段，SQL 只在 `src/core/compiler.js` 生成（S1 静态约束）

2. 值全部参数化（C4）、标识符反引号转义、appid 字符集 / 长度校验

3. 隔离列恒定注入：即使前几层被绕过，SQL 也带 `app_id = ?`

4. token：sha256 哈希 + 恒定时间比较；appid 授权白名单

5. 每实例独立只读账号：仅 SELECT/SHOW VIEW（硬边界，前几层失效时的最后防线）

6. DB\_ERROR 原始信息不透传；查询超时用服务端 `MAX_EXECUTION_TIME` 硬限制 + 连接销毁兜底

## 13. 已知边界（按 §12 默认假设实现）



* `filterValue` 默认 `raw`（`WHERE app_id = 'adpoa-ke'`，表名归一化后查询）

* 表路由规则冲突 / 零命中、schema 结构错误默认**拒绝启动**；`onSchemaMismatch` 默认 `warn`

* fanout 下未配置 `mergeTieBreaker` 含 `_instance` 时，跨实例分页稳定性依赖主键全局唯一（启动与审计中会有提示）

* 示例实例 `10.0.0.11/12/13/20` 为占位地址，需替换为真实实例并在 `local.json` 填入只读账号密码