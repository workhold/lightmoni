FROM node:24.15.0-alpine AS web
WORKDIR /work/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# The reporting settings UI shares the SDK sampling model.
COPY sdk/typescript/src/ /work/sdk/typescript/src/
RUN npm run build
WORKDIR /work/sdk/typescript
COPY sdk/typescript/package*.json ./
RUN npm ci
COPY sdk/typescript/ ./
RUN npm run build && mkdir -p /work/internal/server/agent-dist && npm pack --pack-destination /work/internal/server/agent-dist
FROM node:24.15.0-alpine AS ai
WORKDIR /opt/lightmoni-ai
COPY ai-runtime/package*.json ./
RUN npm ci
COPY ai-runtime/tsconfig.json ./
COPY ai-runtime/src ./src
RUN npm run build && npm prune --omit=dev

FROM golang:1.26.3-alpine AS go
WORKDIR /work
COPY go.mod go.sum ./
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=$GOPROXY
RUN --mount=type=cache,target=/go/pkg/mod GOPROXY="$GOPROXY" go mod download
COPY . ./
COPY --from=web /work/internal/server/dist ./internal/server/dist
COPY --from=web /work/internal/server/agent-dist/ ./internal/server/agent-dist/
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build sh deploy/agent/release.sh 0.1.0 internal/server/agent-dist && sh scripts/build-go-sdk.sh 0.1.0 internal/server/agent-dist && sh scripts/build-native-sdks.sh 0.1.0 internal/server/agent-dist && CGO_ENABLED=0 go build -trimpath -o /lightmoni ./cmd/lightmoni
FROM node:24.15.0-alpine
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 lightmoni && mkdir -p /data && chown lightmoni:lightmoni /data
COPY --from=go /lightmoni /usr/local/bin/lightmoni
COPY --from=ai /opt/lightmoni-ai/package.json /opt/lightmoni-ai/package.json
COPY --from=ai /opt/lightmoni-ai/node_modules /opt/lightmoni-ai/node_modules
COPY --from=ai /opt/lightmoni-ai/dist /opt/lightmoni-ai/dist
ENV LIGHTMONI_ADDR=:8080 LIGHTMONI_DATA=/data/state LIGHTMONI_AI_RUNNER=/opt/lightmoni-ai/dist/runner.js
USER lightmoni
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/lightmoni"]
