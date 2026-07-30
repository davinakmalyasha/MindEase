# MindEase realtime (Go) — multi-stage build
FROM golang:1.26-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /realtime .

FROM alpine:3.20
RUN adduser -D -H realtime
COPY --from=builder /realtime /usr/local/bin/realtime
USER realtime
EXPOSE 8080
CMD ["realtime"]
