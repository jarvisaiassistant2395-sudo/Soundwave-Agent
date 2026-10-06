<#
  Build the Windows installers on THIS PC, without GitHub Actions.

  ---------------------------------------------------------------------------
  Why this exists

  .github/workflows/release-desktop.yml is the only other place that builds the
  installers, and it needs Actions minutes. This script does the same work in
  the same order on a Windows machine, so a build is never blocked on CI
  billing, a queue, or a network policy. It is not a shortcut around the gates:
  the typecheck, both test suites, the DLL check, the licence audit, the
  packaged-app smoke test and the yt-dlp-runtime verification all still run.

  ---------------------------------------------------------------------------
  What it produces

    desktop\release\SoundwaveAI-Setup-<version>.exe        the installer
    desktop\release\SoundwaveAI-Portable-<version>.exe     portable, same bits

  (with -Dev: SoundwaveAI*Dev-Setup-*.exe - the unlocked build, no billing.)

  ---------------------------------------------------------------------------
  Keep this file PURE ASCII.

  Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI (CP1252): one non-ASCII
  character (an em-dash, a box-drawing line) becomes mojibake mid-string and the
  parser dies with "Unexpected token". This file carries a UTF-8 BOM as well,
  but ASCII-only is what survives an editor that drops the BOM.

  ---------------------------------------------------------------------------
  Use

    powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Dev
    powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -SkipTests -SkipBinaries   # fast rebuild

  First run downloads ~500 MB (Electron, NSIS, ffmpeg, yt-dlp, the speech
  engine and its model). Later runs reuse everything already in desktop\bin.

  To hand the finished installer to people, put it on a GitHub Release - never
  in the repository. Git refuses any file over 100 MB, and these are ~220 MB;
  even if they fitted, every clone would carry them forever:

    ... -PublishTag v1.6.7        (needs gh, authenticated: gh auth login)

  Publishing to the auto-update feed (desktop/src/update.cjs) is separate and
  documented in docs/RELEASING.md -> "Updates and downloads": the feed lives in
  its own public repo and wants latest.yml next to the setup exe.
#>
[CmdletBinding()]
param(
  [switch]$Dev,                 # build "Soundwave AI - Dev" (everything unlocked, no billing)
  [switch]$SkipTests,           # skip the three test suites (still typechecks and builds)
  [switch]$SkipBinaries,        # reuse whatever is already staged in desktop\bin
  [switch]$KeepGoing,           # don't stop at the first failure (for diagnosis)
  [string]$YouTubeClientId = "",     # optional: bakes one-press "Connect YouTube"
  [string]$YouTubeClientSecret = "",
  [string]$PublishTag = "",     # optional: upload the installers to this Release tag
  [string]$FfmpegUrl = ""       # optional: a different Windows ffmpeg zip, if gyan.dev is blocked
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# TLS 1.2 for the downloads below. Windows PowerShell 5.1 runs on .NET
# Framework, which has no SecurityProtocolType.Tls13 - naming it stops the
# script before its first stage - and .NET negotiates up to whatever the OS
# and the server support anyway. Wrapped because this line runs before any
# stage can report a failure.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {
  Write-Host "    (could not pin TLS 1.2; using the system default)" -ForegroundColor DarkGray
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverDir = Join-Path $repoRoot "server"
$frontendDir = Join-Path $repoRoot "frontend"
$desktopDir = Join-Path $repoRoot "desktop"
$binDir = Join-Path $desktopDir "bin"
$failures = New-Object System.Collections.Generic.List[string]

function Say([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Note([string]$Text) { Write-Host "    $Text" -ForegroundColor DarkGray }
function Good([string]$Text) { Write-Host "  ok  $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  !!  $Text" -ForegroundColor Yellow }

# Run a native command in a directory and fail loudly on a non-zero exit.
function Invoke-Stage([string]$Name, [string]$Where, [scriptblock]$Block) {
  Say $Name
  Push-Location $Where
  try {
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$Name exited $LASTEXITCODE" }
    Good $Name
  } catch {
    $message = "$Name - $($_.Exception.Message)"
    Warn $message
    $failures.Add($message) | Out-Null
    if (-not $KeepGoing) { throw }
  } finally {
    Pop-Location
  }
}

# Download to a file, with retries - a home connection blips more than CI does.
#
# Streamed by hand rather than with Invoke-WebRequest, for one blunt reason: on
# Windows PowerShell that cmdlet writes nothing at all until the whole file has
# arrived, so a 100 MB download sits there looking hung with no way to tell it
# from a dead connection. This one shows a moving line - percent, megabytes,
# speed - and keeps a heartbeat going every couple of seconds so a slow mirror
# reads as slow rather than broken.
function Get-Url([string]$Url, [string]$Out) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Get-UrlOnce $Url $Out
      return
    } catch {
      if ($attempt -eq 3) { throw "couldn't download $Url - $($_.Exception.Message)" }
      Warn "attempt $attempt failed for $Url - $($_.Exception.Message)"
      Start-Sleep -Seconds 3
    }
  }
}

function Get-UrlOnce([string]$Url, [string]$Out) {
  $request = [System.Net.WebRequest]::Create($Url)
  if ($request -is [System.Net.HttpWebRequest]) {
    $request.AllowAutoRedirect = $true
    $request.UserAgent = "Soundwave-build"
    $request.Timeout = 60000            # for the response headers, not the download
    $request.ReadWriteTimeout = 120000  # per read: a slow-but-moving link survives
  }
  $response = $request.GetResponse()
  $in = $response.GetResponseStream()
  $out = [System.IO.File]::Create($Out)
  $buffer = New-Object byte[] 262144
  $total = $response.ContentLength
  $done = 0
  $started = Get-Date
  $lastShown = -1
  $lastAt = $started
  try {
    while ($true) {
      $read = $in.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      $out.Write($buffer, 0, $read)
      $done += $read
      $now = Get-Date
      $pct = if ($total -gt 0) { [int](100 * $done / $total) } else { -1 }
      if (($pct -ne $lastShown) -or (($now - $lastAt).TotalSeconds -ge 2)) {
        $lastShown = $pct
        $lastAt = $now
        $mb = [math]::Round($done / 1MB, 1)
        $rate = $done / 1MB / [math]::Max(($now - $started).TotalSeconds, 0.001)
        if ($total -gt 0) {
          Write-Host ("`r    {0,3}%  {1,7:N1} of {2,7:N1} MB  {3,5:N1} MB/s " -f $pct, $mb, ($total / 1MB), $rate) -NoNewline -ForegroundColor DarkGray
        } else {
          Write-Host ("`r    {0,7:N1} MB  {1,5:N1} MB/s " -f $mb, $rate) -NoNewline -ForegroundColor DarkGray
        }
      }
    }
  } finally {
    $out.Close()
    $in.Close()
    $response.Close()
    Write-Host ""
  }
  $size = (Get-Item $Out).Length
  if ($size -le 0) { throw "downloaded nothing" }
  if ($total -gt 0 -and $size -ne $total) { throw "only received $size of $total bytes" }
  $secs = [int][math]::Max(((Get-Date) - $started).TotalSeconds, 1)
  Note "$([math]::Round($size / 1MB, 1)) MB in ${secs}s"
}

function Assert-File([string]$Path, [int]$MinBytes, [string]$What) {
  if (-not (Test-Path $Path)) { throw "$What is missing ($Path)" }
  $size = (Get-Item $Path).Length
  if ($size -lt $MinBytes) { throw "$What looks wrong ($size bytes at $Path)" }
}

# -- Preflight ---------------------------------------------------------------
Say "Preflight"
if (-not (Test-Path (Join-Path $serverDir "package.json"))) { throw "run this from a checkout of the Soundwave repository" }
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw "Node.js is not on PATH - install Node 20 or newer (https://nodejs.org)" }
# CI builds on Node 20; anything older fails later and more confusingly.
$nodeMajor = [int]($nodeVersion.TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) { throw "Node $nodeVersion is too old - this needs Node 20 or newer (CI uses 20)" }
Note "node $nodeVersion"
Note "repository $repoRoot"
$version = (Get-Content (Join-Path $desktopDir "package.json") -Raw | ConvertFrom-Json).version
$edition = if ($Dev) { "Soundwave AI - Dev (unlocked, no billing)" } else { "Soundwave AI (the sold build)" }
Note "version $version - $edition"
Note "PowerShell $($PSVersionTable.PSVersion)"

# -- The ffmpeg the tests will render with -----------------------------------
# Deliberately before the backend tests. CI runs on a runner that already has a
# current ffmpeg on PATH; a home PC may have an old one (conda ships 4.2/4.3,
# which has no "gradients" source, so the render fixtures fail) or none at all.
# Staging it here means the tests run against the binary the installer ships -
# the stronger claim - and where a build lacks a feature, the suites skip that
# test instead of failing it.
if (-not $SkipBinaries) {
  New-Item -ItemType Directory -Force $binDir | Out-Null

  Say "ffmpeg.exe (gyan.dev essentials)"
  $ffmpegExe = Join-Path $binDir "ffmpeg.exe"
  if ((Test-Path $ffmpegExe) -and (Get-Item $ffmpegExe).Length -gt 1000000) {
    Good "already staged ($((Get-Item $ffmpegExe).Length) bytes)"
  } else {
    $zip = Join-Path $env:TEMP "sw-ffmpeg.zip"
    $extract = Join-Path $env:TEMP "sw-ffmpeg-extract"
    $sources = if ($FfmpegUrl) { @($FfmpegUrl) } else { @(
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
      "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
    ) }
    $got = $false
    foreach ($url in $sources) {
      try {
        Get-Url $url $zip
        $got = $true
        Note "from $url"
        if ($url -notlike "*gyan.dev*") { Warn "this is the fallback build - a GPL ffmpeg, but not the exact one CI ships" }
        break
      } catch {
        Warn "ffmpeg download failed from $url - $($_.Exception.Message)"
      }
    }
    if (-not $got) {
      throw "could not download ffmpeg. Download any Windows ffmpeg build you trust, put its ffmpeg.exe in $binDir, and run this script again - it will use that one and skip the download."
    }
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $found = Get-ChildItem -Path $extract -Filter "ffmpeg.exe" -Recurse | Select-Object -First 1
    if (-not $found) { throw "ffmpeg.exe was not inside the zip that was downloaded" }
    Copy-Item $found.FullName $ffmpegExe -Force
    Remove-Item -Recurse -Force $zip, $extract -ErrorAction SilentlyContinue
    Assert-File $ffmpegExe 1000000 "ffmpeg.exe"
    Good "staged $((Get-Item $ffmpegExe).Length) bytes"
  }

}
$stagedFfmpeg = Join-Path $binDir "ffmpeg.exe"
if (Test-Path $stagedFfmpeg) {
  $env:FFMPEG_PATH = $stagedFfmpeg
  Note "the tests below render with $stagedFfmpeg (FFMPEG_PATH)"
  # GPLv3 wants the licence text and the written offer of source beside the
  # binary, and the audit that runs during the backend tests refuses a staged
  # ffmpeg without them - so they are written here, with the staging, not
  # later with the other binaries. (assemble.mjs calls this again on every
  # packaging run, so however ffmpeg got into bin/ the paper travels with it.)
  Invoke-Stage "Write the ffmpeg licences" $repoRoot { node scripts/write-binary-licenses.mjs }
} else {
  Warn "nothing staged in desktop\bin - the tests will use the 'ffmpeg' on PATH"
  if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    if (-not (& ffmpeg -hide_banner -filters 2>$null | Select-String -SimpleMatch "gradients")) {
      Warn "that ffmpeg has no 'gradients' filter (older than 4.4): the render tests will fail"
      Warn "fix the PATH for this window, or drop -SkipBinaries so the build stages its own"
    }
  } else {
    Warn "there is no 'ffmpeg' on PATH either - the render tests will fail"
  }
}

# -- Backend -----------------------------------------------------------------
Invoke-Stage "Install backend dependencies" $serverDir { npm ci --no-audit --no-fund }
Invoke-Stage "Typecheck backend" $serverDir { npm run typecheck }
if (-not $SkipTests) { Invoke-Stage "Test backend" $serverDir { npm test } }
Invoke-Stage "Build backend (tsc -> dist)" $serverDir { npm run build }

# -- Frontend ----------------------------------------------------------------
Invoke-Stage "Install frontend dependencies" $frontendDir { npm ci --no-audit --no-fund }
Invoke-Stage "Build frontend (tsc -> vite build)" $frontendDir { npm run build }

# -- Runtime binaries the installer carries ----------------------------------
# Exactly what the workflow stages, to the same folders, from the same
# sources - a locally built installer has to be the same product as a CI one.
if (-not $SkipBinaries) {
  New-Item -ItemType Directory -Force $binDir | Out-Null

  Say "yt-dlp.exe (nightly first - YouTube fixes land there first)"
  $ytdlpExe = Join-Path $binDir "yt-dlp.exe"
  if ((Test-Path $ytdlpExe) -and (Get-Item $ytdlpExe).Length -gt 1000000) {
    Good "already staged ($((Get-Item $ytdlpExe).Length) bytes)"
  } else {
    $ok = $false
    foreach ($url in @(
      "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp.exe",
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    )) {
      try { Get-Url $url $ytdlpExe; $ok = $true; break } catch { Warn "yt-dlp download failed from $url" }
    }
    if (-not $ok) { throw "could not download yt-dlp.exe (try: winget install yt-dlp, then copy yt-dlp.exe into desktop\bin)" }
    Assert-File $ytdlpExe 1000000 "yt-dlp.exe"
    Good "staged $((Get-Item $ytdlpExe).Length) bytes"
  }

  Say "Caption font (Inter, OFL-1.1 - travels with the app)"
  $fontDest = Join-Path $binDir "fonts"
  New-Item -ItemType Directory -Force $fontDest | Out-Null
  Get-ChildItem (Join-Path $repoRoot "assets\fonts") -File | Copy-Item -Destination $fontDest -Force
  $fontCount = (Get-ChildItem $fontDest).Count
  if ($fontCount -lt 1) { throw "assets\fonts is empty - the captions would render in a fallback font" }
  Good "$fontCount file(s)"

  Say "Speech engine (whisper.cpp v1.9.2 + the English model)"
  $tag = "v1.9.2"
  $zipSha256 = "49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a"
  $model = "ggml-base.en-q5_1.bin"
  $whisperDir = Join-Path $binDir "whisper"
  New-Item -ItemType Directory -Force $whisperDir | Out-Null
  $cliExe = Join-Path $whisperDir "whisper-cli.exe"
  if ((Test-Path $cliExe) -and (Get-Item $cliExe).Length -gt 100000) {
    Good "already staged"
  } else {
    $zip = Join-Path $env:TEMP "sw-whisper.zip"
    $extract = Join-Path $env:TEMP "sw-whisper-extract"
    Get-Url "https://github.com/ggml-org/whisper.cpp/releases/download/$tag/whisper-bin-x64.zip" $zip
    $hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $zipSha256) { throw "whisper-bin-x64.zip checksum mismatch: $hash (expected $zipSha256)" }
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $cli = Get-ChildItem -Path $extract -Filter "whisper-cli.exe" -Recurse | Select-Object -First 1
    if (-not $cli) { throw "whisper-cli.exe was not inside whisper-bin-x64.zip" }
    Copy-Item $cli.FullName $whisperDir -Force
    # whisper.dll + every ggml*.dll (all CPU variants); SDL2 is only for the demos.
    Get-ChildItem $cli.DirectoryName -Filter *.dll | Where-Object { $_.Name -ne "SDL2.dll" } | Copy-Item -Destination $whisperDir -Force
    Remove-Item -Recurse -Force $zip, $extract -ErrorAction SilentlyContinue
    Good "whisper-cli.exe + $((Get-ChildItem $whisperDir -Filter *.dll).Count) DLL(s)"
  }

  $licenseFile = Join-Path $whisperDir "LICENSE-whisper.cpp.txt"
  if (-not (Test-Path $licenseFile)) {
    Get-Url "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$tag/LICENSE" $licenseFile
  }

  $modelPath = Join-Path $whisperDir $model
  if ((Test-Path $modelPath) -and (Get-Item $modelPath).Length -gt 40MB) {
    Good "model already staged"
  } else {
    Get-Url "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$model" $modelPath
    Assert-File $modelPath 40MB $model
    # "lmgg" is ggml's magic - a login page saved as .bin must not pass as a model.
    $head = [byte[]]([System.IO.File]::ReadAllBytes($modelPath)[0..3])
    if ([System.Text.Encoding]::ASCII.GetString($head) -ne "lmgg") { throw "$model doesn't look like a ggml model" }
    Good "staged $([math]::Round((Get-Item $modelPath).Length / 1MB, 1)) MB"
  }

  # A real recording for the voice-input tests (not shipped in the app).
  $jfk = Join-Path $desktopDir "jfk.wav"
  if (-not (Test-Path $jfk)) { Get-Url "https://raw.githubusercontent.com/ggml-org/whisper.cpp/$tag/samples/jfk.wav" $jfk }

  # Every DLL the engine imports must ship with it: this copies the Microsoft
  # C++ runtime next to the engine and fails if anything else is missing.
  Invoke-Stage "Check the speech engine runs on a clean PC" $desktopDir {
    node check-dlls.mjs bin/whisper --copy-runtime-from "$env:WINDIR\System32"
  }
} else {
  Warn "skipping the runtime binaries (-SkipBinaries) - the installer will only be good if desktop\bin is already complete"
}

# -- The gates ---------------------------------------------------------------
Invoke-Stage "Audit the licences of everything in the installer" $repoRoot { node scripts/license-audit.mjs --write }
Invoke-Stage "Install desktop tooling (Electron + electron-builder)" $desktopDir { npm ci --no-audit --no-fund }
if (-not $SkipTests) { Invoke-Stage "Test the desktop shell's helpers" $desktopDir { npm test } }

# -- Assemble, smoke, package ------------------------------------------------
Invoke-Stage "Assemble the packaged app tree" $desktopDir { node assemble.mjs }
Invoke-Stage "Smoke-test the assembled app (boots it like the shell does)" $desktopDir { node smoke.mjs }

if ($YouTubeClientId -and $YouTubeClientSecret) {
  Say "Bake Soundwave's Google client (one-press Connect YouTube)"
  $configDir = Join-Path $desktopDir "config"
  New-Item -ItemType Directory -Force $configDir | Out-Null
  # Written through .NET, not Set-Content: PowerShell 5.1's "-Encoding utf8" puts
  # a BOM on the file, JSON.parse refuses a BOM, and the reader would fall through
  # to "no baked client" while the file sat there looking correct.
  $jsonPath = Join-Path $configDir "youtube-client.json"
  $json = @{ client_id = $YouTubeClientId; client_secret = $YouTubeClientSecret } | ConvertTo-Json
  [System.IO.File]::WriteAllText($jsonPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Good "desktop\config\youtube-client.json"
} elseif (-not $Dev) {
  Note "(no Google client baked: Connect YouTube asks for a client id + secret in Settings)"
}

if ($Dev) {
  Invoke-Stage "Build installers - Soundwave AI - Dev" $desktopDir { npx electron-builder --config electron-builder.dev.yml --win --publish never }
  $exeName = "Soundwave AI - Dev.exe"
} else {
  Invoke-Stage "Build installers - Soundwave AI" $desktopDir { npx electron-builder --win --publish never }
  $exeName = "Soundwave AI.exe"
}

Invoke-Stage "Verify the packaged app can be yt-dlp's JavaScript runtime" $desktopDir {
  node verify-runtime.mjs (Join-Path "release\win-unpacked" $exeName)
}

# -- What came out -----------------------------------------------------------
Say "Done"
$releaseDir = Join-Path $desktopDir "release"
$artifacts = @(Get-ChildItem $releaseDir -Filter *.exe -ErrorAction SilentlyContinue | Sort-Object Name)
if ($artifacts.Count -eq 0) { throw "no installer in $releaseDir - check the electron-builder output above" }
foreach ($a in $artifacts) {
  Write-Host ("  {0,-46} {1,8:N1} MB" -f $a.Name, ($a.Length / 1MB)) -ForegroundColor White
  Note $a.FullName
}

if ($PublishTag) {
  Say "Publish to the GitHub Release $PublishTag"
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Warn "gh isn't installed - upload the files by hand, or install GitHub CLI and re-run with -PublishTag"
  } else {
    $files = @($artifacts | ForEach-Object { $_.FullName })
    $repoSlug = (& git -C $repoRoot remote get-url origin) 2>$null
    if ($repoSlug -match "github\.com[:/](.+?)(\.git)?$") { $repoSlug = $Matches[1] } else { $repoSlug = "" }
    if (-not $repoSlug) { throw "couldn't work out which GitHub repo this is (git remote get-url origin)" }
    Note "repo $repoSlug"
    & gh release view $PublishTag --repo $repoSlug 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      & gh release create $PublishTag @files --title "Soundwave AI $PublishTag" --generate-notes
    } else {
      & gh release upload $PublishTag @files --clobber
    }
    if ($LASTEXITCODE -ne 0) { throw "gh couldn't publish the release" }
    Good "published - $PublishTag"
    Note "a v* tag pushed to the branch is what CI would use; a Release is fine on its own"
  }
}

if ($failures.Count -gt 0) {
  Write-Host "`nFinished with $($failures.Count) failed stage(s):" -ForegroundColor Yellow
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
  exit 1
}
Write-Host "`nInstallers are in $releaseDir" -ForegroundColor Green
Write-Host "Install one, then check Settings -> Voice & Desktop says version $version." -ForegroundColor Green
