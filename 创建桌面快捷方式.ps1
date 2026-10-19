# 在桌面创建「PANE」快捷方式
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $root '启动浮窗.vbs'
$icon = Join-Path $root 'runtime\resources\app-files\assets\app.ico'
if (-not (Test-Path $icon)) { $icon = Join-Path $root 'runtime\FloatingDock.exe' }

$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'PANE.lnk'
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = $icon + ',0'
$lnk.Description = 'PANE · 把网站挂在桌面上的极简悬浮窗'
$lnk.Save()
Write-Host "已创建快捷方式：$lnkPath"
