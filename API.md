# DBGate API 与工具说明

DBGate 网关提供 **HTTP REST** 与 **MCP Server** 双接入，二者共享同一套查询内核与权限模型，功能一一对应。本文档列出现有接口与工具的功能说明；通用约定见 README.md。

## 通用约定

| 项目 | 说明 |
| ---- | ---- |
| 接入地址 | HTTP：`http://127.0.0.1:8787`；MCP：`npm run mcp`（stdio） |
| 鉴权 | 除 `/health`、`/docs*` 外，HTTP 需请求头 `Authorization: Bearer <token>`；MCP 工具由服务端统一注入 token |
| 权限边界 | appid 是隔离边界与分表键；token 控制可访问 appid（`allowApps`）与可查表（`tables`） |
| 只读约束 | 全部接口均为只读查询，不存在任何写 SQL 入口 |
| 响应信封 | HTTP 统一 `{ ok, data | error, requestId }`；MCP 返回 JSON 文本 |
| 错误码 | `AUTH_MISSING`/`AUTH_INVALID`/`APPID_NOT_ALLOWED`/`APPID_MISMATCH`/`APPID_INVALID`/`TABLE_NOT_FOUND`/`TABLE_NOT_ALLOWED`/`FIELD_NOT_ALLOWED`/`OPERATOR_NOT_ALLOWED`/`PLAN_TOO_BROAD`/`LIMIT_EXCEEDED`/`CARDINALITY_EXCEEDED`/`PARTIAL_FAILURE`/`QUERY_TIMEOUT`/`INSTANCE_UNAVAILABLE`/`DB_ERROR`/`PARAM_INVALID`/`DOC_NOT_FOUND` |

## HTTP 接口（13 个端点）

| # | Method | Path | 功能说明 |
| - | ------ | ---- | -------- |
| 1 | GET | `/health` | 健康检查（免鉴权）：运行时长、版本、表数量、实例数量及各实例连通状态 |
| 2 | GET | `/docs` | 对外文档索引（免鉴权）：返回 readme / tables / api 等文档清单与 URL |
| 3 | GET | `/docs/:name` | 文档原文（免鉴权，`text/markdown`）：`readme`、`tables`、`api`；未知文档名返回 404 `DOC_NOT_FOUND` |
| 4 | GET | `/v1/apps` | 当前 token 可访问的 appid 清单（通配授权在已知 appid 中展开） |
| 5 | GET | `/v1/biz-types` | 业务类型清单：遍历模式（fanout/route）、成员实例数、延迟配置 |
| 6 | GET | `/v1/apps/:appid/tables` | 可查表清单：按 token.tables 授权展开，标注 `authorizedTables`；支持 `?bizType=` 过滤 |
| 7 | GET | `/v1/apps/:appid/tables/:table/schema` | 表结构元数据：字段名/类型/主键、业务类型、目标实例数、隔离列、注意事项（发起查询前先调用） |
| 8 | GET | `/v1/apps/:appid/tables/:table/plan` | 执行计划预览：目标实例、成员、匹配到的路由规则、遍历模式 |
| 9 | POST | `/v1/apps/:appid/tables/:table/records` | 条件查询：`filters`/`sort`/`limit`/`offset`/`fields`；跨实例自动遍历并归并 |
| 10 | POST | `/v1/apps/:appid/tables/:table/count` | 计数：`filters` 可选，跨实例归并后相加 |
| 11 | POST | `/v1/apps/:appid/tables/:table/aggregate` | 分组聚合：`groupBy` + `metrics`（sum/avg/min/max/count/count_distinct），可 `sort`/`limit`/`offset` |
| 12 | GET | `/v1/audit/recent?n=50` | 最近审计记录（操作、appid、表、耗时、结果；不含任何敏感字段） |
| 13 | GET | `/v1/apps/:appid/tables/:table/plan`（别名） | —（plan 预览也可用于估算 fanout 范围） |

> 请求体示例（records）：

```json
{
  "appid": "choiceSasa",
  "table": "message_template",
  "fields": ["template_id", "template_code", "app_id"],
  "filters": [{ "field": "template_type", "op": "eq", "value": "SMS" }],
  "sort": [{ "field": "template_id", "desc": false }],
  "limit": 50
}
```

> filter op 全集：`eq / ne / gt / gte / lt / lte / in / not_in / like / between / is_null / not_null`。字段名务必先用 `/schema` 确认。

## MCP 工具（7 个）

| # | 工具名 | 功能说明 | 入参 |
| - | ------ | -------- | ---- |
| 1 | `list_apps` | 列出当前 token 可访问的 appid（appid 是权限边界与分表键） | 无 |
| 2 | `list_biz_types` | 列出业务类型、遍历模式（fanout/route）、成员实例数 | 无 |
| 3 | `list_tables` | 列出指定 appid 可访问的逻辑表、所属业务、注释 | `appid`（必填）、`bizType?` |
| 4 | `describe_table` | 查看表结构：字段定义 + 权限 + 业务类型 + 预计目标数 + 注意事项；**发起查询前先用本工具确认字段名与遍历范围** | `appid`（必填）、`table`（必填） |
| 5 | `count_records` | 按 appid + 表 + 条件计数（跨实例归并后相加） | `appid`、`table`、`bizType?`、`filters?` |
| 6 | `query_records` | 主查询：appid 必填；本表可能跨多个实例，服务端自动遍历并归并；结果 `partial:true` 表示部分实例失败、数据不完整；不写 SQL | `appid`、`table`、`bizType?`、`fields?`、`filters?`、`sort?`、`limit?`（默认 200 / 上限 500）、`offset?`（遍历模式上限 1000） |
| 7 | `aggregate_records` | 分组聚合：`groupBy` + `metrics`（sum/avg/min/max/count/count_distinct）；avg 由服务端按 Σsum/Σcount 重算；count_distinct 超基数上限返回 `CARDINALITY_EXCEEDED` | `appid`、`table`、`bizType?`、`filters?`、`groupBy`（至少一个）、`metrics`、`sort?`、`limit?`、`offset?` |

> MCP 建议调用顺序：`list_apps` → `list_tables` → `describe_table` → `query_records` / `count_records` / `aggregate_records`。

## 关键语义速查

- **实例多库**：`instances[*].database` 支持逗号分隔（`"db1,db2"`）——查询时对该实例的每个库都遍历并归并；目标/健康探测/审计均按 `实例::库` 粒度展示（`targets[].database`）。
- **表归属多业务**：`tables[].bizType` 支持 `"user,loan"` —— 同名物理表在两侧业务都遍历并归并；缺省 = 全部业务。
- **可查表授权**：token 配置 `tables: ["*"]` 表示全部可查；精确表名表示仅该表；列表与查询均按此校验（`TABLE_NOT_ALLOWED` → 403）。
- **appid 授权**：token 配置 `allowApps: ["*"]` 全通配、`app_*` 前缀通配、精确匹配；未授权 appid → 403。
- **隔离列注入**：分表恒注入 `app_id = ?`；非分表在表真实存在 `app_id` 列时也注入；列不存在则不注入。隔离条件不允许用户改写（冲突 → `APPID_MISMATCH`）。
- **遍历与归并**：fanout 并发遍历成员实例后按主键归并去重；部分实例失败按失败策略返回 `PARTIAL_FAILURE`（strict）或 partial 数据（bestEffort）。
- **tie-breaker**：排序自动追加真实主键（无主键不追加），保证跨实例分页稳定。
- **密码红线**：实例密码 / token 仅存于 `config/local.json`（gitignore），不落日志、不进审计、不随文档暴露。
