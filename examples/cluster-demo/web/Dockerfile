FROM node:24.15.0-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.mjs ./
USER node
EXPOSE 8080 9090
CMD ["node", "server.mjs"]
