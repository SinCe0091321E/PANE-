$ErrorActionPreference = 'SilentlyContinue'

# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less files as ANSI,
# and non-ASCII text would break parsing (which makes double-click do nothing).
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'runtime\FloatingDock.exe'
$flag = Join-Path $root 'runtime\no-sandbox.flag'
$logFile = Join-Path $root 'launch.log'
$env:ELECTRON_RUN_AS_NODE = $null

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8
}

'=== PANE launch ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===' | Set-Content -LiteralPath $logFile -Encoding UTF8

if (-not (Test-Path -LiteralPath $exe)) {
  Write-Log "missing exe: $exe"
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show("runtime\FloatingDock.exe was not found. Please unzip the whole folder.", 'PANE')
  exit 1
}

$existing = Get-Process -Name FloatingDock -ErrorAction SilentlyContinue
if ($existing) {
  # 已有实例（可能正缩在托盘里）：启动一次让它自己 show 出来
  if (Test-Path -LiteralPath $flag) {
    Start-Process -FilePath $exe -ArgumentList '--no-sandbox' | Out-Null
  } else {
    Start-Process -FilePath $exe | Out-Null
  }
  for ($i = 0; $i -lt 8; $i++) {
    Start-Sleep -Milliseconds 500
    $shown = Get-Process -Name FloatingDock -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($shown) {
      Write-Log 'existing instance restored'
      exit 0
    }
  }
  Write-Log 'existing processes but still no window; continue launching'
}

$plans = @()
if (Test-Path -LiteralPath $flag) {
  $plans += ,@('--no-sandbox')
} else {
  $plans += ,@()
  $plans += ,@('--no-sandbox')
}

$started = $null
foreach ($plan in $plans) {
  $label = if ($plan.Count -gt 0) { $plan -join ' ' } else { '(default sandbox)' }
  Write-Log "attempt: $label"

  if ($plan.Count -gt 0) {
    $process = Start-Process -FilePath $exe -ArgumentList $plan -PassThru
  } else {
    $process = Start-Process -FilePath $exe -PassThru
  }

  $ok = $false
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 800
    $process.Refresh()
    if ($process.HasExited) { break }
    if ($process.MainWindowHandle -ne 0) { $ok = $true; break }
  }

  if ($ok) {
    Write-Log 'window appeared'
    $started = $process
    break
  }

  if ($process.HasExited) {
    Write-Log "process exited, code: $($process.ExitCode)"
  } else {
    Write-Log 'process alive but no window; killing and retrying'
    Stop-Process -Id $process.Id -Force
  }

  if ($plan -notcontains '--no-sandbox') {
    Set-Content -LiteralPath $flag -Value '1' -Encoding ASCII
    Write-Log 'remember --no-sandbox for next launches'
  }
}

if (-not $started) {
  Add-Type -AssemblyName System.Windows.Forms
  $tail = (Get-Content -LiteralPath $logFile -Encoding UTF8 | Select-Object -Last 8) -join "`r`n"
  [System.Windows.Forms.MessageBox]::Show("PANE failed to start.`r`n`r`n$tail`r`n`r`nFull log: $logFile", 'PANE') | Out-Null
}
