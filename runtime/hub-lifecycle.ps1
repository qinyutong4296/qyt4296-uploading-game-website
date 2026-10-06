#Requires -Version 5.1
param(
  [ValidateSet("start", "stop")]
  [string]$Action = "start",
  [int]$Port = 8080,
  [switch]$SkipBuild,
  [switch]$Quiet
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $Root "package.json"))) {
  $Root = $PSScriptRoot
}
$RuntimeDir = Join-Path $Root "runtime"
$PidFile = Join-Path $RuntimeDir "hub.pid"
$LauncherPidFile = Join-Path $RuntimeDir "launcher.pid"
$LogFile = Join-Path $RuntimeDir "start-last.log"
$StopLogFile = Join-Path $RuntimeDir "stop-last.log"
$Title = "GameHub"
$script:HubChildPid = 0
# Auto/hidden stop: never write to console (avoids visible flashes)
if ($env:HUB_AUTO -eq "1") { $Quiet = $true }
$script:QuietMode = [bool]$Quiet

function Ensure-RuntimeDir {
  if (-not (Test-Path $RuntimeDir)) {
    New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
  }
}

function Log([string]$msg) {
  Ensure-RuntimeDir
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
  $target = if ($Action -eq "stop") { $StopLogFile } else { $LogFile }
  Add-Content -LiteralPath $target -Value $line -Encoding UTF8
  if (-not $script:QuietMode) {
    Write-Host $line
  }
}

function Get-PortPids([int]$ListenPort) {
  $list = New-Object System.Collections.Generic.List[int]
  try {
    $conns = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess) { [void]$list.Add([int]$c.OwningProcess) }
    }
  } catch {
    $lines = netstat -ano | Select-String (":{0}\s+.*LISTENING" -f $ListenPort)
    foreach ($line in $lines) {
      $parts = ($line.ToString() -split "\s+") | Where-Object { $_ -ne "" }
      if ($parts.Count -ge 5) {
        $pidVal = 0
        if ([int]::TryParse($parts[-1], [ref]$pidVal) -and $pidVal -gt 0) {
          [void]$list.Add($pidVal)
        }
      }
    }
  }
  return ($list | Select-Object -Unique)
}

function Stop-Tree([int]$ProcessId) {
  if ($ProcessId -le 0) { return }
  if ($ProcessId -eq $PID) { return }
  try { & taskkill.exe /F /T /PID $ProcessId 2>$null | Out-Null } catch {}
  try { Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}

# 命令行必须落在本仓库路径下，避免误杀桌面其它游戏 / 其它终端的 node
function Test-BelongsToThisHub([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  $normCmd = $CommandLine.Replace('/', '\')
  $normRoot = $Root.Replace('/', '\')
  return ($normCmd -like ("*" + $normRoot + "*"))
}

function Test-PidBelongsToThisHub([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $row = Get-CimInstance Win32_Process -Filter ("ProcessId=$ProcessId") -ErrorAction SilentlyContinue
    if (-not $row) { return $false }
    return (Test-BelongsToThisHub ([string]$row.CommandLine))
  } catch { return $false }
}

function Invoke-HubForceLogout([int]$ListenPort) {
  try {
    $uri = "http://127.0.0.1:{0}/api/hub-force-logout" -f $ListenPort
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Method POST -Uri $uri | Out-Null
    Log "forced logout + ended game sessions"
  } catch {
    # 服务已停则忽略
  }
}

function Stop-HubProcesses {
  param(
    # 启动终端自己清理时不要杀本窗口/启动器，否则会 ErrorLevel≠0 并卡在 pause
    [switch]$KeepConsole
  )
  Ensure-RuntimeDir
  # 先通知服务端退出用户、结束游戏，再杀进程
  Invoke-HubForceLogout -ListenPort $Port

  $targets = New-Object System.Collections.Generic.List[int]
  $launcherTargets = New-Object System.Collections.Generic.List[int]

  # 只停服务端（hub.pid）；不要杀启动器进程，让它 Wait-Process 结束后 exit 0 并自动关窗
  if (Test-Path $PidFile) {
    try {
      $saved = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
      if ($saved -gt 0 -and $saved -ne $PID) { [void]$targets.Add($saved) }
    } catch {}
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }

  # 先读出本站启动器 PID，再删文件；关窗只杀这些，不按标题扫全机
  if (Test-Path $LauncherPidFile) {
    try {
      Get-Content $LauncherPidFile -ErrorAction SilentlyContinue | ForEach-Object {
        $t = ("$_").Trim()
        $lid = 0
        if ([int]::TryParse($t, [ref]$lid) -and $lid -gt 0 -and $lid -ne $PID) {
          [void]$launcherTargets.Add($lid)
        }
      }
    } catch {}
    Remove-Item $LauncherPidFile -Force -ErrorAction SilentlyContinue
  }

  if ($script:HubChildPid -gt 0 -and $script:HubChildPid -ne $PID) {
    [void]$targets.Add([int]$script:HubChildPid)
  }

  # 端口占用：仅杀「本仓库路径」相关监听进程，绝不误伤其它游戏端口/终端
  foreach ($p in (Get-PortPids -ListenPort $Port)) {
    if ($p -eq $PID) { continue }
    if (Test-PidBelongsToThisHub $p) { [void]$targets.Add([int]$p) }
    else { Log ("skip foreign port PID $p (not this hub)") }
  }

  try {
    $normRoot = $Root.Replace('/', '\')
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.Name -match "^(node|npm)\.exe$") -and
        (Test-BelongsToThisHub ([string]$_.CommandLine)) -and (
          $_.CommandLine -like "*server\\src\\index.ts*" -or
          $_.CommandLine -like "*server/src/index.ts*" -or
          $_.CommandLine -like "*tsx*src/index.ts*" -or
          $_.CommandLine -like "*tsx*src\\index.ts*" -or
          $_.CommandLine -like "*npm*run*start*" -or
          $_.CommandLine -like ("*" + $normRoot + "*server*")
        )
      } |
      ForEach-Object { [void]$targets.Add([int]$_.ProcessId) }
  } catch {}

  foreach ($pidVal in ($targets | Select-Object -Unique)) {
    if ($pidVal -and $pidVal -ne $PID) {
      Stop-Tree -ProcessId $pidVal
    }
  }

  if (-not $KeepConsole) {
    # 外部关站：只关本站记录的启动器窗口，不扫 GameHub* 标题（避免误关其它终端）
    Start-Sleep -Milliseconds 2000
    foreach ($lid in ($launcherTargets | Select-Object -Unique)) {
      if (-not $lid -or $lid -eq $PID) { continue }
      try {
        $lp = Get-Process -Id $lid -ErrorAction SilentlyContinue
        if (-not $lp) { continue }
        try { $lp.CloseMainWindow() | Out-Null } catch {}
        Start-Sleep -Milliseconds 200
        Stop-Tree -ProcessId $lid
      } catch {}
    }
  }

  Start-Sleep -Milliseconds 300
  foreach ($p in (Get-PortPids -ListenPort $Port)) {
    if ($p -eq $PID) { continue }
    if (Test-PidBelongsToThisHub $p) { Stop-Tree -ProcessId $p }
  }
}

function Register-CloseHandler {
  $code = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class HubConsoleGuard {
  public delegate bool HandlerRoutine(int dwCtrlType);
  private static HandlerRoutine _handler;
  private static int _childPid;
  private static int _port;

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetConsoleCtrlHandler(HandlerRoutine Handler, bool Add);

  public static void Arm(int childPid, int port) {
    _childPid = childPid;
    _port = port;
    _handler = new HandlerRoutine(OnControl);
    SetConsoleCtrlHandler(_handler, true);
  }

  private static bool OnControl(int dwCtrlType) {
    try {
      var req = System.Net.WebRequest.Create("http://127.0.0.1:" + _port + "/api/hub-force-logout");
      req.Method = "POST";
      req.Timeout = 1500;
      using (var resp = req.GetResponse()) { }
    } catch {}
    try {
      // 只杀本站子进程树，绝不按端口扫全机（避免误关其它游戏终端）
      if (_childPid > 0) {
        Process.Start(new ProcessStartInfo {
          FileName = "taskkill.exe",
          Arguments = "/F /T /PID " + _childPid,
          CreateNoWindow = true,
          UseShellExecute = false
        }).WaitForExit(3000);
      }
    } catch {}
    return false;
  }
}
"@
  try {
    if (-not ("HubConsoleGuard" -as [type])) {
      Add-Type -TypeDefinition $code -Language CSharp
    }
  } catch {}
}

function Test-HubHealth {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ("http://127.0.0.1:{0}/api/health" -f $Port)
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch { return $false }
}

function Start-Hub {
  Set-Location $Root
  try { $Host.UI.RawUI.WindowTitle = $Title } catch {}
  Ensure-RuntimeDir
  Set-Content -LiteralPath $LogFile -Value ("start {0}" -f (Get-Date -Format o)) -Encoding UTF8
  Set-Content -Path $LauncherPidFile -Value $PID -Encoding ASCII

  Log ("root=" + $Root)
  Log ("port=" + $Port)
  Log "stop old website processes..."
  $keep = $PID
  $oldChild = 0
  if (Test-Path $PidFile) {
    try { $oldChild = [int](Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1) } catch {}
  }
  # 启动前清残留：只清本仓库相关占用，不按端口无差别 taskkill
  foreach ($p in (Get-PortPids -ListenPort $Port)) {
    if ($p -eq $keep) { continue }
    if (($oldChild -gt 0 -and $p -eq $oldChild) -or (Test-PidBelongsToThisHub $p)) {
      Stop-Tree -ProcessId $p
    } else {
      Log ("skip foreign listener PID $p on port $Port")
    }
  }
  if ($oldChild -gt 0 -and $oldChild -ne $keep) { Stop-Tree -ProcessId $oldChild }
  Start-Sleep -Milliseconds 400

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Log "FAIL: Node.js not found"
    Write-Host "Install Node.js LTS from https://nodejs.org then retry."
    exit 1
  }
  Log ("node=" + (node -v))

  Log "[1/3] dependencies..."
  if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    & npm install
    if ($LASTEXITCODE -ne 0) { Log "FAIL npm install root"; exit 1 }
  }
  if (-not (Test-Path (Join-Path $Root "server\node_modules"))) {
    & npm install --prefix server
    if ($LASTEXITCODE -ne 0) { Log "FAIL npm install server"; exit 1 }
  }
  if (-not (Test-Path (Join-Path $Root "client\node_modules"))) {
    & npm install --prefix client
    if ($LASTEXITCODE -ne 0) { Log "FAIL npm install client"; exit 1 }
  }

  $distIndex = Join-Path $Root "client\dist\index.html"
  if ($SkipBuild -and (Test-Path -LiteralPath $distIndex)) {
    Log "[2/3] skip build (dist exists)"
  } else {
    Log "[2/3] build client..."
    & npm run build --prefix client
    if ($LASTEXITCODE -ne 0) {
      Log "FAIL client build"
      exit 1
    }
  }

  Log "[3/3] start server..."
  Write-Host ""
  Write-Host "Website starting..."
  Write-Host ("URL: http://localhost:{0}" -f $Port)
  Write-Host "Admin: admin (first run prints a one-time random password, or set ADMIN_PASSWORD)"
  Write-Host "Close the browser tab to stop the website; this window will close automatically."
  Write-Host ""

  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCmd) { $npmCmd = Get-Command npm }
  $outLog = Join-Path $RuntimeDir "hub-out.log"
  $errLog = Join-Path $RuntimeDir "hub-err.log"
  $proc = $null
  try {
    $proc = Start-Process -FilePath $npmCmd.Source -ArgumentList @("run", "start", "--prefix", "server") `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  } catch {
    Log ("Start-Process redirect failed: " + $_.Exception.Message)
    $proc = Start-Process -FilePath $npmCmd.Source -ArgumentList @("run", "start", "--prefix", "server") `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  }

  if (-not $proc -or -not $proc.Id) {
    Log "FAIL: server process not started"
    exit 1
  }

  $script:HubChildPid = [int]$proc.Id
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
  Set-Content -Path $LauncherPidFile -Value $PID -Encoding ASCII
  Log ("server pid=" + $proc.Id)

  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-HubHealth) { $ok = $true; break }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  if (-not $ok) {
    Log "FAIL: health check timeout"
    Write-Host "Server did not become ready. See runtime\hub-err.log / start-last.log"
    Stop-Tree -ProcessId $proc.Id
    exit 1
  }

  Log "OK health"
  $cleanExitMark = Join-Path $RuntimeDir "hub.clean-exit"
  $startedMark = Join-Path $RuntimeDir "hub.started"
  Remove-Item $cleanExitMark -Force -ErrorAction SilentlyContinue
  try { Set-Content -LiteralPath $startedMark -Value "1" -Encoding ASCII } catch {}
  try { Start-Process ("http://127.0.0.1:{0}/" -f $Port) } catch { Log ("open browser fail: " + $_.Exception.Message) }

  Register-CloseHandler
  try { [HubConsoleGuard]::Arm([int]$proc.Id, [int]$Port) } catch {}

  # 等到服务进程真正退出；健康检查只告警，不因短暂无响应杀进程。
  # 大 zip 解压 / npm 装依赖时事件循环可能卡住，旧逻辑会误判并关掉启动终端。
  $missedHealth = 0
  try {
    while ($true) {
      if ($proc.HasExited) { break }
      try {
        Wait-Process -Id $proc.Id -Timeout 2 -ErrorAction Stop
        break
      } catch {
        # 超时：再探活
      }
      if ($proc.HasExited) { break }
      if (Test-HubHealth) {
        if ($missedHealth -gt 0) {
          Log ("health recovered after $missedHealth misses")
        }
        $missedHealth = 0
      } else {
        $missedHealth++
        # 进程仍在：只记录，不杀站、不关终端（上传大游戏时可卡住数分钟）
        if ($missedHealth -eq 3 -or $missedHealth -eq 15 -or ($missedHealth % 30 -eq 0)) {
          Log ("health miss $missedHealth (server pid still alive, keep waiting — likely busy unpacking/upload)")
        }
      }
    }
  } finally {
    if (-not $script:QuietMode) { Write-Host "" }
    Log "stopping website..."
    try { Stop-HubProcesses -KeepConsole } catch { Log ("stop cleanup: " + $_.Exception.Message) }
    try {
      Set-Content -LiteralPath $cleanExitMark -Value "1" -Encoding ASCII
    } catch {}
    Remove-Item $startedMark -Force -ErrorAction SilentlyContinue
    Log "done"
  }
}

switch ($Action) {
  "stop" {
    if (-not $script:QuietMode) {
      Write-Host "Stopping website, background processes, and launcher terminal..."
    }
    Log "stopping website (quiet=$($script:QuietMode))..."
    Stop-HubProcesses
    Log "done"
    if (-not $script:QuietMode) {
      Write-Host "Done."
    }
    exit 0
  }
  default {
    Start-Hub
    # 正常开站后无论因关标签页/关站脚本停服，都视为成功退出，让启动窗口自动关掉
    exit 0
  }
}