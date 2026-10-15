# DBGate 网关 — Docker 部署方案

本项目为无状态的只读查询服务，非常适合容器化。方案要点：**镜像零敏感信息、真实配置运行时挂载、非 root 运行、内置健康检查**。

## 0. 产物清单

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建（deps → runtime），node:22-alpine，非 root |
| `.dockerignore` | 排除 node_modules/logs/真实配置等，防止敏感信息进入构建上下文 |
| `docker-compose.yml` | 一键部署：端口、配置挂载、日志卷、健康检查、自动重启 |
| `DEPLOY.md` | 本部署说明 |

## 1. 镜像内包含 / 不包含什么

| 内容 | 是否进镜像 | 说明 |
| --- | --- | --- |
| 源码 / 依赖 / 文档（README/API/TABLES） | ✅ | `/docs` 端点实时读取文档，必须随镜像分发 |
| `config/default.json` | ✅ | 通用默认配置，无敏感信息 |
| `config/biz.rules.jsonc` | ❌ | 含内网实例 host/库名/表名，运行时挂载 |
| `config/local.json` | ❌ | 含真实密码/token，运行时挂载（红线） |

> 密码/token 只在容器运行期经只读挂载进入，不写入任何镜像层；`docker history` 也看不到。

## 2. 快速开始（Docker Compose，推荐）

```bash
# 在项目根（D:\gate\dbgate）执行
docker compose up -d --build

# 查看状态与健康
docker compose ps

# 查看日志
docker compose logs -f dbgate

# 验证
curl http://127.0.0.1:8787/health
```

## 3. 手动构建与运行（不依赖 Compose）

```bash
docker build -t dbgate:latest .

# HTTP 服务（端口默认只绑本机）
docker run -d --name dbgate --init -p 127.0.0.1:8787:8787 \
  -v "$PWD/config/biz.rules.jsonc:/app/config/biz.rules.jsonc:ro" \
  -v "$PWD/config/local.json:/app/config/local.json:ro" \
  -v dbgate-logs:/app/logs \
  -e TZ=Asia/Shanghai \
  dbgate:latest

# 验证
curl http://127.0.0.1:8787/health
```

## 4. 配置挂载说明

- 镜像内置 `config/default.json`；`biz.rules.jsonc` 与 `local.json` 以**只读 bind mount** 覆盖（合并顺序不变：default < biz.rules < local）。
- 修改宿主 `config/` 下的文件后，**必须重启容器**才生效：`docker compose restart dbgate`。
- 上线前请先执行预检：`npm run table-scope`（或按 README §9）。

## 5. MCP Server 在容器中的使用

MCP 走 **stdio 协议**（标准输入/输出），与 HTTP 不同，没有"端口"。容器内使用有两种方式：

**方式 A：交互式一次性调用（调试/CLI 工具）**

```bash
# 以交互模式启动容器内的 MCP 进程，输入 JSON-RPC 行即可通信
docker run --rm -i --name dbgate-mcp \
  -v "$PWD/config/biz.rules.jsonc:/app/config/biz.rules.jsonc:ro" \
  -v "$PWD/config/local.json:/app/config/local.json:ro" \
  dbgate:latest node src/bootstrap.js mcp
```

**方式 B：MCP 客户端通过 stdio spawn 容器（生产 Agent 接入）**

在 MCP 客户端配置中把命令指向 docker：

```json
{
  "mcpServers": {
    "dbgate": {
      "command": "docker",
      "args": ["run", "--rm", "-i",
               "-v", "/abs/path/config/biz.rules.jsonc:/app/config/biz.rules.jsonc:ro",
               "-v", "/abs/path/config/local.json:/app/config/local.json:ro",
               "dbgate:latest", "node", "src/bootstrap.js", "mcp"]
    }
  }
}
```

> Windows 路径需写绝对路径（如 `D:\gate\dbgate\config\local.json` → 反斜杠或正斜杠均可，Docker 会处理）。

## 6. 网络与 MySQL 实例连通性

- 容器默认走 **bridge 网络**，出站访问内网 MySQL（如 `sit-db05-uganda.db.mib`）依赖域名解析与路由可达。
- 若内网域名在容器内无法解析：
  - **Linux 宿主机**：可改用 `network_mode: host`（容器直用宿主机网络栈，见 docker-compose.yml 注释）；或在 compose 中加 `extra_hosts: ["sit-db05-uganda.db.mib:10.x.x.x"]`。
  - **Windows/macOS Docker Desktop**：不支持 host 网络模式，保持 bridge；确认宿主机可解析域名后，Docker Desktop 通常复用宿主 DNS。若仍不通，将 `config/biz.rules.jsonc` 中 host 改为宿主机可访问的 IP 后重启容器。
- 请在部署后执行 `curl http://127.0.0.1:8787/health` 检查各实例连通状态（`instances[].connected`）。

## 7. 端口绑定与安全清单

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 端口 | `127.0.0.1:8787` | 与直接运行一致，仅本机可达；对外暴露需改 `8787:8787` |
| 运行用户 | `dbgate`（非 root，UID 1001） | 降低提权风险 |
| 配置 | 只读挂载 | 容器内无法修改真实配置 |
| 健康检查 | `GET /health`（免鉴权） | 每 30s 探测，Compose 依赖其判健康 |
| 时区 | `TZ=Asia/Shanghai` | 审计时间戳对齐本地时间 |

## 8. 运维

| 操作 | 命令 |
| --- | --- |
| 查看实时日志 | `docker compose logs -f dbgate` |
| 查看审计（卷内） | `docker volume inspect dbgate_logs` 后读取 `logs/audit-*.jsonl` |
| 重启（配置变更后） | `docker compose restart dbgate` |
| 升级（代码变更后） | `docker compose up -d --build` |
| 停止并清理 | `docker compose down`（保留数据卷；`-v` 连卷一并删除） |

## 9. 验证清单（部署完成后）

1. `docker compose ps` → `dbgate` 状态 `healthy`（或 `running` + 无重启循环）
2. `curl http://127.0.0.1:8787/health` → `ok:true` 且 `instances[].connected` 全 true
3. `curl http://127.0.0.1:8787/docs` → 文档索引正常
4. 用一个 token 调一次真实查询（records），确认跨实例归并与隔离正常
5. `docker history dbgate:latest` → 确认镜像层无 `config/local.json` 内容
