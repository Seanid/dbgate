# syntax=docker/dockerfile:1
# DBGate 网关 — 多阶段构建
# 设计要点：
#  - 纯 ESM JS、无构建步骤，仅需安装生产依赖
#  - 镜像不携带任何真实配置（config/biz.rules.jsonc、config/local.json 由运行时挂载，含密码/token）
#  - /docs 端点读取项目根 README.md / API.md / TABLES.md，故文档随镜像分发
#  - 非 root 运行 + 健康检查

# —— 阶段 1：依赖 ——
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# —— 阶段 2：运行时 ——
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 非 root 用户
RUN addgroup -g 1001 -S dbgate && adduser -u 1001 -S dbgate -G dbgate

# 生产依赖
COPY --from=deps --chown=dbgate:dbgate /app/node_modules ./node_modules

# 源码
COPY --chown=dbgate:dbgate src ./src
COPY --chown=dbgate:dbgate scripts ./scripts
COPY --chown=dbgate:dbgate package.json package-lock.json ./

# 对外文档（/docs 端点实时读取，必须存在）
COPY --chown=dbgate:dbgate README.md API.md TABLES.md ./

# 基础默认配置（无敏感信息）；真实 biz.rules.jsonc / local.json 由 volume 挂载覆盖
COPY --chown=dbgate:dbgate config/default.json ./config/default.json

# 审计日志目录（/v1/audit/recent 依赖；建议挂 volume 持久化）
RUN mkdir -p logs && chown -R dbgate:dbgate logs

USER dbgate
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/health || exit 1

CMD ["node", "src/bootstrap.js", "http"]
