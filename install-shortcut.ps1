# Masaustune ikonlu VoiceForge kisayolu olusturur. Bir kez calistirmak yeterli.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')

# Basit ikon uret (turuncu zemin, beyaz VF)
$icoPath = Join-Path $root 'voiceforge.ico'
if (-not (Test-Path $icoPath)) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 64, 64
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::FromArgb(224, 116, 58))
    $font = New-Object System.Drawing.Font('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
    $rect = New-Object System.Drawing.RectangleF 0, 2, 64, 60
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = 'Center'
    $sf.LineAlignment = 'Center'
    $g.DrawString('VF', $font, [System.Drawing.Brushes]::White, $rect, $sf)
    $g.Dispose()
    $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    $fs = [System.IO.File]::Create($icoPath)
    $icon.Save($fs)
    $fs.Close()
    $bmp.Dispose()
}

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $desktop 'VoiceForge.lnk'))
$lnk.TargetPath = 'powershell.exe'
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\start.ps1`""
$lnk.WorkingDirectory = $root
$lnk.IconLocation = $icoPath
$lnk.Description = 'VoiceForge - Oyun karakteri ses donusturucu'
$lnk.Save()
Write-Output "Kisayol olusturuldu: $(Join-Path $desktop 'VoiceForge.lnk')"
