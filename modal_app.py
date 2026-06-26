# pyright: reportMissingImports=false
import os
import shlex
from pathlib import Path

import modal


APP_NAME = "joshu-hitl"
LOCAL_ROOT = Path(__file__).parent
REMOTE_APP_DIR = "/opt/joshu"
REMOTE_HERMES_DIR = "/opt/hermes-agent"
GO_VERSION = "1.24.1"
HERMES_AGENT_REPO = os.environ.get("HERMES_AGENT_REPO", "https://github.com/NousResearch/hermes-agent.git")
# Pin Hermes so Modal deploys match a specific upstream commit. Default: tag
# v2026.5.16 peeled → Agent v0.14.0 (2026.5.16). Build verifies Camofox tab API
# (`_ensure_tab` + sessionKey) or newer `adopt_existing_tab` support.
HERMES_AGENT_REF = os.environ.get("HERMES_AGENT_REF", "a91a57fa5a13d516c38b07a141a9ce8a3daabeb0")
HERMES_AGENT_REPO_SH = shlex.quote(HERMES_AGENT_REPO)
HERMES_AGENT_REF_SH = shlex.quote(HERMES_AGENT_REF)
PGVECTOR_REPO = os.environ.get("PGVECTOR_REPO", "https://github.com/pgvector/pgvector.git")
PGVECTOR_REF = os.environ.get("PGVECTOR_REF", "v0.8.1")
PGVECTOR_REPO_SH = shlex.quote(PGVECTOR_REPO)
PGVECTOR_REF_SH = shlex.quote(PGVECTOR_REF)
POSTGRES_VERSION = "15"
MODAL_SERVE_TIMEOUT_SECONDS = 24 * 60 * 60
MODAL_SERVE_SCALEDOWN_WINDOW_SECONDS = 30 * 60
# When MODAL_EMBED_LOCAL_DIST=1, the image skips tsc/vite inside Modal and copies
# dist/ from your machine (build first: npm run modal:predeploy). That avoids
# reinstalling devDependencies and re-running Vite when only TS/React changed.
# Heavy layers (Hermes pip, pgvector, ArozOS go build) still run when those pins change.
MODAL_EMBED_LOCAL_DIST = os.environ.get("MODAL_EMBED_LOCAL_DIST", "").strip().lower() in ("1", "true", "yes")
# Prefer a checked-out ArozOS source tree inside this repo (submodule/mirror).
# AROZOS_REPO/REF remain as a bootstrap fallback until vendor/arozos exists.
LOCAL_AROZ_SOURCE = LOCAL_ROOT / "vendor" / "arozos"
HAS_LOCAL_AROZ_SOURCE = (LOCAL_AROZ_SOURCE / "src" / "web").exists() and (LOCAL_AROZ_SOURCE / "src" / "system").exists()
AROZOS_REPO = os.environ.get("AROZOS_REPO", "https://github.com/tobychui/arozos.git")
AROZOS_REF = os.environ.get("AROZOS_REF", "master")
REMOTE_AROZ_SOURCE = "/opt/arozos-source"
REMOTE_AROZ_TEMPLATE = "/opt/arozos-template"


def _modal_embed_assert_local_dist() -> None:
    if not MODAL_EMBED_LOCAL_DIST:
        return
    required = (
        "dist/server.js",
        "dist/excalidraw/index.html",
        "dist/hermes-chat/index.html",
        "dist/hindsight-viewer/index.html",
        "dist/file-brain-viewer/index.html",
        "dist/schedules/index.html",
        "dist/movie-editor/index.html",
    )
    missing = [rel for rel in required if not (LOCAL_ROOT / rel).is_file()]
    if missing:
        raise RuntimeError(
            "MODAL_EMBED_LOCAL_DIST=1 requires prebuilt bundles under dist/:\n"
            + "\n".join(f"  - {m}" for m in missing)
            + "\nRun: npm run modal:predeploy"
        )


def _extend_joshu_mounts(img: modal.Image) -> modal.Image:
    """Adds package manifests, patches, design-system pkg, then dist or src/apps."""
    next_img = img.add_local_file(
        LOCAL_ROOT / "package.json", remote_path=f"{REMOTE_APP_DIR}/package.json", copy=True
    ).add_local_file(
        LOCAL_ROOT / "package-lock.json", remote_path=f"{REMOTE_APP_DIR}/package-lock.json", copy=True
    ).add_local_dir(
        LOCAL_ROOT / "patches",
        remote_path=f"{REMOTE_APP_DIR}/patches",
        copy=True,
    )
    if not MODAL_EMBED_LOCAL_DIST:
        next_img = next_img.add_local_file(
            LOCAL_ROOT / "tsconfig.json", remote_path=f"{REMOTE_APP_DIR}/tsconfig.json", copy=True
        )
    next_img = next_img.add_local_dir(
        LOCAL_ROOT / "packages" / "design-system",
        remote_path=f"{REMOTE_APP_DIR}/packages/design-system",
        copy=True,
    )
    excalidraw_vendor = LOCAL_ROOT / "vendor" / "excalidraw"
    if excalidraw_vendor.exists():
        next_img = next_img.add_local_dir(
            excalidraw_vendor,
            remote_path=f"{REMOTE_APP_DIR}/vendor/excalidraw",
            copy=True,
            ignore=[".git", ".git/**", "**/node_modules/**"],
        )
    if MODAL_EMBED_LOCAL_DIST:
        return next_img.add_local_dir(
            LOCAL_ROOT / "dist", remote_path=f"{REMOTE_APP_DIR}/dist", copy=True
        )
    return (
        next_img.add_local_dir(LOCAL_ROOT / "src", remote_path=f"{REMOTE_APP_DIR}/src", copy=True).add_local_dir(
            LOCAL_ROOT / "apps", remote_path=f"{REMOTE_APP_DIR}/apps", copy=True
        )
    )


def _joshu_modal_npm_phase_commands() -> tuple[str, ...]:
    if MODAL_EMBED_LOCAL_DIST:
        # Skip devDeps + Vite/tsc inside Modal; apply the single bundled patch with GNU patch.
        return (
            f"cd {REMOTE_APP_DIR} && npm ci --omit=dev --ignore-scripts",
            f"cd {REMOTE_APP_DIR} && patch --batch --forward -p1 -i patches/http-proxy+1.18.1.patch",
            f"node {REMOTE_APP_DIR}/scripts/sync-design-system-public.mjs",
        )
    return (
        f"corepack enable",
        f"cd {REMOTE_APP_DIR} && npm ci --include=dev",
        f"cd {REMOTE_APP_DIR} && npm run build",
        f"cd {REMOTE_APP_DIR} && npm run build:excalidraw",
        f"cd {REMOTE_APP_DIR} && npm run build:hermes-chat",
        f"cd {REMOTE_APP_DIR} && npm run build:hindsight-viewer",
        f"cd {REMOTE_APP_DIR} && npm run build:file-brain-viewer",
        f"cd {REMOTE_APP_DIR} && npm run build:movie-editor",
    )


image = (
    # Camofox's image already contains the browser, VNC/noVNC pieces, and the
    # Node service exposing the Camofox REST API. Modal adds Python for the
    # function runtime and Hermes install.
    modal.Image.from_registry("ghcr.io/jo-inc/camofox-browser:latest", add_python="3.11")
    .apt_install(
        "bash",
        "build-essential",
        "ca-certificates",
        "curl",
        "ffmpeg",
        "git",
        "libopus0",
        "libportaudio2",
        "passwd",
        "patch",
        "postgresql-15",
        "postgresql-server-dev-15",
        "procps",
        "rsync",
        "util-linux",
    )
    .run_commands(
        "id -u hindsight >/dev/null 2>&1 || useradd --create-home --home-dir /home/hindsight --shell /usr/sbin/nologin hindsight",
        # ArozOS currently uses go 1.24.0 plus toolchain go1.24.1; Debian bookworm's
        # golang-go package is 1.19 and cannot parse that go.mod.
        f"rm -rf /usr/local/go && curl -fsSL https://go.dev/dl/go{GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz",
        "ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt",
        f"go version | grep 'go{GO_VERSION}'",
        f"git init {REMOTE_HERMES_DIR}",
        f"cd {REMOTE_HERMES_DIR} && git remote add origin {HERMES_AGENT_REPO_SH}",
        (
            f"cd {REMOTE_HERMES_DIR} && "
            f"for attempt in 1 2 3 4 5; do git fetch --depth 1 origin {HERMES_AGENT_REF_SH} && break; "
            "sleep $((attempt * 5)); done && git rev-parse FETCH_HEAD >/dev/null"
        ),
        f"cd {REMOTE_HERMES_DIR} && git checkout --detach FETCH_HEAD",
        f"cd {REMOTE_HERMES_DIR} && echo '[joshu] Hermes agent pinned to '$(git rev-parse HEAD)",
        f"cd {REMOTE_HERMES_DIR} && python -m venv venv",
        f"cd {REMOTE_HERMES_DIR} && venv/bin/pip install --upgrade pip setuptools wheel",
        # Avoid Hermes's broad [all] extra here: it pulls optional providers
        # that are not needed for Joshu and can break reproducible Modal builds.
        # voice: CLI STT/TTS; messaging: Discord/Telegram gateway (+ discord voice).
        f"cd {REMOTE_HERMES_DIR} && venv/bin/pip install -e '.[cli,pty,mcp,acp,google,bedrock,web,youtube,voice,messaging]' 'aiohttp>=3.13.3,<4'",
        f"cd {REMOTE_HERMES_DIR} && venv/bin/pip install 'hindsight-api-slim[embedded-db]==0.7.2' 'hindsight-client==0.7.2' langfuse",
        (
            # pg0's bundled pgvector binary currently requires a newer glibc than
            # the Camofox base image provides. Run Hindsight against a local
            # PostgreSQL service instead, with pgvector built in this image.
            # pgvector defaults to -march=native; disable that so the compiled
            # extension runs on Modal runtime CPUs that differ from the builder.
            "set -eux; "
            f"PG_CONFIG=/usr/lib/postgresql/{POSTGRES_VERSION}/bin/pg_config; "
            "rm -rf /tmp/pgvector; "
            f"for attempt in 1 2 3 4 5; do git clone --depth 1 --branch {PGVECTOR_REF_SH} {PGVECTOR_REPO_SH} /tmp/pgvector && break; "
            "rm -rf /tmp/pgvector; sleep $((attempt * 5)); done; "
            "test -d /tmp/pgvector/.git; "
            "cd /tmp/pgvector; "
            "make PG_CONFIG=\"$PG_CONFIG\" OPTFLAGS=\"\"; "
            "make install PG_CONFIG=\"$PG_CONFIG\" OPTFLAGS=\"\"; "
            f"ldd /usr/lib/postgresql/{POSTGRES_VERSION}/lib/vector.so; "
            "rm -rf /tmp/pgvector; "
            "echo '[joshu] built portable pgvector for local PostgreSQL against the Modal image glibc'"
        ),
    )
)

if HAS_LOCAL_AROZ_SOURCE:
    image = image.add_local_dir(
        LOCAL_AROZ_SOURCE,
        remote_path=REMOTE_AROZ_SOURCE,
        copy=True,
        ignore=[".git", ".git/**"],
    )
else:
    image = image.run_commands(
        f"git clone {AROZOS_REPO} {REMOTE_AROZ_SOURCE}",
        f"cd {REMOTE_AROZ_SOURCE} && git checkout {AROZOS_REF}",
    )

_modal_embed_assert_local_dist()

_stage = (
    image
    # Build ArozOS from the checked-out source at image build time. The runtime
    # still uses a template directory so persistent user data can live in /var/lib/arozos.
    .run_commands(
        (
            f"python -c \"import sys; from pathlib import Path; root = Path('{REMOTE_AROZ_SOURCE}'); "
            "missing = [p for p in ['src/web', 'src/system', 'src/go.mod'] if not (root / p).exists()]; "
            "sys.exit(f'ArozOS source missing required paths: {missing}') if missing else print(f'[joshu] using ArozOS source at {root}')\""
        ),
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}",
        f"cd {REMOTE_AROZ_SOURCE}/src && go mod download && go build -o {REMOTE_AROZ_TEMPLATE}/arozos .",
        f"rsync -a {REMOTE_AROZ_SOURCE}/src/web/ {REMOTE_AROZ_TEMPLATE}/web/",
        f"rsync -a {REMOTE_AROZ_SOURCE}/src/system/ {REMOTE_AROZ_TEMPLATE}/system/",
        # Subservice registration uses ./subservice/<name>/ with start.sh + moduleInfo.json.
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice",
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "joshu",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/joshu",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "excalidraw",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/excalidraw",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "hermes-chat",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/hermes-chat",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "hindsight-viewer",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/hindsight-viewer",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "file-brain-viewer",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/file-brain-viewer",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "schedules",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/schedules",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "subservice" / "jmovie",
        remote_path=f"{REMOTE_AROZ_TEMPLATE}/subservice/jmovie",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "icons",
        remote_path=f"{REMOTE_APP_DIR}/arozos/icons",
        copy=True,
    )
    .add_local_dir(
        LOCAL_ROOT / "arozos" / "web-overlays",
        remote_path=f"{REMOTE_APP_DIR}/arozos/web-overlays",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "apply_arozos_joshu_theme.py",
        remote_path=f"{REMOTE_APP_DIR}/scripts/apply_arozos_joshu_theme.py",
        copy=True,
    )
    .run_commands(
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/joshu/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/excalidraw/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/hermes-chat/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/hindsight-viewer/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/file-brain-viewer/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/schedules/start.sh",
        f"chmod +x {REMOTE_AROZ_TEMPLATE}/subservice/jmovie/start.sh",
        f"python3 {REMOTE_APP_DIR}/scripts/apply_arozos_joshu_theme.py {REMOTE_AROZ_TEMPLATE}/web",
    )
)

image = (
    _extend_joshu_mounts(_stage)
    .add_local_dir(LOCAL_ROOT / "public", remote_path=f"{REMOTE_APP_DIR}/public", copy=True)
    .add_local_dir(LOCAL_ROOT / "integrations", remote_path=f"{REMOTE_APP_DIR}/integrations", copy=True)
    .add_local_dir(LOCAL_ROOT / ".hermes", remote_path=f"{REMOTE_APP_DIR}/.hermes", copy=True)
    .add_local_file(LOCAL_ROOT / "scripts" / "modal-start.sh", remote_path=f"{REMOTE_APP_DIR}/scripts/modal-start.sh", copy=True)
    .add_local_file(LOCAL_ROOT / "scripts" / "start-hindsight.sh", remote_path=f"{REMOTE_APP_DIR}/scripts/start-hindsight.sh", copy=True)
    .add_local_file(
        LOCAL_ROOT / "scripts" / "hermes-chat-transcribe.py",
        remote_path=f"{REMOTE_APP_DIR}/scripts/hermes-chat-transcribe.py",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "hermes-chat-tts.py",
        remote_path=f"{REMOTE_APP_DIR}/scripts/hermes-chat-tts.py",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "sync-design-system-public.mjs",
        remote_path=f"{REMOTE_APP_DIR}/scripts/sync-design-system-public.mjs",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "patch-camofox-single-tab.mjs",
        remote_path=f"{REMOTE_APP_DIR}/scripts/patch-camofox-single-tab.mjs",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "aroz-subproxy.mjs",
        remote_path=f"{REMOTE_APP_DIR}/scripts/aroz-subproxy.mjs",
        copy=True,
    )
    .add_local_file(
        LOCAL_ROOT / "scripts" / "aroz-static-subservice.mjs",
        remote_path=f"{REMOTE_APP_DIR}/scripts/aroz-static-subservice.mjs",
        copy=True,
    )
    .run_commands(
        f"chmod +x {REMOTE_APP_DIR}/scripts/aroz-subproxy.mjs",
        f"chmod +x {REMOTE_APP_DIR}/scripts/aroz-static-subservice.mjs",
        # The pinned Hermes checkout must include generic Camofox adoption. Modal
        # no longer patches Hermes core; only the Camofox server is patched below.
        f"cd {REMOTE_HERMES_DIR} && python -c \"import sys; from pathlib import Path; "
        "text = Path('tools/browser_camofox.py').read_text(); "
        "ok = ('adopt_existing_tab' in text) or ('def _ensure_tab' in text and 'sessionKey' in text); "
        "sys.exit('Pinned Hermes checkout is missing Camofox tab/session support') "
        "if not ok else print('[joshu] verified pinned Hermes Camofox support')\"",
        # Camofox env tab caps only cover API-managed tabs. This build-time
        # patch coerces native Firefox popup pages back into the opener tab.
        f"node {REMOTE_APP_DIR}/scripts/patch-camofox-single-tab.mjs /app/server.js",
        "python -c \"import sys; from pathlib import Path; server = Path('/app/server.js').read_text(); "
        "required = [\\\"app.post('/tabs/:tabId/viewport'\\\", 'hitl_single_visible_page_create']; "
        "missing = [item for item in required if item not in server]; "
        "sys.exit(f'Camofox HITL patch verification failed; missing: {missing}') if missing else print('[joshu] verified Camofox HITL patch markers')\"",
        *_joshu_modal_npm_phase_commands(),
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/excalidraw/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/excalidraw/ {REMOTE_AROZ_TEMPLATE}/subservice/excalidraw/app/",
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/hermes-chat/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/hermes-chat/ {REMOTE_AROZ_TEMPLATE}/subservice/hermes-chat/app/",
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/hindsight-viewer/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/hindsight-viewer/ {REMOTE_AROZ_TEMPLATE}/subservice/hindsight-viewer/app/",
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/file-brain-viewer/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/file-brain-viewer/ {REMOTE_AROZ_TEMPLATE}/subservice/file-brain-viewer/app/",
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/schedules/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/schedules/ {REMOTE_AROZ_TEMPLATE}/subservice/schedules/app/",
        f"mkdir -p {REMOTE_AROZ_TEMPLATE}/subservice/jmovie/app",
        f"rsync -a {REMOTE_APP_DIR}/dist/movie-editor/ {REMOTE_AROZ_TEMPLATE}/subservice/jmovie/app/",
        f"cd {REMOTE_APP_DIR} && npm prune --omit=dev",
        f"chmod +x {REMOTE_APP_DIR}/scripts/modal-start.sh",
        f"chmod +x {REMOTE_APP_DIR}/scripts/start-hindsight.sh",
    )
)


app = modal.App(APP_NAME)

hermes_home = modal.Volume.from_name("joshu-hitl-hermes-home", create_if_missing=True)
hindsight_home = modal.Volume.from_name("joshu-hitl-hindsight-home", create_if_missing=True)
hindsight_cache = modal.Volume.from_name("joshu-hitl-hindsight-cache", create_if_missing=True)
arozos_data = modal.Volume.from_name("joshu-hitl-arozos-data", create_if_missing=True)
secrets = [modal.Secret.from_name("joshu-hitl-secrets")]


@app.function(
    image=image,
    secrets=secrets,
    volumes={
        "/root/.hermes": hermes_home,
        "/home/hindsight/.hindsight": hindsight_home,
        "/home/hindsight/.cache/huggingface": hindsight_cache,
        "/var/lib/arozos": arozos_data,
    },
    # Modal's default and previous one-hour timeout recycles the whole web
    # server, including the local Hindsight PostgreSQL process. Use the
    # platform maximum for production sessions; durable memory still needs an
    # external database or a Modal-compatible persistent PostgreSQL layout.
    timeout=MODAL_SERVE_TIMEOUT_SECONDS,
    # Hindsight's local PostgreSQL files must have a single writer per mounted
    # volume. Future sandbox orchestration should allocate separate volumes per
    # sandbox instead of scaling this function horizontally against one DB dir.
    max_containers=1,
    # Keep browser + local Hindsight warm across short pauses without forcing a
    # permanently warm container.
    scaledown_window=MODAL_SERVE_SCALEDOWN_WINDOW_SECONDS,
)
@modal.concurrent(max_inputs=50)
@modal.web_server(port=8787, startup_timeout=180)
def serve():
    import subprocess

    subprocess.Popen([f"{REMOTE_APP_DIR}/scripts/modal-start.sh"])
