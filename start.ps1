# VoiceForge'u baslatir: lokal sunucu + tarayici
$ErrorActionPreference = 'Stop'
Start-Process "http://localhost:8765"
python "$PSScriptRoot\server.py"
