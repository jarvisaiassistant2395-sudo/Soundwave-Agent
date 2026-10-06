# Soundwave AI - yt-dlp Standalone Downloader for Windows
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$repoRoot = $PSScriptRoot
if ($repoRoot -match "scripts$") {
    $repoRoot = Split-Path -Parent $repoRoot
}

$vendorDir = Join-Path $repoRoot "vendor\yt-dlp"
if (-not (Test-Path $vendorDir)) {
    New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
}

$ytdlpExe = Join-Path $vendorDir "yt-dlp.exe"

if (Test-Path $ytdlpExe) {
    if ((Get-Item $ytdlpExe).Length -gt 1000000) {
        Write-Host "[INFO] yt-dlp.exe already present in vendor\yt-dlp\yt-dlp.exe"
        exit 0
    }
}

Write-Host "[INFO] Downloading standalone yt-dlp.exe for the YouTube link importer..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13

# Nightly first: it is the channel yt-dlp recommends for regular users, and
# fixes for YouTube changes land there days or weeks before a stable release.
$downloadUrls = @(
    "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe",
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
)

$downloaded = $false
foreach ($url in $downloadUrls) {
    try {
        Write-Host " -> Fetching: $url"
        Invoke-WebRequest -Uri $url -OutFile $ytdlpExe -UseBasicParsing -TimeoutSec 90
        if ((Test-Path $ytdlpExe) -and ((Get-Item $ytdlpExe).Length -gt 1000000)) {
            $downloaded = $true
            break
        }
    } catch {
        Write-Host " -> Download failed from $url, trying mirror..."
    }
}

if ($downloaded) {
    Write-Host "[SUCCESS] Standalone yt-dlp.exe ready at $ytdlpExe"
    exit 0
} else {
    Write-Host "[WARNING] Could not download yt-dlp.exe automatically. You can install it via: winget install yt-dlp"
    exit 1
}
