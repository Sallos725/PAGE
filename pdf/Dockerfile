# page-pdf — 내부 전용 PDF 렌더 사이드카 (스펙 2.5c P1·P4). 호스트 포트 없음.
FROM node:24.21.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium-headless-shell fonts-noto-color-emoji fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
# CHROMIUM_PATH: /usr/bin/chromium-headless-shell 은 sh 래퍼(exec 안 함)라 실제 바이너리를 직접 가리킨다.
# HOME=/tmp: 읽기 전용 루트에서 chromium(crashpad)이 쓸 수 있는 홈이 필요하다 (/tmp 는 tmpfs).
ENV NODE_ENV=production PORT=8790 HOME=/tmp CHROMIUM_PATH=/usr/lib/chromium/chromium-headless-shell PDF_FONTS_DIR=/app/fonts
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY fonts fonts
USER node
EXPOSE 8790
CMD ["node", "src/server.mjs"]
