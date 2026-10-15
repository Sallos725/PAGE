#!/usr/bin/env bash
# 사용: scripts/e2e-webkit-docker.sh [playwright 인자...]   (저장소 루트에서)
# 호스트에 WebKit 시스템 라이브러리가 없어도(sudo 불필요) Playwright 공식 이미지 안에서 webkit E2E 를 돌린다.
# 사전: (cd server && npm run build) && (cd web && npm ci && npm run build). 이미지 태그는 web 의 @playwright/test 버전과 같아야 한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(node -p "require('$ROOT/web/node_modules/@playwright/test/package.json').version")"
exec docker run --rm --network host --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$ROOT:$ROOT" -w "$ROOT/web" "mcr.microsoft.com/playwright:v${VER}-noble" \
  npx playwright test --project=webkit "$@"
