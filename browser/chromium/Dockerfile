# Shared HITL browser: headed Chromium on Xvfb and CDP. The live view is the CDP screencast.
# Decodo (PROXY_*) is applied via a local auth-inject proxy (see localProxy.mjs).
# Node comes from the official tarball so we do not pull Debian's npm
# metapackage (hundreds of extra packages).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    NODE_VERSION=22.23.4

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fonts-liberation \
    fonts-noto-color-emoji \
    xvfb \
    xz-utils \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         arm64) node_arch=arm64 ;; \
         amd64) node_arch=x64 ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
         | tar -xJ -C /usr/local --strip-components=1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/browser
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY supervisor.mjs localProxy.mjs entrypoint.sh ./
RUN chmod +x /opt/browser/entrypoint.sh

EXPOSE 9222 9377
ENTRYPOINT ["/opt/browser/entrypoint.sh"]
