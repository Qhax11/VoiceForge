# VoiceForge baslatici:
# 1) Sunucuyu gizli baslatir (zaten calisiyorsa dokunmaz)
# 2) Port hazir olana kadar bekler
# 3) Chrome/Edge'i uygulama penceresi modunda acar (--app)
# 4) Pencere kapaninca kendi actigi sunucuyu durdurur
$ErrorActionPreference = 'Stop'
$port = 8765
$root = $PSScriptRoot
$url = "http://localhost:$port"

function Test-Port([int]$p) {
    $c = New-Object System.Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}

# --- Sunucu ---
$serverProc = $null
if (-not (Test-Port $port)) {
    $serverProc = Start-Process python -ArgumentList "`"$root\server.py`"" -WindowStyle Hidden -PassThru
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        if (Test-Port $port) { $ready = $true; break }
        if ($serverProc.HasExited) { break }
    }
    if (-not $ready) {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show(
            "Sunucu baslatilamadi. Terminalde sunu calistirip hatayi gorun:`npython `"$root\server.py`"",
            'VoiceForge', 'OK', 'Error') | Out-Null
        exit 1
    }
}

# --- Tarayici (uygulama penceresi) ---
$browser = $null
foreach ($p in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)) { if (Test-Path $p) { $browser = $p; break } }

if ($browser) {
    # Ayri profil dizini: pencere kendi surecinde kalir (-Wait calisir),
    # mikrofon izni vb. kalici olur
    $profileDir = Join-Path $env:LOCALAPPDATA 'VoiceForge\BrowserProfile'
    New-Item -ItemType Directory -Force $profileDir | Out-Null
    Start-Process $browser -ArgumentList "--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check' -Wait
    # Pencere kapandi: bizim actigimiz sunucuyu durdur
    if ($serverProc -and -not $serverProc.HasExited) {
        Stop-Process -Id $serverProc.Id -Force
    }
} else {
    # Chrome/Edge yok: varsayilan tarayicida ac, sunucuyu acik birak
    Start-Process $url
}
