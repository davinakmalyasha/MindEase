# MindEase realtime (Go) — multi-stage build
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /realtime .

FROM alpine:3.20
# ca-certificates is not optional. main.go enables TLS for a `rediss://` URL or
# an explicit `?tls=true`, which is what a managed Redis hands out, and go-redis
# verifies the server certificate against the system root store. On a bare
# alpine image that store does not exist, so verification fails against a
# perfectly valid certificate and the service exits at boot on a ping.
RUN apk add --no-cache ca-certificates \
    && adduser -D -H realtime
COPY --from=builder /realtime /usr/local/bin/realtime
USER realtime
EXPOSE 8080
CMD ["realtime"]
