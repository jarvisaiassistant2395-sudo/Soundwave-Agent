[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$vendorDir = Join-Path $PSScriptRoot "..\vendor\ffmpeg"
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
$targetExe = Join-Path $vendorDir "ffmpeg.exe"

if (Test-Path $targetExe) {
    Write-Host "[SUCCESS] FFmpeg already present at $targetExe"
    exit 0
}

Write-Host "[INFO] Downloading FFmpeg Windows Essentials..."
$zipPath = Join-Path $vendorDir "ffmpeg.zip"
$tmpDir = Join-Path $vendorDir "tmp_extract"

try {
    Invoke-WebRequest -Uri "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zipPath
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
