# Multi-stage build for Harmony Discord Bridge

# Stage 1: Build
FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

# Stage 2: Production
FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist

# Config + runtime state are mounted at runtime
VOLUME ["/app/config", "/app/data"]

CMD ["node", "dist/index.js"]
