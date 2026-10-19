param(
  [Parameter(Mandatory = $true)][int]$AppPid,
  [Parameter(Mandatory = $true)][string]$CmdFile,
  [Parameter(Mandatory = $true)][string]$IconPath,
  [string]$Tooltip = 'PANE'
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Send-TrayCommand([string]$command) {
  try {
    $dir = Split-Path -Parent $CmdFile
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    Set-Content -LiteralPath $CmdFile -Value $command -Encoding ASCII -NoNewline
  } catch { }
}

$icon = New-Object System.Drawing.Icon($IconPath)
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = $Tooltip
$ni.Visible = $true

$ni.add_MouseClick({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Send-TrayCommand 'open'
  } elseif ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    Send-TrayCommand 'panel'
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $proc = Get-Process -Id $AppPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    $timer.Stop()
    $ni.Visible = $false
    $ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
