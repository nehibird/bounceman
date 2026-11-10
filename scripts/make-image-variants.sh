#!/usr/bin/env bash
# Generate <file>.w400.webp / <file>.w800.webp next to every equipment photo (see lib/img-variants.js).
# WHY: originals are 150-800 KB at 1250-2000 px but shown at ~350 px; on weak mobile signal the
# catalog was 7 MB / 34 s LCP. Idempotent, NEVER touches or deletes an original, skips anything
# that already is a derivative. Re-run after the owner uploads new photos (until then the views
# fall back to the original, so a new upload always renders).
# Usage: scripts/make-image-variants.sh [dir ...]   (default: both equipment dirs)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIRS=("$@"); [ ${#DIRS[@]} -eq 0 ] && DIRS=("$ROOT/uploads/equipment" "$ROOT/public/assets/images/equipment")
for d in "${DIRS[@]}"; do
  for f in "$d"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.w400.webp|*.w800.webp|*.bak*) continue;; esac
    case "${f,,}" in *.jpg|*.jpeg|*.png|*.webp|*.avif) ;; *) continue;; esac
    ow=$(identify -format %w "$f[0]" 2>/dev/null) || continue
    [ "$ow" -gt 400 ] || continue                       # already thumbnail-sized: original is the variant
    for spec in "400:70" "800:64"; do
      w=${spec%%:*}; q=${spec##*:}; out="$f.w$w.webp"
      [ -e "$out" ] && continue
      tw=$w; [ "$ow" -lt "$w" ] && tw=$ow                # never upscale
      convert "$f[0]" -auto-orient -resize "${tw}x" -strip -define webp:method=6 -quality "$q" "$out.tmp.webp"
      mv "$out.tmp.webp" "$out"                          # atomic: a half-written file is never served
    done
  done
done
