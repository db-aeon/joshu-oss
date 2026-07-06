# Joshu sandbox stack image (VPS / self-host)
# Hermes / Camofox pins: deploy/RELEASE.json — run `npm run vps:sync-hermes-pin` / `vps:sync-camofox-pin`.
# Build: npm run vps:predeploy && npm run vps:build-image (or JOSHU_IMAGE_PUSH=1 JOSHU_IMAGE_TAG=0.1.4 …)

ARG CAMOFOX_BASE=ghcr.io/jo-inc/camofox-browser@sha256:3ab61b4742105922aab6f8c99460f55563b6f93e906975383ddce16ec8917f3f
FROM ${CAMOFOX_BASE} AS builder

ARG HERMES_AGENT_REPO=https://github.com/NousResearch/hermes-agent.git
# v2026.5.16 → Hermes Agent v0.14.0 (synced from deploy/RELEASE.json)
ARG HERMES_AGENT_REF=a91a57fa5a13d516c38b07a141a9ce8a3daabeb0
ARG GO_VERSION=1.24.1
ARG PGVECTOR_REPO=https://github.com/pgvector/pgvector.git
ARG PGVECTOR_REF=v0.8.1
ARG POSTGRES_VERSION=15

ENV APP_DIR=/opt/joshu \
    HERMES_DIR=/opt/hermes-agent \
    AROZ_TEMPLATE=/opt/arozos-template \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl git postgresql-server-dev-${POSTGRES_VERSION} python3-venv rsync \
    && rm -rf /var/lib/apt/lists/*

# Go for ArozOS build
RUN rm -rf /usr/local/go \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz \
    && ln -sf /usr/local/go/bin/go /usr/local/bin/go

# Hermes venv (image build extras)
RUN git init "${HERMES_DIR}" \
    && cd "${HERMES_DIR}" \
    && git remote add origin "${HERMES_AGENT_REPO}" \
    && git fetch --depth 1 origin "${HERMES_AGENT_REF}" \
    && git checkout --detach FETCH_HEAD \
    && python3 -m venv venv \
    && venv/bin/pip install --upgrade pip setuptools wheel \
    && venv/bin/pip install --no-cache-dir -e '.[cli,pty,mcp,acp,google,bedrock,web,youtube,voice,messaging]' 'aiohttp>=3.13.3,<4' \
    && venv/bin/pip install --no-cache-dir 'hindsight-api-slim[embedded-db]==0.7.2' 'hindsight-client==0.7.2' langfuse \
    && cd web \
    && npm install --include=dev \
    && npm run build \
    && rm -rf node_modules /root/.npm

COPY scripts/hermes-langfuse-system-prompt.patch scripts/hermes-langfuse-user-id.patch scripts/hermes-langfuse-openrouter-cost.patch scripts/hermes-openrouter-usage-include.patch scripts/hermes-content-filter.patch scripts/apply-hermes-langfuse-patches.sh scripts/apply-hermes-kanban-ws-base-path-patch.sh scripts/apply-hermes-content-filter-patch.sh /tmp/joshu-hermes-patches/
RUN HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-langfuse-patches.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-kanban-ws-base-path-patch.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-content-filter-patch.sh \
    && rm -rf "${HERMES_DIR}/.git" /root/.cache/pip /tmp/joshu-hermes-patches

# Hindsight uses local PostgreSQL on VPS. Build pgvector with portable flags so
# the extension does not depend on the builder CPU's native instruction set.
RUN set -eux; \
    PG_CONFIG="/usr/lib/postgresql/${POSTGRES_VERSION}/bin/pg_config"; \
    rm -rf /tmp/pgvector; \
    for attempt in 1 2 3 4 5; do \
      git clone --depth 1 --branch "${PGVECTOR_REF}" "${PGVECTOR_REPO}" /tmp/pgvector && break; \
      rm -rf /tmp/pgvector; sleep $((attempt * 5)); \
    done; \
    test -d /tmp/pgvector/.git; \
    cd /tmp/pgvector; \
    make PG_CONFIG="${PG_CONFIG}" OPTFLAGS=""; \
    make install PG_CONFIG="${PG_CONFIG}" OPTFLAGS=""; \
    ldd "/usr/lib/postgresql/${POSTGRES_VERSION}/lib/vector.so"; \
    rm -rf /tmp/pgvector

ENV HERMES_BIN=${HERMES_DIR}/venv/bin/hermes \
    HERMES_AGENT_REF=${HERMES_AGENT_REF}

# Build the ArozOS template in the builder stage so Go and source do not land in
# the runtime image.
WORKDIR ${APP_DIR}
COPY dist ./dist
COPY arozos/subservice ./arozos-subservice-staging
COPY arozos/icons ./arozos/icons
COPY arozos/web-overlays-vanilla ./arozos/web-overlays-vanilla
COPY arozos/system-setting ./arozos/system-setting
COPY arozos/locale ./arozos/locale
COPY scripts ./scripts
COPY proprietary ./proprietary
COPY patches/arozos ./patches/arozos
COPY vendor/arozos ./vendor/arozos

RUN bash ${APP_DIR}/scripts/apply-arozos-patches.sh \
    && cd ${APP_DIR}/vendor/arozos/src \
    && go mod download \
    && go build -o ${AROZ_TEMPLATE}/arozos . \
    && mkdir -p ${AROZ_TEMPLATE}/web ${AROZ_TEMPLATE}/system ${AROZ_TEMPLATE}/subservice \
    && rsync -a web/ ${AROZ_TEMPLATE}/web/ \
    && rsync -a system/ ${AROZ_TEMPLATE}/system/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/joshu/ ${AROZ_TEMPLATE}/subservice/joshu/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/excalidraw/ ${AROZ_TEMPLATE}/subservice/excalidraw/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/hermes-chat/ ${AROZ_TEMPLATE}/subservice/hermes-chat/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/hindsight-viewer/ ${AROZ_TEMPLATE}/subservice/hindsight-viewer/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/file-brain-viewer/ ${AROZ_TEMPLATE}/subservice/file-brain-viewer/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/schedules/ ${AROZ_TEMPLATE}/subservice/schedules/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/jmovie/ ${AROZ_TEMPLATE}/subservice/jmovie/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/jmail/ ${AROZ_TEMPLATE}/subservice/jmail/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/connectors/ ${AROZ_TEMPLATE}/subservice/connectors/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/safety-settings/ ${AROZ_TEMPLATE}/subservice/safety-settings/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/welcome/ ${AROZ_TEMPLATE}/subservice/welcome/ \
    && rsync -a ${APP_DIR}/dist/excalidraw/ ${AROZ_TEMPLATE}/subservice/excalidraw/app/ \
    && rsync -a ${APP_DIR}/dist/hermes-chat/ ${AROZ_TEMPLATE}/subservice/hermes-chat/app/ \
    && rsync -a ${APP_DIR}/dist/hindsight-viewer/ ${AROZ_TEMPLATE}/subservice/hindsight-viewer/app/ \
    && rsync -a ${APP_DIR}/dist/file-brain-viewer/ ${AROZ_TEMPLATE}/subservice/file-brain-viewer/app/ \
    && rsync -a ${APP_DIR}/dist/schedules/ ${AROZ_TEMPLATE}/subservice/schedules/app/ \
    && rsync -a ${APP_DIR}/dist/movie-editor/ ${AROZ_TEMPLATE}/subservice/jmovie/app/ \
    && rsync -a ${APP_DIR}/dist/jmail/ ${AROZ_TEMPLATE}/subservice/jmail/app/ \
    && rsync -a ${APP_DIR}/dist/connectors-app/ ${AROZ_TEMPLATE}/subservice/connectors/app/ \
    && rsync -a ${APP_DIR}/dist/safety-settings/ ${AROZ_TEMPLATE}/subservice/safety-settings/app/ \
    && rsync -a ${APP_DIR}/dist/welcome/ ${AROZ_TEMPLATE}/subservice/welcome/app/ \
    && bash ${APP_DIR}/scripts/install-proprietary-apps.sh ${AROZ_TEMPLATE}/subservice \
    && chmod +x ${AROZ_TEMPLATE}/subservice/*/start.sh \
    && (python3 ${APP_DIR}/scripts/apply_arozos_joshu_theme.py ${AROZ_TEMPLATE}/web || true)

FROM ${CAMOFOX_BASE} AS runtime

ARG HERMES_AGENT_REF=a91a57fa5a13d516c38b07a141a9ce8a3daabeb0
ARG GBRAIN_REF=fa2c7a6990a7a57b251979ef6e1988ff09529021

ENV APP_DIR=/opt/joshu \
    HERMES_DIR=/opt/hermes-agent \
    AROZ_TEMPLATE=/opt/arozos-template \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl ffmpeg git libopus0 libportaudio2 openssh-client patch poppler-utils postgresql-15 procps python3 python3-pip ripgrep rsync unzip util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir --break-system-packages pypdf \
    && curl -fsSL https://bun.sh/install | bash \
    && /root/.bun/bin/bun install -g "github:garrytan/gbrain#${GBRAIN_REF}" \
    && ln -sf /root/.bun/bin/gbrain /usr/local/bin/gbrain

COPY --from=builder /opt/hermes-agent /opt/hermes-agent
COPY --from=builder /opt/arozos-template /opt/arozos-template
COPY --from=builder /usr/lib/postgresql/15/lib/vector.so /usr/lib/postgresql/15/lib/vector.so
COPY --from=builder /usr/share/postgresql/15/extension/vector* /usr/share/postgresql/15/extension/

WORKDIR ${APP_DIR}
COPY deploy/runtime/package.json deploy/runtime/package-lock.json ./
COPY patches ./patches
COPY dist ./dist
COPY public ./public
COPY integrations ./integrations
COPY .hermes ./.hermes
COPY templates ./templates
COPY factory ./factory
COPY packages/app-sdk/package.json ./packages/app-sdk/
COPY packages/app-sdk/dist ./packages/app-sdk/dist/
COPY packages/box-state/package.json ./packages/box-state/
COPY packages/box-state/dist ./packages/box-state/dist/
COPY packages/email-signature/package.json ./packages/email-signature/
COPY packages/email-signature/dist ./packages/email-signature/dist/
COPY arozos/icons ./arozos/icons
COPY arozos/web-overlays-vanilla ./arozos/web-overlays-vanilla
COPY arozos/system-setting ./arozos/system-setting
COPY arozos/locale ./arozos/locale
COPY scripts ./scripts
COPY deploy/scripts/vps-start.sh ${APP_DIR}/scripts/vps-start.sh
COPY deploy/RELEASE.json ${APP_DIR}/RELEASE.json

RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && (patch --batch --forward -p1 -i patches/http-proxy+1.18.1.patch || true) \
    && node scripts/patch-camofox-single-tab.mjs /app/server.js \
    && chmod +x ${APP_DIR}/scripts/vps-start.sh \
    && chmod +x ${APP_DIR}/scripts/bootstrap-joshu-files.sh \
    && chmod +x ${APP_DIR}/scripts/bootstrap-executive-assistant.sh \
    && chmod +x ${APP_DIR}/scripts/install-gbrain.sh \
    && chmod +x ${APP_DIR}/scripts/start-gbrain.sh \
    && chmod +x ${APP_DIR}/scripts/setup-gbrain-schema.sh \
    && chmod +x ${APP_DIR}/scripts/gbrain-mcp-readonly-proxy.mjs \
    && chmod +x ${APP_DIR}/scripts/gbrain-mcp-http-server.mjs \
    && chmod +x ${APP_DIR}/scripts/start-gbrain-mcp-http.sh \
    && chmod +x ${APP_DIR}/scripts/joshu-connectors-mcp-http-server.mjs \
    && chmod +x ${APP_DIR}/scripts/start-joshu-connectors-mcp.sh \
    && chmod +x ${APP_DIR}/scripts/start-hermes-dashboard.sh \
    && chmod +x ${APP_DIR}/scripts/stop-gbrain.sh \
    && chmod +x ${APP_DIR}/scripts/rebind-gbrain-owner.sh \
    && chmod +x ${APP_DIR}/scripts/joshu-box-factory-apply.sh \
    && chmod +x ${APP_DIR}/scripts/ensure-hermes-gbrain-mcp.mjs \
    && npm cache clean --force \
    && rm -rf /root/.cache/pip /tmp/* ${APP_DIR}/patches \
    && test -f /root/.cache/camoufox/version.json \
    || (echo "ERROR: Camoufox browser cache missing after image build; /app postinstall cache was wiped" >&2; exit 1) \
    && test -f node_modules/@joshu/app-sdk/dist/index.js \
    || (echo "ERROR: @joshu/app-sdk dist missing after npm ci" >&2; exit 1) \
    && test -f node_modules/@joshu/box-state/dist/index.js \
    || (echo "ERROR: @joshu/box-state dist missing after npm ci" >&2; exit 1) \
    && test -f node_modules/@joshu/email-signature/dist/index.js \
    || (echo "ERROR: @joshu/email-signature dist missing after npm ci" >&2; exit 1)

RUN id -u hindsight >/dev/null 2>&1 || useradd --create-home --home-dir /home/hindsight --shell /usr/sbin/nologin hindsight

ENV PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PUBLIC_BASE_PATH=/joshu \
    PORT=8788 \
    HOST=127.0.0.1 \
    PUBLIC_AROZ_PORT=8787 \
    AROZ_DATA=/var/lib/arozos \
    HINDSIGHT_POSTGRES_DATA_DIR=/var/lib/postgresql/hindsight/data \
    HERMES_BIN=${HERMES_DIR}/venv/bin/hermes \
    HERMES_AGENT_REF=${HERMES_AGENT_REF} \
    ENABLE_VNC=1 \
    NOVNC_URL=/novnc \
    NOVNC_PROXY_TARGET=http://127.0.0.1:6080 \
    NOVNC_CLIENT_PATH=/novnc

EXPOSE 8787 8788

CMD ["bash", "/opt/joshu/scripts/vps-start.sh"]
