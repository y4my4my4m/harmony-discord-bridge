# Harmony ↔ Discord bridge
# ghcr.io/y4my4my4m/harmony-discord-bridge

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    HEALTH_PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# /data: credentials.json and permission-sync state. /app/config + /app/data:
# legacy bridge-config.yml layout. Named volumes inherit the node owner.
RUN mkdir -p /data /app/config /app/data && chown node:node /data /app/data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
