# Joshu sandbox stack image (VPS / self-host)
# Hermes pin: deploy/RELEASE.json — run `npm run vps:sync-hermes-pin`.
# Build: npm run vps:predeploy && npm run vps:build-image (or JOSHU_IMAGE_PUSH=1 JOSHU_IMAGE_TAG=0.1.4 …)

# Debian 13 (trixie), the same release as the sandbox image before change remove-camofox.
ARG BASE_IMAGE=debian:trixie-slim

FROM ${BASE_IMAGE} AS builder

ARG HERMES_AGENT_REPO=https://github.com/NousResearch/hermes-agent.git
# v2026.8.3 → Hermes Agent v0.20.0 (synced from deploy/RELEASE.json)
ARG HERMES_AGENT_REF=3c27eb6234bf91b8ceee9e9071591b31e9b148cb
ARG GO_VERSION=1.24.1
ARG PGVECTOR_REPO=https://github.com/pgvector/pgvector.git
ARG PGVECTOR_REF=v0.8.1
ARG POSTGRES_VERSION=17

ENV APP_DIR=/opt/joshu \
    HERMES_DIR=/opt/hermes-agent \
    AROZ_TEMPLATE=/opt/arozos-template \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash build-essential ca-certificates curl git postgresql-server-dev-${POSTGRES_VERSION} python3-venv rsync \
    && rm -rf /var/lib/apt/lists/*

# Hermes web (v0.20+) requires Node >=22.22. Install via NodeSource — copying node_modules
# from node:22-bookworm-slim breaks npm (minipass-fetch "Class extends value undefined").
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
    && node -v | grep -E '^v22\.' \
    && npm -v

# Go for ArozOS build
RUN rm -rf /usr/local/go \
    && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz \
    && ln -sf /usr/local/go/bin/go /usr/local/bin/go

# Hermes venv (image build extras)
# Extra installs are constrained to Hermes' own mcp/starlette pins: hindsight pulls
# claude-agent-sdk, which otherwise upgrades mcp to 2.x. mcp 2.x drops
# streamablehttp_client, and Hermes then silently disables every HTTP MCP server
# (joshu_connectors email/SMS tools, composio, gbrain). The import check fails the
# build instead of shipping that regression.
# Security overrides of exact Hermes pins: Pillow 13.0.0 fixes 39 advisories of
# 2026-10 in the image decoders (the companion opens images that anyone can send it),
# and PyJWT 2.15.1 fixes GHSA-pxh4-856f-4h89 and older ones. Drop each override when
# the Hermes pin reaches it (Hermes v0.22.5 has Pillow 13).
# cryptography: Hermes pins 48.0.1, and hindsight-api-slim 0.7.2 asks for <47 and
# downgrades it, so the image installs it again. 50.0.2 fixes GHSA-g6cj-pr64-35w5 and
# GHSA-jwv3-5hgf-82ww. Hindsight does not import cryptography, and Hindsight 1.1.0
# asks for >=50.
# More overrides of exact Hermes pins (security bulletins log of 2026-10-24): mcp 1.30.0
# (GHSA-84m7-p3x7-pcfv, Hermes pins 1.28.1; it is installed before the pins are frozen,
# so Hindsight is constrained to it), brotlicffi 1.2.1.0 (GHSA-9v8h-qqgm-4m35, a
# critical write out of bounds in the Brotli decoder, Hermes pins 1.2.0.1), PyNaCl
# 1.6.2 (discord.py 2.7.1 caps it at <1.6, and Hermes overrides that cap in uv, which
# pip ignores). filelock stays on 3.x: its fix (4.2.1) is outside the <4.0 cap of
# litellm, and its advisories need another local account on the box.
RUN git init "${HERMES_DIR}" \
    && cd "${HERMES_DIR}" \
    && git remote add origin "${HERMES_AGENT_REPO}" \
    && git fetch --depth 1 origin "${HERMES_AGENT_REF}" \
    && git checkout --detach FETCH_HEAD \
    && python3 -m venv venv \
    && venv/bin/pip install --upgrade pip setuptools wheel \
    && venv/bin/pip install --no-cache-dir -e '.[cli,pty,mcp,acp,google,bedrock,web,youtube,voice,messaging]' 'aiohttp>=3.13.3,<4' \
    && venv/bin/pip install --no-cache-dir 'mcp==1.30.0' \
    && venv/bin/pip freeze | grep -iE '^(mcp|starlette)==' > /tmp/hermes-core-pins.txt \
    && venv/bin/pip install --no-cache-dir -c /tmp/hermes-core-pins.txt 'hindsight-api-slim[embedded-db]==0.7.2' 'hindsight-client==0.7.2' langfuse \
    && venv/bin/pip install --no-cache-dir -c /tmp/hermes-core-pins.txt 'cryptography==50.0.2' 'Pillow==13.0.0' 'PyJWT[crypto]==2.15.1' \
       'brotlicffi==1.2.1.0' 'PyNaCl==1.6.2' \
    && venv/bin/python -c 'import PIL, jwt, cryptography; assert (PIL.__version__, jwt.__version__, cryptography.__version__) == ("13.0.0", "2.15.1", "50.0.2")' \
    && venv/bin/python -c 'import importlib.metadata as m; v = {p: m.version(p) for p in ("mcp", "brotlicffi", "PyNaCl")}; print(v); assert v == {"mcp": "1.30.0", "brotlicffi": "1.2.1.0", "PyNaCl": "1.6.2"}' \
    && venv/bin/python -c 'import brotlicffi, nacl.secret; assert brotlicffi.decompress(brotlicffi.compress(b"joshu")) == b"joshu"' \
    && venv/bin/python -c 'from mcp.client.streamable_http import streamablehttp_client' \
    && rm -f /tmp/hermes-core-pins.txt \
    && cd web \
    && npm install --include=dev \
    && npm run build \
    && rm -rf node_modules /root/.npm

# v0.20+ applicators (Python) plus legacy .patch fallbacks for older pins.
COPY scripts/hermes-langfuse-system-prompt.patch \
     scripts/hermes-langfuse-user-id.patch \
     scripts/hermes-langfuse-openrouter-cost.patch \
     scripts/hermes-openrouter-usage-include.patch \
     scripts/hermes-content-filter.patch \
     scripts/patch-hermes-langfuse-openrouter.py \
     scripts/patch-hermes-content-filter-v020.py \
     scripts/patch-hermes-read-file-utf8.py \
     scripts/patch-hermes-ea-kanban-no-autodecompose.py \
     scripts/patch-hermes-kanban-worker-terminate-on-complete.py \
     scripts/patch-hermes-dsml-stream-scrub.py \
     scripts/patch-hermes-openrouter-data-collection.py \
     scripts/patch-hindsight-openrouter-rerank.py \
     scripts/apply-hermes-langfuse-patches.sh \
     scripts/apply-hermes-kanban-ws-base-path-patch.sh \
     scripts/apply-hermes-content-filter-patch.sh \
     scripts/apply-hermes-read-file-utf8-patch.sh \
     scripts/apply-hermes-ea-kanban-no-autodecompose.sh \
     scripts/apply-hermes-kanban-worker-terminate-on-complete.sh \
     scripts/apply-hermes-dsml-stream-scrub.sh \
     scripts/apply-hermes-openrouter-data-collection.sh \
     scripts/patch-hermes-pairing-reply.py \
     scripts/apply-hermes-pairing-reply.sh \
     scripts/patch-hermes-approval-no-permanent.py \
     scripts/apply-hermes-approval-no-permanent.sh \
     /tmp/joshu-hermes-patches/
RUN HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-langfuse-patches.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-kanban-ws-base-path-patch.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-content-filter-patch.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-read-file-utf8-patch.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-ea-kanban-no-autodecompose.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-kanban-worker-terminate-on-complete.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-dsml-stream-scrub.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-openrouter-data-collection.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-pairing-reply.sh \
    && HERMES_DIR="${HERMES_DIR}" bash /tmp/joshu-hermes-patches/apply-hermes-approval-no-permanent.sh \
    && "${HERMES_DIR}/venv/bin/python" /tmp/joshu-hermes-patches/patch-hindsight-openrouter-rerank.py \
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
# Fleet: populated by scripts/stage-docker-design-pack.sh before build. OSS: empty marker only.
COPY .docker-staging/joshu-design /opt/joshu-design
# Fail closed for branded fleet images — missing pack → vanilla shell on customer boxes.
ARG JOSHU_REQUIRE_DESIGN_PACK=0
RUN if [ "${JOSHU_REQUIRE_DESIGN_PACK}" = "1" ]; then \
      test -f /opt/joshu-design/arozos/web-overlays/aroz-paper-shell.css \
        || (echo "JOSHU_REQUIRE_DESIGN_PACK=1 but aroz-paper-shell.css missing under /opt/joshu-design" >&2; exit 1); \
    fi

RUN bash ${APP_DIR}/scripts/apply-arozos-patches.sh \
    && cd ${APP_DIR}/vendor/arozos/src \
    && go mod download \
    && go build -o ${AROZ_TEMPLATE}/arozos . \
    && mkdir -p ${AROZ_TEMPLATE}/web ${AROZ_TEMPLATE}/system ${AROZ_TEMPLATE}/subservice \
    && rsync -a web/ ${AROZ_TEMPLATE}/web/ \
    && rsync -a system/ ${AROZ_TEMPLATE}/system/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/joshu/ ${AROZ_TEMPLATE}/subservice/joshu/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/excalidraw/ ${AROZ_TEMPLATE}/subservice/excalidraw/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/md-editor/ ${AROZ_TEMPLATE}/subservice/md-editor/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/hermes-chat/ ${AROZ_TEMPLATE}/subservice/hermes-chat/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/hindsight-viewer/ ${AROZ_TEMPLATE}/subservice/hindsight-viewer/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/file-brain-viewer/ ${AROZ_TEMPLATE}/subservice/file-brain-viewer/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/schedules/ ${AROZ_TEMPLATE}/subservice/schedules/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/jmovie/ ${AROZ_TEMPLATE}/subservice/jmovie/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/jmail/ ${AROZ_TEMPLATE}/subservice/jmail/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/connectors/ ${AROZ_TEMPLATE}/subservice/connectors/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/safety-settings/ ${AROZ_TEMPLATE}/subservice/safety-settings/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/welcome/ ${AROZ_TEMPLATE}/subservice/welcome/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/jterm/ ${AROZ_TEMPLATE}/subservice/jterm/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/telephone/ ${AROZ_TEMPLATE}/subservice/telephone/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/boss-mode/ ${AROZ_TEMPLATE}/subservice/boss-mode/ \
    && rsync -a ${APP_DIR}/arozos-subservice-staging/last30days/ ${AROZ_TEMPLATE}/subservice/last30days/ \
    && rsync -a ${APP_DIR}/dist/excalidraw/ ${AROZ_TEMPLATE}/subservice/excalidraw/app/ \
    && rsync -a ${APP_DIR}/dist/md-editor/ ${AROZ_TEMPLATE}/subservice/md-editor/app/ \
    && rsync -a ${APP_DIR}/dist/hermes-chat/ ${AROZ_TEMPLATE}/subservice/hermes-chat/app/ \
    && rsync -a ${APP_DIR}/dist/hindsight-viewer/ ${AROZ_TEMPLATE}/subservice/hindsight-viewer/app/ \
    && rsync -a ${APP_DIR}/dist/file-brain-viewer/ ${AROZ_TEMPLATE}/subservice/file-brain-viewer/app/ \
    && rsync -a ${APP_DIR}/dist/schedules/ ${AROZ_TEMPLATE}/subservice/schedules/app/ \
    && rsync -a ${APP_DIR}/dist/movie-editor/ ${AROZ_TEMPLATE}/subservice/jmovie/app/ \
    && rsync -a ${APP_DIR}/dist/jmail/ ${AROZ_TEMPLATE}/subservice/jmail/app/ \
    && rsync -a ${APP_DIR}/dist/connectors-app/ ${AROZ_TEMPLATE}/subservice/connectors/app/ \
    && rsync -a ${APP_DIR}/dist/safety-settings/ ${AROZ_TEMPLATE}/subservice/safety-settings/app/ \
    && rsync -a ${APP_DIR}/dist/welcome/ ${AROZ_TEMPLATE}/subservice/welcome/app/ \
    && rsync -a ${APP_DIR}/dist/jterm/ ${AROZ_TEMPLATE}/subservice/jterm/app/ \
    && rsync -a ${APP_DIR}/dist/telephone/ ${AROZ_TEMPLATE}/subservice/telephone/app/ \
    && rsync -a ${APP_DIR}/dist/boss-mode/ ${AROZ_TEMPLATE}/subservice/boss-mode/app/ \
    && rsync -a ${APP_DIR}/dist/last30days-app/ ${AROZ_TEMPLATE}/subservice/last30days/app/ \
    && bash ${APP_DIR}/scripts/install-proprietary-apps.sh ${AROZ_TEMPLATE}/subservice \
    && chmod +x ${AROZ_TEMPLATE}/subservice/*/start.sh \
    && (python3 ${APP_DIR}/scripts/apply_arozos_joshu_theme.py ${AROZ_TEMPLATE}/web || true)

FROM ${BASE_IMAGE} AS runtime

ARG HERMES_AGENT_REF=3c27eb6234bf91b8ceee9e9071591b31e9b148cb
ARG GBRAIN_REF=fa2c7a6990a7a57b251979ef6e1988ff09529021
ARG POSTGRES_VERSION=17

ENV APP_DIR=/opt/joshu \
    HERMES_DIR=/opt/hermes-agent \
    AROZ_TEMPLATE=/opt/arozos-template \
    DEBIAN_FRONTEND=noninteractive

# chromium + xvfb: local Chromium (headed, on Xvfb :99). apt installs chromium without
# recommended fonts, so fontconfig and the fonts are explicit.
# python3-requests: the companion runs its own scripts with the system python3 (the
# Hermes gateway PATH has no venv), and these scripts often import requests. Before
# 0.1.50 requests came in only as a dependency of websockify (noVNC).
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates curl ffmpeg git libopus0 libportaudio2 openssh-client patch poppler-utils postgresql-${POSTGRES_VERSION} procps python3 python3-pip python3-requests python3-venv ripgrep rsync unzip util-linux \
    net-tools \
    chromium xvfb fontconfig fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -c "import requests" \
    && python3 -m pip install --no-cache-dir --break-system-packages pypdf \
    && curl -fsSL https://bun.sh/install | bash \
    && /root/.bun/bin/bun install -g "github:garrytan/gbrain#${GBRAIN_REF}" \
    && curl -fsSL https://astral.sh/uv/install.sh | sh \
    && /root/.local/bin/uv python install 3.12 \
    && mkdir -p /opt/joshu/.local/python312/bin \
    && ln -sf /root/.local/share/uv/python/cpython-3.12-*/bin/python3.12 /opt/joshu/.local/python312/bin/python3.12 \
    && /opt/joshu/.local/python312/bin/python3.12 --version

# Node 22 for the Joshu API, Hermes dashboard rebuild, and the Chromium supervisor (see builder stage note).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && node -v | grep -E '^v22\.' \
    && npm -v \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/hermes-agent /opt/hermes-agent
COPY --from=builder /opt/arozos-template /opt/arozos-template
COPY --from=builder /opt/joshu-design /opt/joshu-design
COPY --from=builder /usr/lib/postgresql/${POSTGRES_VERSION}/lib/vector.so /usr/lib/postgresql/${POSTGRES_VERSION}/lib/vector.so
COPY --from=builder /usr/share/postgresql/${POSTGRES_VERSION}/extension/vector* /usr/share/postgresql/${POSTGRES_VERSION}/extension/

WORKDIR ${APP_DIR}
COPY deploy/runtime/package.json deploy/runtime/package-lock.json ./
COPY patches ./patches
COPY dist ./dist
# Public Chat-with-files HTML (cwd lookup). Also bundled at dist/shareChat/ui/.
COPY apps/share-chat ./apps/share-chat
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
COPY packages/whiteboard-cwm/package.json ./packages/whiteboard-cwm/
COPY packages/whiteboard-cwm/dist ./packages/whiteboard-cwm/dist/
COPY arozos/icons ./arozos/icons
COPY arozos/web-overlays-vanilla ./arozos/web-overlays-vanilla
COPY arozos/system-setting ./arozos/system-setting
COPY arozos/locale ./arozos/locale
COPY scripts ./scripts
COPY deploy/scripts/vps-start.sh ${APP_DIR}/scripts/vps-start.sh
COPY deploy/RELEASE.json ${APP_DIR}/RELEASE.json
COPY browser/chromium/package.json browser/chromium/supervisor.mjs browser/chromium/localProxy.mjs browser/chromium/entrypoint.sh browser/chromium/agent-service.py browser/chromium/requirements.txt /opt/browser/
# browser-use pins old versions exactly, so install the security fixes after it:
# Pillow (image decoders), aiohttp (8 advisories of 2026-10), pypdf (denial of service
# in PDF parsing), anyio (TLS host name encoding), and mcp 2.2.0 (GHSA-84m7-p3x7-pcfv).
# Drop each override when browser-use reaches it. pip itself is updated first, because
# the venv copy (25.1.1) has advisories that are fixed in 26.
RUN python3 -m venv /opt/browser/venv \
    && /opt/browser/venv/bin/pip install --no-cache-dir --upgrade 'pip>=26.2' \
    && /opt/browser/venv/bin/pip install --no-cache-dir -r /opt/browser/requirements.txt \
    && /opt/browser/venv/bin/pip install --no-cache-dir 'pillow==13.0.0' 'aiohttp==3.14.5' 'pypdf==6.21.2' 'anyio==4.14.2' 'mcp==2.2.0' \
    && /opt/browser/venv/bin/python -c 'import PIL, aiohttp, pypdf, anyio, mcp, browser_use; import importlib.metadata as m; assert m.version("mcp") == "2.2.0"; print("browser venv ok", PIL.__version__, aiohttp.__version__, pypdf.__version__, m.version("mcp"))'

RUN cd /opt/browser && npm install --omit=dev --no-audit --no-fund \
    && chmod +x /opt/browser/entrypoint.sh \
    && cd ${APP_DIR} && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && (patch --batch --forward -p1 -i patches/http-proxy+1.18.1.patch || true) \
    && node scripts/patch-gbrain.mjs /root/.bun/install/global/node_modules/gbrain \
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
    && test -f node_modules/@joshu/app-sdk/dist/index.js \
    || (echo "ERROR: @joshu/app-sdk dist missing after npm ci" >&2; exit 1) \
    && test -f node_modules/@joshu/box-state/dist/index.js \
    || (echo "ERROR: @joshu/box-state dist missing after npm ci" >&2; exit 1) \
    && test -f node_modules/@joshu/email-signature/dist/index.js \
    || (echo "ERROR: @joshu/email-signature dist missing after npm ci" >&2; exit 1) \
    && test -f node_modules/@joshu/whiteboard-cwm/dist/index.js \
    || (echo "ERROR: @joshu/whiteboard-cwm dist missing after npm ci" >&2; exit 1)

# Fail closed: every runtime-assets.json dest must be in the baked dist/.
RUN node scripts/copy-runtime-assets.mjs --check \
    && test -f apps/share-chat/index.html

# last30days engine is gitignored; CI must run sync-last30days-skill.sh before docker build.
# Bake a second copy outside integrations/ so a future bind-mount cannot shadow it.
# The no-training routing patch is idempotent; it also covers a local engine copy synced before the patch existed.
RUN test -f integrations/last30days-skill/skills/last30days/scripts/last30days.py \
    || (echo "ERROR: last30days engine missing; run scripts/sync-last30days-skill.sh before docker build" >&2; exit 1) \
    && python3 scripts/patch-last30days-openrouter-data-collection.py
# Boot scripts: unshadowable copy. Compose used to bind-mount host /opt/joshu/scripts over
# the image, so a stale clone skipped jNotes/md-editor even on a current GHCR tag.
# CMD uses .image/vps-start.sh; optional host hotfix/scripts overlays at boot.
RUN mkdir -p /opt/joshu/.image \
    && cp -a integrations/last30days-skill /opt/joshu/.image/last30days-skill \
    && cp -a ${APP_DIR}/scripts /opt/joshu/.image/scripts \
    && chmod +x /opt/joshu/.image/scripts/vps-start.sh \
    && test -f /opt/joshu/.image/last30days-skill/skills/last30days/scripts/last30days.py \
    && test -f /opt/joshu/.image/scripts/vps-start.sh \
    && test -f /opt/joshu/.image/scripts/lib/arozos-desktop-shortcuts.sh

# Host bundle (change image-owned-box-runtime): the files that the host needs to start
# a box. deploy/scripts/install-host-bundle.sh writes them to /opt/joshu/deploy/ on the host.
COPY deploy/docker-compose.yml deploy/.env.vps.example /opt/joshu/.image/host/deploy/
COPY deploy/scripts/render-caddyfile.sh deploy/scripts/caddy-entrypoint.sh deploy/scripts/install-host-bundle.sh \
    deploy/scripts/ensure-instance-env-secrets.sh deploy/scripts/carry-over-joshu-state.sh \
    deploy/scripts/prune-release-images.sh \
    /opt/joshu/.image/host/deploy/scripts/
# The instance agent runs set_aroz_password from the host (the script mounts its Go source into a container).
COPY scripts/arozos-reset-password.sh /opt/joshu/.image/host/scripts/
COPY scripts/arozos-reset-password /opt/joshu/.image/host/scripts/arozos-reset-password
RUN chmod +x /opt/joshu/.image/host/deploy/scripts/*.sh \
    && test -f /opt/joshu/.image/host/deploy/docker-compose.yml \
    && test -f /opt/joshu/.image/host/deploy/.env.vps.example \
    && test -x /opt/joshu/.image/host/deploy/scripts/render-caddyfile.sh \
    && test -x /opt/joshu/.image/host/deploy/scripts/caddy-entrypoint.sh \
    && test -x /opt/joshu/.image/host/deploy/scripts/install-host-bundle.sh \
    && test -x /opt/joshu/.image/host/deploy/scripts/ensure-instance-env-secrets.sh \
    && test -x /opt/joshu/.image/host/deploy/scripts/carry-over-joshu-state.sh \
    && test -x /opt/joshu/.image/host/deploy/scripts/prune-release-images.sh \
    && test -f /opt/joshu/.image/host/scripts/arozos-reset-password.sh

# Release provenance of dist/ comes from the image. No host sync writes it any more.
RUN node -e 'const fs = require("fs"); \
  const r = JSON.parse(fs.readFileSync(process.env.APP_DIR + "/RELEASE.json", "utf8")); \
  fs.writeFileSync(process.env.APP_DIR + "/dist/.release-provenance.json", JSON.stringify({ \
    version: r.version, imageRef: r.imageRef, distSource: "image", syncedAt: new Date().toISOString() \
  }, null, 2) + "\n");' \
    && grep -q '"distSource": "image"' ${APP_DIR}/dist/.release-provenance.json

RUN id -u hindsight >/dev/null 2>&1 || useradd --create-home --home-dir /home/hindsight --shell /usr/sbin/nologin hindsight

ENV PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    PUBLIC_BASE_PATH=/joshu \
    PORT=8788 \
    HOST=127.0.0.1 \
    PUBLIC_AROZ_PORT=8787 \
    AROZ_DATA=/var/lib/arozos \
    JOSHU_STATE_DIR=/var/lib/arozos/joshu-state \
    HINDSIGHT_POSTGRES_DATA_DIR=/var/lib/postgresql/hindsight/data \
    HERMES_BIN=${HERMES_DIR}/venv/bin/hermes \
    HERMES_AGENT_REF=${HERMES_AGENT_REF} \
    LAST30DAYS_PYTHON=/opt/joshu/.local/python312/bin/python3.12 \
    LAST30DAYS_IMAGE_ENGINE_ROOT=/opt/joshu/.image/last30days-skill \
    NODE_ENV=production

EXPOSE 8787 8788

CMD ["bash", "/opt/joshu/.image/scripts/vps-start.sh"]
