# PAGE — 읽기 전용 사이드카 (스펙 D1·D11·D13). 빌드 스테이지에서 server/web 을 빌드하고,
# 런타임에는 server 의 prod 의존성 + dist + vendor + web/dist 만 둔다. 비루트(node, uid 1000).
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY server server
COPY web web
RUN cd server && npm run build && npm prune --omit=dev
RUN cd web && npm run build

FROM node:24.21.0-bookworm-slim
ENV NODE_ENV=production \
    PAGE_DATA_DIR=/data \
    PAGE_BIND=0.0.0.0 \
    PAGE_PORT=8787 \
    PAGE_WEB_DIR=/app/web/dist \
    NODE_OPTIONS="--no-warnings --max-old-space-size=4096"
WORKDIR /app
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/vendor server/vendor
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8787
CMD ["node", "server/dist/index.js"]
