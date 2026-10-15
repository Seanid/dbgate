#!/usr/bin/env bash
# D6 只读账号验证脚本（§8.2）。
#
# 用法：
#   ./scripts/verify-readonly.sh --sql              # 打印每个实例的建只读账号 SQL（含随机密码）
#   ./scripts/verify-readonly.sh --verify HOST DB   # 用环境变量里的只读账号验证单个实例
#   ./scripts/verify-readonly.sh --verify-all       # 用 config 中全部实例逐个验证
#
# 环境变量（--verify / --verify-all 需要）：
#   DBGATE_RO_USER   只读账号名，默认 agent_ro
#   DBGATE_RO_PASS   只读账号密码（必填）
#   MYSQL_BIN        mysql 客户端路径，默认 mysql
#
# 验证项（对应 §8.2 的 MUST NOT 与 ERROR 1142）：
#   1) SELECT 1 可用
#   2) CREATE TABLE 被拒 → ERROR 1142
#   3) INSERT 被拒 → ERROR 1142
#   4) SHOW GRANTS 不含 PROCESS / FILE / SUPER
#   5) 对 information_schema 有 SELECT 权限（元数据服务需要）
set -u

MYSQL="${MYSQL_BIN:-mysql}"
RO_USER="${DBGATE_RO_USER:-agent_ro}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

print_sql() {
  local pass
  pass="$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
  echo "# 在每个实例上分别执行（把 <host> 换成实例地址，<password> 换成上面生成的密码）："
  echo "CREATE USER '${RO_USER}'@'%' IDENTIFIED BY '${pass}';"
  echo "GRANT SELECT, SHOW VIEW ON \`app_prod\`.* TO '${RO_USER}'@'%';"
  echo "GRANT SELECT ON \`information_schema\`.* TO '${RO_USER}'@'%';"
  echo "FLUSH PRIVILEGES;"
  echo "# 每个实例的 database 可能不同（见 config/biz.rules.jsonc instances[].database），按需替换 app_prod。"
  echo "# 输出中的随机密码即本账号密码，妥善保存；MUST NOT 授予 PROCESS / FILE / SUPER。"
}

verify_one() {
  local host="$1" db="$2"
  [ -z "${DBGATE_RO_PASS:-}" ] && { echo "缺少 DBGATE_RO_PASS"; exit 2; }

  echo "==> 验证 ${host}/${db}（账号 ${RO_USER}）"
  local ok=1

  if "${MYSQL}" -h"$host" -u"${RO_USER}" -p"${DBGATE_RO_PASS}" "$db" -e "SELECT 1;" >/dev/null 2>&1; then
    echo "  [PASS] SELECT 可用"
  else
    echo "  [FAIL] SELECT 不可用（检查网络/账号/库名）"; ok=0
  fi

  local out
  out="$("${MYSQL}" -h"$host" -u"${RO_USER}" -p"${DBGATE_RO_PASS}" "$db" -e "CREATE TABLE dbgate_ro_check (i int);" 2>&1)"
  if echo "$out" | grep -q "1142"; then
    echo "  [PASS] CREATE TABLE 被拒（ERROR 1142）"
  else
    echo "  [FAIL] CREATE TABLE 未被拒：$out"; ok=0
  fi

  out="$("${MYSQL}" -h"$host" -u"${RO_USER}" -p"${DBGATE_RO_PASS}" "$db" -e "INSERT INTO dbgate_ro_check VALUES (1);" 2>&1)"
  if echo "$out" | grep -q "1142"; then
    echo "  [PASS] INSERT 被拒（ERROR 1142）"
  else
    echo "  [FAIL] INSERT 未被拒：$out"; ok=0
  fi

  out="$("${MYSQL}" -h"$host" -u"${RO_USER}" -p"${DBGATE_RO_PASS}" "$db" -e "SHOW GRANTS FOR '${RO_USER}'@'%';" 2>&1)"
  if echo "$out" | grep -Eq "PROCESS|FILE|SUPER"; then
    echo "  [FAIL] 授予了危险权限：$out"; ok=0
  else
    echo "  [PASS] 无 PROCESS / FILE / SUPER"
  fi

  if "${MYSQL}" -h"$host" -u"${RO_USER}" -p"${DBGATE_RO_PASS}" information_schema -e "SELECT 1;" >/dev/null 2>&1; then
    echo "  [PASS] information_schema 可读（元数据服务需要）"
  else
    echo "  [WARN] information_schema 不可读——元数据服务将回退/告警"
  fi

  [ "$ok" = 1 ] && echo "  => ${host} 全部通过" || echo "  => ${host} 存在失败项"
}

verify_all() {
  # 从已合并配置导出 "host|database" 列表（实例不可达不影响本脚本；这里只取配置声明）
  node -e '
    import("./src/config/loader.js").then(({ loadConfig }) => {
      const cfg = loadConfig();
      for (const [name, inst] of Object.entries(cfg.instances)) {
        console.log(`${name}\t${inst.host}\t${inst.database}`);
      }
    });
  ' 2>/dev/null | while IFS=$'\t' read -r name host db; do
    echo "# 实例 ${name} @ ${host}"
    verify_one "$host" "$db"
  done
}

case "${1:-}" in
  --sql) print_sql ;;
  --verify) [ $# -ge 3 ] && verify_one "$2" "$3" || { echo "用法: $0 --verify HOST DB"; exit 2; } ;;
  --verify-all) verify_all ;;
  *) echo "用法: $0 {--sql|--verify HOST DB|--verify-all}"; exit 2 ;;
esac
