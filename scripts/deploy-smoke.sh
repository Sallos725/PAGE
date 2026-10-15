#!/usr/bin/env bash
# 사용: scripts/deploy-smoke.sh   (저장소 루트에서. 사전: cd server && npm run build — 합성 save 생성기 dist 사용)
# 이미지를 빌드하고 합성 save 로 일회용 컨테이너를 띄워 헬스·SPA·CSP·읽기전용을 확인한다. 실제 save 는 쓰지 않는다.
# page-pdf 사이드카도 --internal 일회용 네트워크에 같은 보안 옵션으로 띄워, 형식 목록과 PDF 내보내기까지 확인한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="page:smoke"
WORK="$(mktemp -d)"
NAME="page-smoke-$$"
PDF_TAG="page-pdf:smoke"
PDF_NAME="page-pdf-smoke-$$"
NET="page-smoke-net-$$"
cleanup() { docker rm -f "$NAME" "$PDF_NAME" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker build -q -t "$TAG" "$ROOT" >/dev/null
docker build -q -t "$PDF_TAG" "$ROOT/pdf" >/dev/null
docker network create --internal "$NET" >/dev/null
mkdir -p "$WORK/src" "$WORK/data"
node --input-type=module -e "
  const { writeSource, baseSpec } = await import('$ROOT/server/dist/tools/synthetic-source.js');
  writeSource('$WORK/src', baseSpec());
"
chmod -R a+rX "$WORK/src"
# page-pdf: 외부로 나갈 길이 없는 internal 네트워크에만 붙인다 (compose 와 같은 옵션).
docker run -d --name "$PDF_NAME" --network "$NET" --init --read-only --tmpfs /tmp:size=1g --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 3g --user "$(id -u):$(id -g)" "$PDF_TAG" >/dev/null
# page: 기본 bridge(포트 게시) + internal 네트워크(사이드카로 가는 길).
docker run -d --name "$NAME" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  --user "$(id -u):$(id -g)" -e PAGE_SOURCES=main=/sources/main -e "PAGE_PDF_URL=http://$PDF_NAME:8790" \
  -v "$WORK/src:/sources/main:ro" -v "$WORK/data:/data" -p 127.0.0.1:18787:8787 "$TAG" >/dev/null
docker network connect "$NET" "$NAME"

for i in $(seq 1 30); do curl -fsS http://127.0.0.1:18787/api/health >/dev/null 2>&1 && break; sleep 1; done
fail() { echo "SMOKE FAIL: $*"; docker logs "$NAME" 2>&1 | tail -20; docker logs "$PDF_NAME" 2>&1 | tail -20; exit 1; }
curl -fsS http://127.0.0.1:18787/api/health | grep -q '"status":"ok"' || fail health
curl -fsS http://127.0.0.1:18787/api/sources | grep -q '"id":"main"' || fail sources
for i in $(seq 1 30); do [ "$(curl -fsS 'http://127.0.0.1:18787/api/chars?source=main' | grep -o '"charId"' | wc -l)" -ge 1 ] && break; sleep 1; done
[ "$(curl -fsS 'http://127.0.0.1:18787/api/chars?source=main' | grep -o '"charId"' | wc -l)" -eq 2 ] || fail chars-after-sync
JOB="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"format":"json"}' 'http://127.0.0.1:18787/api/export?source=main&char=c1&chat=a1' | grep -o '[0-9a-f]\{32\}')" || fail export-start
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:18787/api/export/$JOB" | grep -q '"state":"done"' && break; sleep 1; done
curl -fsS "http://127.0.0.1:18787/api/export/$JOB/download" | grep -q '"type":"risuChat"' || fail export-download
# 숨김 규칙 하나를 만들어 EPUB 내보내기에 넘긴다 — 읽기전용 컨테이너에서 규칙 워커와 zip 생성까지 실제로 돈다.
RULE="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"name":"smoke","pattern":"zzz-no-match","scope":"global"}' 'http://127.0.0.1:18787/api/state/hide-rules?source=main')" || fail rule-create
RULE_ID="$(printf '%s' "$RULE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
[ -n "$RULE_ID" ] || fail rule-id
EJOB="$(curl -fsS -X POST -H 'content-type: application/json' -d "{\"format\":\"epub\",\"options\":{\"hideRuleIds\":[\"$RULE_ID\"]}}" 'http://127.0.0.1:18787/api/export?source=main&char=c1&chat=a1' | grep -o '[0-9a-f]\{32\}')" || fail epub-start
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:18787/api/export/$EJOB" | grep -q '"state":"done"' && break; sleep 1; done
[ "$(curl -fsS "http://127.0.0.1:18787/api/export/$EJOB/download" | head -c 2)" = "PK" ] || fail epub-download
# PDF 사이드카: 준비될 때까지 기다린 뒤, 형식 목록에 pdf 가 있고 내보낸 파일이 %PDF 로 시작해야 한다.
for i in $(seq 1 60); do docker exec "$PDF_NAME" node -e "fetch('http://127.0.0.1:8790/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:18787/api/export/formats | grep -q '"pdf"' || fail formats-pdf
PJOB="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"format":"pdf","options":{"imageMode":"compat"}}' 'http://127.0.0.1:18787/api/export?source=main&char=c1&chat=a1' | grep -o '[0-9a-f]\{32\}')" || fail pdf-start
for i in $(seq 1 120); do curl -fsS "http://127.0.0.1:18787/api/export/$PJOB" | grep -q '"state":"\(done\|failed\)"' && break; sleep 1; done
curl -fsS "http://127.0.0.1:18787/api/export/$PJOB" | grep -q '"state":"done"' || fail pdf-state
[ "$(curl -fsS "http://127.0.0.1:18787/api/export/$PJOB/download" | head -c 4)" = "%PDF" ] || fail pdf-download
# 사이드카는 읽기전용·비루트이고, internal 네트워크라 밖으로 나가지 못한다.
[ "$(docker exec "$PDF_NAME" id -u)" != "0" ] || fail pdf-runs-as-root
docker exec "$PDF_NAME" sh -c 'touch /app/x' 2>/dev/null && fail pdf-rootfs-writable
# 양성 대조: 같은 fetch 가 internal 네트워크 안의 page 에는 닿아야 한다 (그래야 아래 실패가 "도구 고장"이 아니라 "길 없음"이다).
docker exec "$PDF_NAME" node -e "fetch('http://$NAME:8787/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" || fail pdf-egress-control
docker exec "$PDF_NAME" node -e "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(1)).catch(()=>process.exit(0))" || fail pdf-egress
# 그림 변환 라이브러리(sharp, 네이티브)가 컨테이너(읽기전용·비루트)에서 실제로 로드되고 WebP 를 만든다.
docker exec -w /app/server "$NAME" node -e "import('sharp').then(async ({default:s})=>{const b=await s({create:{width:8,height:8,channels:4,background:'#0000'}}).webp().toBuffer();process.exit(b.length>0?0:1)})" || fail sharp
# 커스텀 테마 · 글꼴 서재
THEME="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"name":"smoke","base":"dark","css":":root[data-theme]{--bg:#000000;}"}' http://127.0.0.1:18787/api/themes | grep -o '[0-9a-f]\{32\}' | head -1)" || fail theme-create
curl -fsSI "http://127.0.0.1:18787/api/themes/$THEME/theme.css" | grep -qi 'content-type: text/css' || fail theme-css
[ "$(curl -fsS "http://127.0.0.1:18787/api/themes/$THEME/download" | head -c 14)" = "/* @page-theme" ] || fail theme-download
FONT="$( { printf 'wOF2'; head -c 60 /dev/zero; } | curl -fsS -X POST -H 'content-type: application/octet-stream' --data-binary @- 'http://127.0.0.1:18787/api/fonts?family=smoke' | grep -o '[0-9a-f]\{32\}' | head -1)" || fail font-upload
curl -fsS http://127.0.0.1:18787/api/fonts.css | grep -q '"smoke"' || fail fonts-css
curl -fsSI "http://127.0.0.1:18787/api/fonts/$FONT" | grep -qi 'content-type: font/woff2' || fail font-get
curl -fsS -X DELETE "http://127.0.0.1:18787/api/themes/$THEME" -o /dev/null || fail theme-delete
curl -fsS -X DELETE "http://127.0.0.1:18787/api/fonts/$FONT" -o /dev/null || fail font-delete
# 채팅 가져오기: 캐릭터 만들기 → 합성 RisuAI 채팅 JSON 올리기 → 서고에 1개 → 캐릭터 완전히 지우기 → 목록 비어 있음
curl -fsS http://127.0.0.1:18787/api/sources | grep -q '"id":"imported"' || fail import-source
ICHAR="$(curl -fsS -X POST -H 'content-type: application/json' -d '{"name":"smoke import"}' http://127.0.0.1:18787/api/import/chars | grep -o '[0-9a-f]\{32\}' | head -1)" || fail import-char
[ -n "$ICHAR" ] || fail import-char-id
printf '%s' '{"type":"risuChat","ver":2,"data":{"id":"smoke1","name":"smoke","lastDate":1,"message":[{"role":"user","data":"hi"},{"role":"char","data":"hello"}]}}' \
  | curl -fsS -X POST -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:18787/api/import/chars/$ICHAR/chats" | grep -q '"status":"new"' || fail import-upload
[ "$(curl -fsS "http://127.0.0.1:18787/api/chats?source=imported&char=$ICHAR" | grep -o '"chatId"' | wc -l)" -eq 1 ] || fail import-chats
curl -fsS -X DELETE "http://127.0.0.1:18787/api/import/chars/$ICHAR" -o /dev/null || fail import-delete
curl -fsS http://127.0.0.1:18787/api/import/chars | grep -q '"chars":\[\]' || fail import-empty
curl -fsSI http://127.0.0.1:18787/ | grep -qi "content-security-policy: default-src 'self'" || fail csp
curl -fsS http://127.0.0.1:18787/ | grep -q '<div id="app">' || fail spa
ASSET="$(curl -fsS http://127.0.0.1:18787/ | grep -o '/assets/[^"]*\.js' | head -1)"
curl -fsSI "http://127.0.0.1:18787$ASSET" | grep -qi 'immutable' || fail asset-cache
docker exec "$NAME" sh -c 'touch /sources/main/x' 2>/dev/null && fail source-writable
docker exec "$NAME" sh -c 'touch /app/x' 2>/dev/null && fail rootfs-writable
[ "$(docker exec "$NAME" id -u)" != "0" ] || fail runs-as-root
echo "SMOKE OK"
