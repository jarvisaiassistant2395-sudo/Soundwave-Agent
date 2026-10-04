#!/usr/bin/env bash
# Builds assets/og-image.png (1200×630) — the card Stripe, X, LinkedIn, Slack
# and WhatsApp show when someone shares a link to this site.
#
# Uses ImageMagick and the Inter fonts already in the repo (assets/fonts/).
# Run it again after changing the headline, or point og:image at your own
# artwork — nothing else depends on it.
#
#   ./tools/make-og-image.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$(dirname "$HERE")"
REPO="$(dirname "$SITE")"
OUT="$SITE/assets/og-image.jpg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BOLD="$REPO/assets/fonts/Inter-ExtraBold.ttf"
REG="$REPO/assets/fonts/Inter-Regular.ttf"

command -v convert >/dev/null || { echo "ImageMagick (convert) is required" >&2; exit 1; }
[ -f "$BOLD" ] && [ -f "$REG" ] || { echo "Inter fonts not found in assets/fonts/" >&2; exit 1; }

W=1200
H=630

# ── 1. Background: navy gradient + two soft glows ────────────────────────
convert -size ${W}x${H} gradient:'#0d1428'-'#06090f' "$TMP/base.png"

convert -size 980x980 radial-gradient:'#8b5cf6'-none -alpha set -channel A \
  -evaluate multiply 0.55 +channel "$TMP/glow-violet.png"
convert "$TMP/base.png" "$TMP/glow-violet.png" -geometry +560-420 -compose screen -composite "$TMP/a.png"

convert -size 900x900 radial-gradient:'#3b82f6'-none -alpha set -channel A \
  -evaluate multiply 0.5 +channel "$TMP/glow-blue.png"
convert "$TMP/a.png" "$TMP/glow-blue.png" -geometry -420-380 -compose screen -composite "$TMP/b.png"

# ── 2. Logo mark, drawn from the same geometry as assets/logo.svg ────────
convert "$TMP/b.png" \
  -fill 'rgba(59,130,246,0.14)' -stroke '#3b82f6' -strokewidth 2.5 \
  -draw "roundrectangle 80,64 148,132 17,17" \
  -stroke '#5b8def' -strokewidth 3.4 -fill none \
  -draw "line 93,91 93,105" -draw "line 103,84 103,112" -draw "line 113,76 113,120" \
  -draw "line 123,87 123,109" -draw "line 133,80 133,116" \
  -fill '#8b5cf6' -stroke none -draw "circle 146,70 146,66" \
  "$TMP/c.png"

# ── 3. Wordmark + headline + subtitle ────────────────────────────────────
convert "$TMP/c.png" \
  -font "$REG" -pointsize 27 -fill '#aab3c7' \
  -annotate +160+104 'Soundwave AI' \
  -font "$BOLD" -pointsize 74 -fill '#f7f9ff' \
  -annotate +80+250 'The agent makes' \
  -annotate +80+334 'the short.' \
  -font "$REG" -pointsize 31 -fill '#b9c2d6' \
  -annotate +80+404 'Writes it · narrates it · captions it · renders it.' \
  -font "$REG" -pointsize 31 -fill '#8b97b0' \
  -annotate +80+450 'On your own PC. Free to start.' \
  "$TMP/d.png"

# ── 4. Waveform strip along the bottom, blue into violet ─────────────────
WAVE=(
  "80,548,6,34" "96,548,6,64" "112,548,6,96" "128,548,6,52" "144,548,6,112"
  "160,548,6,72" "176,548,6,40" "192,548,6,86" "208,548,6,120" "224,548,6,58"
  "240,548,6,96" "256,548,6,44" "272,548,6,70" "288,548,6,108" "304,548,6,50"
  "320,548,6,80" "336,548,6,36" "352,548,6,62"
)
DRAW=()
i=0
for bar in "${WAVE[@]}"; do
  IFS=',' read -r x _ w h <<<"$bar"
  y=$(( 578 - h / 2 ))
  # interpolate the stroke colour from #3b82f6 to #8b5cf6 across the strip
  r=$(( 59 + (139 - 59) * i / 17 ))
  g=$(( 130 + (92 - 130) * i / 17 ))
  bl=$(( 246 + (246 - 246) * i / 17 ))
  DRAW+=( -stroke "rgb($r,$g,$bl)" -strokewidth "$w" -draw "line $((x)),${y} $((x)),$((y + h))" )
  i=$(( i + 1 ))
done

convert "$TMP/d.png" -fill none "${DRAW[@]}" \
  -stroke 'rgba(255,255,255,0.10)' -strokewidth 1 -draw "line 80,520 700,520" \
  "$TMP/e.png"

# ── 5. A 9:16 "Short" frame on the right, with caption words ─────────────
convert "$TMP/e.png" \
  -fill '#050609' -stroke 'rgba(255,255,255,0.22)' -strokewidth 2 \
  -draw "roundrectangle 860,120 1090,560 22,22" \
  -fill 'rgba(56,189,248,0.30)' -stroke none -draw "polygon 864,124 1086,124 1086,300 864,400" \
  -fill 'rgba(244,63,94,0.28)' -draw "polygon 864,330 1086,260 1086,556 864,556" \
  -fill 'rgba(139,92,246,0.35)' -draw "polygon 864,200 1086,430 1086,556 864,556" \
  "$TMP/f.png"

convert "$TMP/f.png" \
  -font "$BOLD" -pointsize 25 -fill '#ffffff' -annotate +884+430 'cleans' \
  -fill '#ffe66d' -annotate +884+462 'itself' \
  -fill '#ffffff' -annotate +884+494 'while you' \
  -fill '#ffffff' -annotate +884+526 'sleep.' \
  -font "$REG" -pointsize 20 -fill 'rgba(255,255,255,0.75)' -annotate +884+170 '0:42 · 1080×1920' \
  "$TMP/g.png"

# ── 6. Save ──────────────────────────────────────────────────────────────
convert "$TMP/g.png" -strip -interlace Plane -quality 90 "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
