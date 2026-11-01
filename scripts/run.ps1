<#
    run.ps1 -- wrapper that sets the right env vars and calls analyze.py.

    Examples:
      .\scripts\run.ps1 -Audio "C:\music\song.mp3"
      .\scripts\run.ps1 -Audio "C:\music\song.mp3" -Model medium
      .\scripts\run.ps1 -Audio "song.mp3" -Out ".\out\mysong"

    Model sizes: tiny / base / small / medium / large-v3.  CPU-only, int8.
    medium is a good trade for Chinese; small is ~4x faster but rougher.
#>
param(
    [Parameter(Mandatory = $true)][string]$Audio,
    [string]$Model = 'small',
    [string]$Out = '',
    [string]$Lang = 'zh'
)

$ErrorActionPreference = 'Stop'

$py = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path $py)) { throw "python not found: $py" }

# huggingface.co is blocked here; use the mirror
$env:HF_ENDPOINT = 'https://hf-mirror.com'
# hf-xet (new transfer backend) 401s against the mirror -- force plain HTTP
$env:HF_HUB_DISABLE_XET = '1'
$env:HF_HUB_ENABLE_HF_TRANSFER = '0'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$analyze = Join-Path $PSScriptRoot 'analyze.py'
$params = @($analyze, $Audio, '--model', $Model, '--lang', $Lang)
if ($Out) { $params += @('--out', $Out) }

& $py @params
exit $LASTEXITCODE
