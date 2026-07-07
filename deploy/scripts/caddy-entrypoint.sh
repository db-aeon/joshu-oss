#!/bin/sh
# Caddy container entrypoint.
#
# Regenerate /etc/caddy/Caddyfile from /etc/joshu/instance.env on every start, then
# run Caddy. This makes the edge config self-healing and independent of the git
# clone: a `git reset`/`pull`/`sync-from-oss` can no longer leave Caddy serving a
# stale or empty config (which silently takes the whole site down while the Joshu
# API health stays 200).
set -eu

ENV_FILE="${JOSHU_INSTANCE_ENV:-/etc/joshu/instance.env}"

CADDYFILE_OUT=/etc/caddy/Caddyfile \
  sh /usr/local/bin/render-caddyfile.sh "${ENV_FILE}"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
