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

# Runtime dependencies only. The previous final stage copied the builder's whole
# `node_modules`, which shipped typescript, vitest, nodemon, supertest and every
# @types package into a container that handles clinical data. Prisma CLI is
# re-added explicitly because the entrypoint runs `migrate deploy` at boot.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save prisma@6.2.1 && npm cache clean --force

FROM node:22-alpine AS runner
WORKDIR /app
# Cron windows, room-open windows and "today" horizons are authored in WIB —
# pin the container clock to Asia/Jakarta (tzdata needed for named zones).
RUN apk add --no-cache tzdata \
    && addgroup -S nodejs \
    && adduser -S api -G nodejs
ENV NODE_ENV=production
ENV TZ=Asia/Jakarta
COPY --from=prod-deps --chown=api:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=api:nodejs /app/dist ./dist
COPY --from=builder --chown=api:nodejs /app/prisma ./prisma
COPY --from=builder --chown=api:nodejs /app/package.json ./package.json
COPY --from=builder --chown=api:nodejs /app/scripts/start.sh ./scripts/start.sh
# `public/uploads` is a volume mount in compose; create it owned by the runtime
# user so the process can write there.
RUN mkdir -p public/uploads && chown -R api:nodejs public scripts && chmod +x scripts/start.sh

# The other two images in this repo already drop privileges. Running the API as
# root means any RCE through the multipart upload path, the HTML sanitiser or the
# Swagger mount yields root in the container.
USER api

EXPOSE 5000
CMD ["sh", "scripts/start.sh"]
