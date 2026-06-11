"""VoiceForge lokal sunucu.

Statik dosyalari sunar + Windows SAPI uzerinden TTS endpoint'i saglar.
Calistir: python server.py  (veya start.ps1)
"""
import http.server
import json
import os
import subprocess
import tempfile
import threading

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 8765))

_voices_cache = None
_voices_lock = threading.Lock()

PS_LIST_VOICES = (
    "Add-Type -AssemblyName System.Speech; "
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
    "$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { "
    "$v = $_.VoiceInfo; Write-Output ($v.Name + '|' + $v.Gender + '|' + $v.Culture) }"
)


def _run_powershell(args, timeout=60):
    return subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass"] + args,
        capture_output=True,
        timeout=timeout,
    )


def get_voices():
    global _voices_cache
    with _voices_lock:
        if _voices_cache is not None:
            return _voices_cache
        voices = []
        try:
            r = _run_powershell(["-Command", PS_LIST_VOICES], timeout=30)
            for line in r.stdout.decode("utf-8", errors="replace").splitlines():
                parts = line.strip().split("|")
                if len(parts) == 3:
                    voices.append({"name": parts[0], "gender": parts[1], "culture": parts[2]})
        except Exception as e:
            print("Ses listesi alinamadi:", e)
        _voices_cache = voices
        return voices


def synthesize(text, voice, rate):
    """tts.ps1 ile metni WAV'a sentezler, bayt dizisi dondurur (hata: None)."""
    with tempfile.TemporaryDirectory() as td:
        txt_path = os.path.join(td, "text.txt")
        wav_path = os.path.join(td, "out.wav")
        with open(txt_path, "w", encoding="utf-8-sig") as f:
            f.write(text)
        args = ["-File", os.path.join(ROOT, "tts.ps1"),
                "-TextFile", txt_path, "-OutFile", wav_path, "-Rate", str(rate)]
        if voice:
            args += ["-Voice", voice]
        try:
            r = _run_powershell(args, timeout=60)
        except subprocess.TimeoutExpired:
            print("TTS zaman asimi")
            return None
        if r.returncode != 0 or not os.path.exists(wav_path):
            print("TTS hatasi:", r.stderr.decode("utf-8", errors="replace")[:500])
            return None
        with open(wav_path, "rb") as f:
            return f.read()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # sessiz

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/voices":
            self._send_json(get_voices())
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != "/tts":
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_error(400, "Gecersiz istek")
            return
        text = (data.get("text") or "").strip()[:500]
        if not text:
            self.send_error(400, "Metin bos")
            return
        voice = data.get("voice") or ""
        try:
            rate = max(-10, min(10, int(data.get("rate") or 0)))
        except (TypeError, ValueError):
            rate = 0
        wav = synthesize(text, voice, rate)
        if wav is None:
            self.send_error(500, "Sentez basarisiz")
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"VoiceForge calisiyor -> http://localhost:{PORT}")
    print("Kapatmak icin Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
