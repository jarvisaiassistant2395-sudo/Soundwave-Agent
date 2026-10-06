# Soundwave AI - yt-dlp Standalone Downloader for Windows
$ErrorActionPreference = "SilentlyContinue"
$ProgressPreference = "SilentlyContinue"

$repoRoot = $PSScriptRoot
if ($repoRoot -match "scripts$") {
    $repoRoot = Split-Path -Parent $repoRoot
}

. "$PSScriptRoot/checksum.ps1"

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
# Each source carries its own release's SHA2-256SUMS, which is checked before
# the binary is kept: this executable runs on the customer's PC.
$downloadUrls = @(
    @{ exe = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe"; sums = "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/SHA2-256SUMS" },
    @{ exe = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"; sums = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS" }
)

$downloaded = $false
foreach ($source in $downloadUrls) {
    try {
        Write-Host " -> Fetching: $($source.exe)"
        Invoke-WebRequest -Uri $source.exe -OutFile $ytdlpExe -UseBasicParsing -TimeoutSec 90
        if (-not ((Test-Path $ytdlpExe) -and ((Get-Item $ytdlpExe).Length -gt 1000000))) {
            Write-Host " -> came back too small to be yt-dlp, trying mirror..."
            continue
        }
        # Throws on a mismatch (the file is deleted first), so a tampered or
        # truncated download can never be the one that stays.
        Assert-FileSha256 -Path $ytdlpExe -Uri $source.sums -FileName "yt-dlp.exe"
        $downloaded = $true
        break
    } catch {
        Write-Host " -> Failed from $($source.exe): $($_.Exception.Message)"
    }
}

if ($downloaded) {
    Write-Host "[SUCCESS] Standalone yt-dlp.exe ready at $ytdlpExe"
    exit 0
} else {
    Write-Host "[WARNING] Could not download yt-dlp.exe automatically. You can install it via: winget install yt-dlp"
    exit 1
}
