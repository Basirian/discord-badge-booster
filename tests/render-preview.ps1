$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PreviewWindow {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
}
'@
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot 'dist\BadgeBooster.exe'
if (-not (Test-Path -LiteralPath $launcherPath)) { throw 'Run build.ps1 first.' }
$outputDirectory = Join-Path $PSScriptRoot 'output'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$outputPath = Join-Path $outputDirectory 'preview.png'

# Opens the app and captures its idle window. Nothing is clicked, so no game placeholder starts.
$app = Start-Process -FilePath $launcherPath -PassThru
$bitmap = $null
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ($app.MainWindowHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200; $app.Refresh() }
    if ($app.MainWindowHandle -eq [IntPtr]::Zero) { throw 'The app window did not open.' }
    Start-Sleep -Seconds 4
    $rect = New-Object PreviewWindow+RECT
    [PreviewWindow]::GetWindowRect($app.MainWindowHandle, [ref]$rect) | Out-Null
    $bitmap = New-Object Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $dc = $graphics.GetHdc()
    # PW_RENDERFULLCONTENT (2) includes the WebView2 surface.
    [PreviewWindow]::PrintWindow($app.MainWindowHandle, $dc, 2) | Out-Null
    $graphics.ReleaseHdc($dc)
    $graphics.Dispose()
    $bitmap.Save($outputPath, [Drawing.Imaging.ImageFormat]::Png)
    Write-Output "Rendered $outputPath. No game process started."
}
finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if (-not $app.HasExited) { $app.CloseMainWindow() | Out-Null; if (-not $app.WaitForExit(5000)) { $app.Kill() } }
    $app.Dispose()
}
