"""VoiceForge lokal sunucu.

Statik dosyalari sunar + iki TTS motoru:
- neural: edge-tts (Microsoft Edge neural sesleri — dogal tonlama, internet ister;
  sadece metin gider, ses gelir; efekt isleme tamamen lokal kalir)
- sapi: Windows System.Speech (tamamen cevrimdisi, robotik — yedek)

Calistir: python server.py  (veya start.ps1)
"""
import http.server
import json
import os
import subprocess
import tempfile
import threading

try:
    import asyncio
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except ImportError:
    EDGE_TTS_AVAILABLE = False

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", 8765))

# Oyun replikleri icin secilmis neural sesler
NEURAL_VOICES = [
    {"name": "en-US-ChristopherNeural", "gender": "Male",   "culture": "en-US", "label": "Christopher (derin)"},
    {"name": "en-US-GuyNeural",         "gender": "Male",   "culture": "en-US", "label": "Guy"},
    {"name": "en-US-EricNeural",        "gender": "Male",   "culture": "en-US", "label": "Eric"},
    {"name": "en-US-RogerNeural",       "gender": "Male",   "culture": "en-US", "label": "Roger"},
    {"name": "en-GB-RyanNeural",        "gender": "Male",   "culture": "en-GB", "label": "Ryan (Ingiliz)"},
    {"name": "en-GB-ThomasNeural",      "gender": "Male",   "culture": "en-GB", "label": "Thomas (Ingiliz)"},
    {"name": "en-US-JennyNeural",       "gender": "Female", "culture": "en-US", "label": "Jenny"},
    {"name": "en-US-AriaNeural",        "gender": "Female", "culture": "en-US", "label": "Aria"},
    {"name": "en-GB-SoniaNeural",       "gender": "Female", "culture": "en-GB", "label": "Sonia (Ingiliz)"},
    {"name": "tr-TR-AhmetNeural",       "gender": "Male",   "culture": "tr-TR", "label": "Ahmet (Turkce)"},
    {"name": "tr-TR-EmelNeural",        "gender": "Female", "culture": "tr-TR", "label": "Emel (Turkce)"},
]

_sapi_cache = None
_sapi_lock = threading.Lock()

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


def get_sapi_voices():
    global _sapi_cache
    with _sapi_lock:
        if _sapi_cache is not None:
            return _sapi_cache
        voices = []
        try:
            r = _run_powershell(["-Command", PS_LIST_VOICES], timeout=30)
            for line in r.stdout.decode("utf-8", errors="replace").splitlines():
                parts = line.strip().split("|")
                if len(parts) == 3:
                    label = parts[0].replace("Microsoft ", "").replace(" Desktop", "")
                    voices.append({"name": parts[0], "gender": parts[1],
                                   "culture": parts[2], "label": label, "engine": "sapi"})
        except Exception as e:
            print("SAPI ses listesi alinamadi:", e)
        _sapi_cache = voices
        return voices


def get_all_voices():
    voices = []
    if EDGE_TTS_AVAILABLE:
        voices += [dict(v, engine="neural") for v in NEURAL_VOICES]
    voices += get_sapi_voices()
    return voices


def synthesize_sapi(text, voice, rate):
    """tts.ps1 ile WAV sentezler. Basarisizsa None."""
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
            print("SAPI TTS zaman asimi")
            return None
        if r.returncode != 0 or not os.path.exists(wav_path):
            print("SAPI TTS hatasi:", r.stderr.decode("utf-8", errors="replace")[:500])
            return None
        with open(wav_path, "rb") as f:
            return f.read()


def synthesize_neural(text, voice, rate):
    """edge-tts ile MP3 sentezler. Basarisizsa (ornegin internet yoksa) None."""
    pct = max(-40, min(40, rate * 8))
    rate_str = f"{'+' if pct >= 0 else ''}{pct}%"
    with tempfile.TemporaryDirectory() as td:
        mp3_path = os.path.join(td, "out.mp3")

        async def run():
            comm = edge_tts.Communicate(text, voice, rate=rate_str)
            await comm.save(mp3_path)

        try:
            asyncio.run(run())
        except Exception as e:
            print("Neural TTS hatasi:", e)
            return None
        if not os.path.exists(mp3_path) or os.path.getsize(mp3_path) == 0:
            return None
        with open(mp3_path, "rb") as f:
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
            self._send_json(get_all_voices())
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
        engine = data.get("engine") or "sapi"
        try:
            rate = max(-10, min(10, int(data.get("rate") or 0)))
        except (TypeError, ValueError):
            rate = 0

        if engine == "neural":
            if not EDGE_TTS_AVAILABLE:
                self.send_error(501, "edge-tts kurulu degil (pip install edge-tts)")
                return
            audio = synthesize_neural(text, voice, rate)
            if audio is None:
                self.send_error(502, "Neural sentez basarisiz - internet baglantisini kontrol et")
                return
            content_type = "audio/mpeg"
        else:
            audio = synthesize_sapi(text, voice, rate)
            if audio is None:
                self.send_error(500, "Sentez basarisiz")
                return
            content_type = "audio/wav"

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    neural = "aktif" if EDGE_TTS_AVAILABLE else "KAPALI (pip install edge-tts)"
    print(f"VoiceForge calisiyor -> http://localhost:{PORT}  (neural TTS: {neural})")
    print("Kapatmak icin Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
