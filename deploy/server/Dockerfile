FROM node:24.15.0-bookworm AS build
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NODE_DIST_URL=https://nodejs.org/dist
ARG BUILD_REVISION
ENV npm_config_registry=${NPM_REGISTRY} npm_config_audit=false npm_config_fund=false npm_config_nodedir=/usr/local LIGHTMONI_NODE_DIST_URL=${NODE_DIST_URL} LIGHTMONI_BUILD_REVISION=${BUILD_REVISION}
WORKDIR /work
COPY sdk/typescript/package*.json ./sdk/typescript/
RUN npm --prefix sdk/typescript ci
COPY sdk/typescript/ ./sdk/typescript/
RUN npm --prefix sdk/typescript run build
COPY runtime/package*.json ./runtime/
RUN npm --prefix runtime ci
COPY ai-runtime/package*.json ./ai-runtime/
RUN npm --prefix ai-runtime ci
COPY web/package*.json ./web/
RUN npm --prefix web ci
COPY . ./
RUN npm --prefix runtime run build && npm --prefix ai-runtime run build && npm --prefix web run build
RUN node scripts/build-agent-release.mjs 0.1.0 runtime/downloads
RUN cd sdk/typescript && npm pack --pack-destination /work/runtime/downloads
RUN sh scripts/build-go-sdk.sh 0.1.0 runtime/downloads && sh scripts/build-native-sdks.sh 0.1.0 runtime/downloads && npm --prefix runtime prune --omit=dev && npm --prefix ai-runtime prune --omit=dev

FROM node:24.15.0-bookworm-slim
ARG DEBIAN_MIRROR=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_MIRROR=http://deb.debian.org/debian-security
ARG BUILD_REVISION=unknown
RUN sed -i -e "s|^URIs: http://deb[.]debian[.]org/debian$|URIs: ${DEBIAN_MIRROR}|" -e "s|^URIs: http://deb[.]debian[.]org/debian-security$|URIs: ${DEBIAN_SECURITY_MIRROR}|" /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata wget openssh-client && rm -rf /var/lib/apt/lists/* && groupadd --gid 10001 lightmoni && useradd --uid 10001 --gid lightmoni --no-create-home lightmoni && mkdir -p /data && chown lightmoni:lightmoni /data
LABEL org.opencontainers.image.revision=${BUILD_REVISION}
WORKDIR /opt/lightmoni
COPY --from=build /work/runtime/ ./runtime/
COPY --from=build /work/sdk/typescript/package.json ./sdk/typescript/package.json
COPY --from=build /work/sdk/typescript/dist/ ./sdk/typescript/dist/
COPY --from=build /work/ai-runtime/package.json ./ai-runtime/package.json
COPY --from=build /work/ai-runtime/node_modules/ ./ai-runtime/node_modules/
COPY --from=build /work/ai-runtime/dist/ ./ai-runtime/dist/
COPY --chmod=755 deploy/server/admin.sh /usr/local/bin/lightmoni-admin
ENV LIGHTMONI_ADDR=:8080 LIGHTMONI_DATA=/data/state LIGHTMONI_AI_RUNNER=/opt/lightmoni/ai-runtime/dist/runner.js
USER lightmoni
WORKDIR /data
EXPOSE 8080
ENTRYPOINT ["node", "/opt/lightmoni/runtime/dist/server/main.js"]
