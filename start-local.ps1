# DBGate 本地快速启动脚本
# 用法：
#   双击 start-local.bat
#   或 PowerShell 中执行: .\start-local.ps1
# 功能：检查 Node/依赖/端口 → 后台启动 → 等待端口就绪 → /health 健康检查
param(
  [string]$LogDir = "logs"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# 1. Node 检查
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[DBGate] 未找到 Node.js，请先安装 Node 22+（https://nodejs.org）" -ForegroundColor Red
  exit 1
}

# 2. 依赖检查（首次运行自动安装生产依赖）
if (-not (Test-Path "node_modules")) {
  Write-Host "[DBGate] 首次运行，安装依赖中（npm ci --omit=dev）..."
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { Write-Host "[DBGate] 依赖安装失败" -ForegroundColor Red; exit 1 }
}

# 3. 端口检查：已在运行则直接提示退出（幂等）
$existing = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "[DBGate] 服务已在运行：PID $($existing.OwningProcess)，http://127.0.0.1:8787" -ForegroundColor Green
  exit 0
}

# 4. 日志目录
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

# 5. 后台启动（日志重定向，隐藏窗口）
$p = Start-Process node -ArgumentList 'src/bootstrap.js', 'http' `
  -WorkingDirectory $root `
  -RedirectStandardOutput "$LogDir\boot.out.log" `
  -RedirectStandardError "$LogDir\boot.err.log" `
  -WindowStyle Hidden -PassThru
Write-Host "[DBGate] 启动中（PID $($p.Id)），等待端口就绪..."

# 6. 等待端口就绪（最多 20 秒）
$c = $null
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  $c = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
  if ($c) { break }
  if ($p.HasExited) {
    Write-Host "[DBGate] 启动失败（进程已退出），请查看 logs\boot.err.log" -ForegroundColor Red
    exit 1
  }
}
if (-not $c) {
  Write-Host "[DBGate] 20 秒内端口未就绪，请查看 logs\boot.err.log" -ForegroundColor Red
  exit 1
}

# 7. 健康检查
try {
  $h = Invoke-RestMethod 'http://127.0.0.1:8787/health' -TimeoutSec 10
  $conn = @($h.instances | Where-Object { $_.connected }).Count
  Write-Host "[DBGate] 启动成功：PID $($c.OwningProcess)，http://127.0.0.1:8787，实例连通 $conn/$($h.instances.Count)" -ForegroundColor Green
} catch {
  Write-Host "[DBGate] 服务已启动但健康检查失败：$($_.Exception.Message)" -ForegroundColor Yellow
}
exit 0
