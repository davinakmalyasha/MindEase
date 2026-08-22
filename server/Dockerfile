# MindEase API — multi-stage build
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npx tsc --outDir dist

FROM node:22-alpine AS runner
WORKDIR /app
# Cron windows, room-open windows and "today" horizons are authored in WIB —
# pin the container clock to Asia/Jakarta (tzdata needed for named zones).
RUN apk add --no-cache tzdata
ENV NODE_ENV=production
ENV TZ=Asia/Jakarta
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts/start.sh ./scripts/start.sh
RUN mkdir -p public/uploads && chmod +x scripts/start.sh

EXPOSE 5000
CMD ["sh", "scripts/start.sh"]
