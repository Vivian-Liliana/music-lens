<#
    get-model.ps1 -- download a faster-whisper model from hf-mirror.com (huggingface.co is blocked,
    and hf-xet transfer 401s against the mirror, so this pulls plain files by URL).

    Run:
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\get-model.ps1 -Name small
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\get-model.ps1 -Name medium

    Result: <project>\models\faster-whisper-<name>\  (pass this path to analyze.py)
#>
param(
    [string]$Name = 'small'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root ('models\faster-whisper-' + $Name)
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$repo = 'Systran/faster-whisper-' + $Name
$base = 'https://hf-mirror.com/' + $repo + '/resolve/main/'
$files = @('config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt', 'preprocessor_config.json')

$wc = New-Object System.Net.WebClient
$wc.Headers.Add('User-Agent', 'music-lens/1.0')

foreach ($f in $files) {
    $target = Join-Path $dest $f
    $url = $base + $f
    try {
        $head = [System.Net.WebRequest]::Create($url)
        $head.Method = 'HEAD'
        $head.Timeout = 30000
        $resp = $head.GetResponse()
        $expected = $resp.ContentLength
        $resp.Close()
    }
    catch {
        Write-Host ('  skip ' + $f + ' (not available)') -ForegroundColor DarkGray
        continue
    }

    if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) {
        Write-Host ('  ok   ' + $f + ' (already complete)') -ForegroundColor DarkGray
        continue
    }

    Write-Host ('  get  ' + $f + '  ' + [math]::Round($expected / 1MB, 1) + ' MB') -ForegroundColor Cyan
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $wc.DownloadFile($url, $target)
    $sw.Stop()
    $got = (Get-Item $target).Length
    Write-Host ('       done ' + [math]::Round($got / 1MB, 1) + ' MB in ' + [math]::Round($sw.Elapsed.TotalSeconds, 1) + 's') -ForegroundColor Green
    if ($got -ne $expected) { throw ('size mismatch on ' + $f) }
}

Write-Host ''
Write-Host ('model ready: ' + $dest) -ForegroundColor Green
