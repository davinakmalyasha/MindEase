# MindEase API (Go) - multi-stage build.
FROM golang:1.27.2-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/api ./cmd/api \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 GOOS=linux go build -trimpath -o /out/seed ./cmd/seed

FROM alpine:3.24
# ca-certificates is not optional: every outbound TLS call (Google's tokeninfo
# endpoint, LiveKit, an S3-compatible store, a `rediss://` URL) verifies against
# the system store, which a bare alpine image does not have. tzdata carries the
# named zones the job scheduler and the date helpers load; the binary also
# embeds `time/tzdata`, so this is belt and braces for anything reading TZ.
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -H api
WORKDIR /app
# Three small binaries: the server, the one-shot migration runner and the seed.
COPY --from=builder /out/ /usr/local/bin/
# `public/uploads` is the default UPLOAD_DIR with this WORKDIR, and compose
# mounts its named volume exactly here. Created and owned by the runtime user
# so the upload routes can write to it.
RUN mkdir -p public/uploads && chown -R api:api /app
USER api
EXPOSE 5000
CMD ["api"]
