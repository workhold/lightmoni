FROM node:24.15.0-bookworm-slim
ARG BUILD_REVISION=development
ENV NODE_ENV=production PORT=8080 APP_VERSION=1.0.0
LABEL org.opencontainers.image.title="LightMoni ABC demo" org.opencontainers.image.revision=${BUILD_REVISION}
WORKDIR /app
COPY --chown=65532:65532 server.mjs index.html app.js style.css ./
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s CMD ["node","--input-type=module","-e","const r=await fetch('http://127.0.0.1:8080/healthz');if(!r.ok)process.exit(1)"]
CMD ["node","server.mjs"]
