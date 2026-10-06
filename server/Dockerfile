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
# scripts - which it is not: locally, @prisma/client's postinstall is blocked outright.
#
# The Prisma CLI is needed only because `scripts/start.sh` runs
# `npx prisma migrate deploy` before every boot. Pinned to 6.12.0 rather than tracking
# `@prisma/client`: from 6.13 the CLI pulls `@prisma/config` -> `deepmerge-ts`, which
# carries a stack-exhaustion advisory and fails `npm audit --audit-level=high` in the
# published image. The advisory sits in the CLI's config loader, which the running
# server never imports - but it is still shipped, and the CLI and client are
# compatible within a major, so the older CLI is the better trade. Keep this in step
# with `prisma` in package.json.
FROM node:22-alpine AS prod-deps
ARG PRISMA_CLI_VERSION=6.12.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `--omit=dev` has to be on *both* commands.
#
# The second one was the bug. `npm install --no-save prisma@x` re-resolves the
# whole tree, and without `--omit=dev` it puts the devDependencies back - so the
# stage that exists to assemble production-only dependencies shipped eslint,
# nodemon and their transitive `brace-expansion`, which Trivy then reported as 10
# HIGH CVEs in the runtime image. Every one of them was in a build-time linter
# that never runs in production.
#
# The symptom is worse than a large image: the findings are real and unfixable
# without the fix above, because no amount of `npm audit fix` reaches a
# transitive dev dependency that should not be there.
RUN npm ci --omit=dev \
    && npm install --no-save --omit=dev prisma@${PRISMA_CLI_VERSION} \
    && npx prisma generate \
    && npm cache clean --force \
    # Assert the tree really is production-only. A CVE scanner is a late and
    # indirect way to learn this; the check belongs where it can be read, and it
    # costs nothing. `eslint` and `nodemon` are named because they are the two
    # this project actually has, so a change to either one is caught here rather
    # than as an unexplained HIGH finding three weeks later.
    && if [ -d node_modules/eslint ] || [ -d node_modules/nodemon ] \
         || [ -d node_modules/typescript-eslint ]; then \
         echo "devDependencies present in the production image; check --omit=dev above" >&2; \
         ls node_modules | head -50 >&2; \
         exit 1; \
       fi

FROM node:22-alpine AS runner
WORKDIR /app
# Cron windows, room-open windows and "today" horizons are authored in WIB —
# pin the container clock to Asia/Jakarta (tzdata needed for named zones).
RUN apk add --no-cache tzdata \
    && addgroup -S nodejs \
    && adduser -S api -G nodejs \
    # npm itself ships inside the base image, and it bundles `pacote`,
    # `sigstore`, `ip-address` and `brace-expansion`. Those are not this
    # project's dependencies and `npm audit fix` cannot reach them, because they
    # are vendored inside the npm CLI. Trivy correctly reports them as HIGH
    # vulnerabilities in the image, and the fix is to replace npm.
    #
    # The API container does invoke npm-adjacent tooling at boot -
    # `prisma migrate deploy` - so this is not entirely ceremonial, and pinning
    # a major is better than `latest` because `npm@12` may not exist yet and a
    # floating major makes the image non-reproducible.
    && npm install -g npm@11 \
    && npm cache clean --force
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
