param(
  [string]$Out = '_shot.png',
  [string[]]$TitleLike = @('PANE', '设置', '图片预览', '固定遮罩'),
  [switch]$NoBring
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('UiWin' -as [type])) {
  Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class UiWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<string> All() {
    var list = new List<string>();
    EnumWindows((h, l) => {
      var sb = new StringBuilder(300);
      GetWindowText(h, sb, 300);
      var cls = new StringBuilder(300);
      GetClassName(h, cls, 300);
      int pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      list.Add(pid + "|" + IsWindowVisible(h) + "|" + h.ToInt64() + "|" + r.Left + "," + r.Top + "," + (r.Right-r.Left) + "x" + (r.Bottom-r.Top) + "|" + cls.ToString() + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
}

$all = [UiWin]::All()
$rows = @()
foreach ($line in $all) {
  $title = ($line -split '\|')[5]
  if (-not $title) { continue }
  foreach ($like in $TitleLike) {
    if ($title -like "*$like*") { $rows += $line; break }
  }
}
"windows=$($rows.Count)"
$rows | ForEach-Object { "  $_" }

if (-not $NoBring) {
  foreach ($line in $rows) {
    $parts = $line -split '\|'
    if ($parts[1] -eq 'True') {
      $h = [IntPtr]::new([int64]$parts[2])
      [UiWin]::ShowWindow($h, 5) | Out-Null
      [UiWin]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
      [UiWin]::SetForegroundWindow($h) | Out-Null
    }
  }
  Start-Sleep -Milliseconds 600
}

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved=$Out"
