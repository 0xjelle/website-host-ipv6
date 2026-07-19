FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git wireguard-tools bird2 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY . .

ENV DATA_DIR=/data
VOLUME /data

# 3000 dashboard · 8080 edge proxy · 51820/udp WireGuard
EXPOSE 3000 8080 51820/udp

RUN chmod +x scripts/docker-entrypoint.sh
CMD ["./scripts/docker-entrypoint.sh"]
