#!/usr/bin/env bash
# 사용: scripts/epubcheck.sh <파일.epub>
# w3c/epubcheck 릴리스 jar 를 tools/ 에 받아(gitignore) 검사한다. java 필요. epubcheck 출력을 그대로 보여 준다.
set -euo pipefail
if [ $# -lt 1 ]; then echo "usage: $0 <file.epub>" >&2; exit 2; fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="5.2.1"
# W3C 는 다운로드 해시를 따로 공개하지 않는다. 이 값은 우리가 처음 받은 zip 의 sha256 (trust-on-first-use).
SHA="0532f6291faa2bb729dd253f958868a2a57dbd2c32f881a97c7c980c5940309e"
DIR="$ROOT/tools/epubcheck-$VER"
ZIP="$ROOT/tools/epubcheck-$VER.zip"
if [ ! -f "$DIR/epubcheck.jar" ]; then
  mkdir -p "$ROOT/tools"
  curl -fsSL -o "$ZIP" "https://github.com/w3c/epubcheck/releases/download/v$VER/epubcheck-$VER.zip"
  if ! echo "$SHA  $ZIP" | sha256sum -c - >/dev/null; then
    rm -f "$ZIP"
    echo "epubcheck zip sha256 mismatch; deleted" >&2
    exit 1
  fi
  (cd "$ROOT/tools" && unzip -q -o "epubcheck-$VER.zip")
fi
java -jar "$DIR/epubcheck.jar" "$1"
