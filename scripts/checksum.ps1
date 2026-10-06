# ── Are the bytes we just downloaded the bytes we meant to download? ────────
# ffmpeg and yt-dlp are fetched as prebuilt executables and then run on a
# customer's PC. Until this file existed, nothing checked them beyond "it is
# bigger than a megabyte": a truncated download, a hijacked mirror or a tampered
# asset would have shipped silently. (whisper.cpp was already verified by pinned
# hash in the release workflow — this brings the other two up to the same
# standard.)
#
# Dot-source it — `. "$PSScriptRoot/checksum.ps1"` — then:
#
#   Assert-FileSha256 -Path $exe -Uri $sums -FileName "yt-dlp.exe"
#
# A MISMATCH ALWAYS FAILS. That is the case that matters: we had a published
# digest, and the file does not match it. If the digest list itself cannot be
# fetched or does not mention the file, `-Optional` decides: the default is a
# hard failure, and `-Optional` turns it into a loud warning (used for ffmpeg,
# whose vendor has no checksum API we can rely on). Either way the build says
# out loud what it could not check.

function Get-Sha256OfFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLower()
}

# The digest published for $FileName in a `sha256sum`-style list ("<hex>  <name>",
# which is what yt-dlp's SHA2-256SUMS and every similar file look like).
function Find-PublishedSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$FileName
    )
    # Some vendors publish one bare hex digest with no filename beside it; keep
    # it aside as a fallback so a file that SHOULD match still gets checked.
    $bareDigest = $null
    foreach ($line in ($Text -split "`n")) {
        $trimmed = $line.Trim()
        if (-not $trimmed) { continue }
        $parts = $trimmed -split '\s+'
        if ($parts.Count -eq 1) {
            if (-not $bareDigest -and $parts[0] -match '^[0-9a-fA-F]{64}$') { $bareDigest = $parts[0].ToLower() }
            continue
        }
        $digest = $parts[0].Trim().ToLower()
        if ($digest -notmatch '^[0-9a-f]{64}$') { continue }
        # sha256sum writes the name plain, or with a leading * for binary mode,
        # sometimes with a directory prefix ("dist/yt-dlp.exe").
        $name = $parts[-1].TrimStart('*').Trim()
        if ($name -ieq $FileName -or [System.IO.Path]::GetFileName($name) -ieq $FileName) { return $digest }
    }
    return $bareDigest
}

function Assert-FileSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        # Where the published digests live (a sums file, or "<hash> <name>" text).
        [Parameter(Mandatory = $true)][string]$Uri,
        # The name to look for in that list — usually the downloaded file's name.
        [Parameter(Mandatory = $true)][string]$FileName,
        # No digest available → warn instead of failing (see the note above).
        [switch]$Optional
    )

    if (-not (Test-Path $Path)) { throw "Assert-FileSha256: $Path does not exist" }
    $actual = Get-Sha256OfFile -Path $Path

    $text = $null
    try {
        $text = (Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 60).Content
        if ($text -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($text) }
    } catch {
        if ($Optional) {
            Write-Warning "could not fetch the checksum list from $Uri ($($_.Exception.Message)) — $FileName is UNVERIFIED"
            Write-Host "  sha256 of what was downloaded: $actual"
            return
        }
        throw "could not fetch the checksum list from $Uri : $($_.Exception.Message)"
    }

    $expected = Find-PublishedSha256 -Text $text -FileName $FileName
    if (-not $expected) {
        if ($Optional) {
            Write-Warning "no digest for $FileName in $Uri — the download is UNVERIFIED"
            Write-Host "  sha256 of what was downloaded: $actual"
            return
        }
        throw "no digest for $FileName in $Uri — refusing to keep an unverified download"
    }

    if ($expected -ne $actual) {
        Remove-Item -Force $Path -ErrorAction SilentlyContinue
        throw "$FileName checksum mismatch — expected $expected, got $actual. The download was deleted; do not ship it. Retry, and treat a repeat as a tampered mirror."
    }
    Write-Host "[checksum] $FileName sha256 $actual matches $Uri"
}
