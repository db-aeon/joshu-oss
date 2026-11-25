#!/usr/bin/env bash
# Single-container mode (change single-container-mode): keep owner data and the
# instance config on the persistent disk at JOSHU_DATA_ROOT.
#
# Each image path below becomes a link to a folder under the data root. These are the
# paths that Docker Compose keeps in named volumes, plus /etc/joshu (the instance config)
# and /root/.hindsight (the Hindsight log). The start script sources this file and calls
# link_data_root before it loads any env file.
#
# JOSHU_DATA_ROOT_PATH_PREFIX puts a folder in front of each image path. Only the tests
# set it, so they can run the function on temporary folders.

# "<image path>:<folder under the data root>"
JOSHU_DATA_ROOT_LINKS=(
  "/var/lib/arozos:arozos"
  "/root/.hermes:hermes"
  "/root/.gbrain:gbrain"
  "/var/lib/postgresql/hindsight:postgres-hindsight"
  "/home/hindsight/.hindsight:hindsight-home"
  "/home/hindsight/.cache/huggingface:hindsight-cache"
  "/var/lib/joshu-voice:voice"
  "/root/.hindsight:hindsight-root"
  "/etc/joshu:secrets"
)

# Link one image path to its folder under the data root.
# When the folder is missing, it gets the content that the image has at the path first.
# A folder that exists stays as it is. A real folder at the image path is moved to
# "<path>.image" and not deleted, so a start can never delete owner data.
link_data_root_path() {
  local path="$1" target="$2"
  if [[ -L "${path}" && "$(readlink "${path}")" == "${target}" ]]; then
    mkdir -p "${target}"
    return 0
  fi
  if [[ ! -e "${target}" ]]; then
    # Copy to a ".partial" folder first. A start that stops in the middle of the copy leaves
    # no folder at the target, so the next start copies again and does not keep half a copy.
    rm -rf "${target}.partial"
    mkdir -p "${target}.partial"
    if [[ -d "${path}" && ! -L "${path}" ]]; then
      cp -a "${path}/." "${target}.partial/"
      chown --reference="${path}" "${target}.partial" 2>/dev/null || true
      chmod --reference="${path}" "${target}.partial" 2>/dev/null || true
    fi
    mv "${target}.partial" "${target}"
    echo "[data-root] created ${target}"
  fi
  if [[ -L "${path}" ]]; then
    rm -f "${path}"
  elif [[ -e "${path}" ]]; then
    rm -rf "${path}.image"
    mv "${path}" "${path}.image"
  fi
  mkdir -p "$(dirname "${path}")"
  ln -s "${target}" "${path}"
}

link_data_root() {
  local root="${JOSHU_DATA_ROOT:?JOSHU_DATA_ROOT is not set}"
  local prefix="${JOSHU_DATA_ROOT_PATH_PREFIX:-}"
  local entry path name
  mkdir -p "${root}"
  for entry in "${JOSHU_DATA_ROOT_LINKS[@]}"; do
    path="${prefix}${entry%%:*}"
    name="${entry#*:}"
    link_data_root_path "${path}" "${root}/${name}"
  done
  # Postgres refuses a data folder that another user owns or that others can read.
  if id -u postgres >/dev/null 2>&1; then
    chown -R postgres:postgres "${root}/postgres-hindsight" 2>/dev/null || true
    if [[ -d "${root}/postgres-hindsight/data" ]]; then
      chmod 700 "${root}/postgres-hindsight/data"
    fi
  fi
  chmod 700 "${root}/secrets"
  echo "[data-root] owner data and config under ${root}"
}
