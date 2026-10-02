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
# @types package into a container that handles clinical data.
#
# The schema is copied *before* installing. `@prisma/client` has a postinstall that
# generates the client, but with no `schema.prisma` present it cannot, and it does
# not fail loudly - it just leaves the package uninitialised. The runner stage then
# throws on the first import:
#
#     Error: @prisma/client did not initialize yet. Please run "prisma generate"
#
# which reached CI as the whole stack reporting `mindease-api is unhealthy`, naming a
# symptom and nothing about the cause. Generating explicitly here makes it
# deterministic instead of dependent on whether npm is configured to allow install
# scripts - which it was not, locally, where @prisma/client's postinstall is blocked.
#
# `prisma` is a real dependency, not a dev one: `scripts/start.sh` runs
# `npx prisma migrate deploy` before every boot. It was a devDependency re-added by
# `npm install --no-save prisma@6.2.1`, a hardcoded third version that had drifted
# from `@prisma/client` (6.2.1 against 6.19.3). Resolving both from one lockfile
# means the CLI and the generated client cannot disagree.
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
    && npx prisma generate \
    && npm cache clean --force
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
