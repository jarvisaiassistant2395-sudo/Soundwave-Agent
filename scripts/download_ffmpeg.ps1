[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$vendorDir = Join-Path $PSScriptRoot "..\vendor\ffmpeg"
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
$targetExe = Join-Path $vendorDir "ffmpeg.exe"

. "$PSScriptRoot/checksum.ps1"

if (Test-Path $targetExe) {
    Write-Host "[SUCCESS] FFmpeg already present at $targetExe"
    exit 0
}

Write-Host "[INFO] Downloading FFmpeg Windows Essentials..."
$zipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$zipPath = Join-Path $vendorDir "ffmpeg.zip"
$tmpDir = Join-Path $vendorDir "tmp_extract"

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
    # gyan.dev publishes a .sha256 next to each zip. It is checked when it can be
    # fetched, and `-Optional` keeps a moved URL from breaking a local setup —
    # a digest that IS there and does NOT match still fails hard, which is the
    # case worth catching (a truncated or swapped archive).
    Assert-FileSha256 -Path $zipPath -Uri "$zipUrl.sha256" -FileName "ffmpeg-release-essentials.zip" -Optional
    Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force
    $found = Get-ChildItem -Path $tmpDir -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    if ($found) {
        Copy-Item -Path $found.FullName -Destination $targetExe -Force
        Write-Host "[SUCCESS] Installed FFmpeg to $targetExe"
    }
} catch {
    Write-Warning "PowerShell download failed: $($_.Exception.Message)"
} finally {
    Remove-Item -Recurse -Force $zipPath -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
