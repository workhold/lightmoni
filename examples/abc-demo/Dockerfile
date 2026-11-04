FROM node:24.15.0-bookworm-slim AS sdk
WORKDIR /build/sdk
COPY sdk/typescript/package.json sdk/typescript/package-lock.json ./
RUN npm ci
COPY sdk/typescript/src ./src
COPY sdk/typescript/test ./test
COPY sdk/typescript/tsconfig.json ./
RUN npm run build

FROM node:24.15.0-bookworm-slim
ARG BUILD_REVISION=development
ENV NODE_ENV=production PORT=8080 APP_VERSION=1.0.0
LABEL org.opencontainers.image.title="LightMoni ABC demo" org.opencontainers.image.revision=${BUILD_REVISION}
WORKDIR /app
COPY --chown=65532:65532 examples/abc-demo/server.mjs examples/abc-demo/index.html examples/abc-demo/app.js examples/abc-demo/style.css ./
COPY --from=sdk --chown=65532:65532 /build/sdk/dist/src ./sdk
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD ["node","--input-type=module","-e","const r=await fetch('http://127.0.0.1:8080/healthz');if(!r.ok)process.exit(1)"]
CMD ["node","server.mjs"]
