# ⚒️ VoiceForge

Oyun karakteri ses dönüştürücü — bir voice line'ı (örn. *"Kill them all!"*) iblis lordu, ork, elf, hayalet gibi karakter seslerine çevirir. Tamamen lokal çalışır; hiçbir ses dosyası internete gitmez.

## Çalıştırma

```powershell
.\start.ps1
```

veya:

```powershell
python server.py
# sonra tarayıcıda http://localhost:8765
```

## Özellikler

- **3 giriş yöntemi**: ses dosyası (sürükle-bırak), mikrofon kaydı, metin → ses (Windows SAPI TTS)
- **10 karakter preseti**: İblis Lordu, Ork, Mağara Trolü, Dev, Zombi, Elf, Hayalet, Goblin, Robot, Telsiz
- **İnce ayar**: pitch (±8 yarımton), efekt yoğunluğu, reverb miktarı
- **Çıktı**: 16-bit PCM WAV — UE5'e direkt import edilir

## Nasıl çalışır

Efekt motoru tamamen tarayıcıda, Web Audio API ile koşar (`audio-engine.js`):

1. **Granüler pitch shift** (süre korunur) + oktav-alt/üst katmanlama
2. Preset zinciri: biquad filtreler → ring modulation → distortion/bitcrush → chorus/tremolo → feedback echo
3. Üretilmiş impulse response ile convolution reverb (dry/wet)
4. Master kompresör → peak normalize → kuyruk kırpma

TTS (`server.py` + `tts.ps1`): Python stdlib sunucusu, Windows'un yerleşik `System.Speech` sentezleyicisini PowerShell üzerinden çağırıp WAV döndürür. Ek paket kurulumu gerekmez.

## Notlar

- TTS sekmesi yalnızca `server.py` ile açıldığında aktiftir (statik açılışta devre dışı kalır).
- TTS ses kalitesi SAPI seviyesindedir (robotik) — placeholder voice line için uygundur; final seslendirmede gerçek kayıt kullan.
- Mikrofon erişimi `localhost` üzerinde çalışır (tarayıcı güvenli bağlam ister).
