param(
    [Parameter(Mandatory=$true)][string]$TextFile,
    [Parameter(Mandatory=$true)][string]$OutFile,
    [string]$Voice = '',
    [int]$Rate = 0
)

Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -ne '') {
    try { $synth.SelectVoice($Voice) } catch { }
}
$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.SetOutputToWaveFile($OutFile)
$synth.Speak($text)
$synth.Dispose()
