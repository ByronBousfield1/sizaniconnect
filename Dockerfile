# Portable build of the whole solution (NFR-19): runs on any container host against any PostgreSQL 16.
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /api
COPY api/package*.json ./
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=api /api/dist ./dist
COPY --from=api /api/node_modules ./node_modules
COPY --from=api /api/migrations ./migrations
COPY --from=api /api/package.json ./
COPY --from=web /web/dist ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8080/api/v1/health || exit 1
CMD ["node", "dist/server.js"]
