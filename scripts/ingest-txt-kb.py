#!/usr/bin/env python3
"""
Ingest plain .txt files under the ArozOS Desktop into searchable sibling markdown.

gbrain sync only imports .md/.mdx — wrapping .txt → sibling .md makes them
File Brain searchable (same pattern as PDF extract).

TXT stays in place. Prefer stem.md when free; otherwise stem.txt.md (+n).
Re-wrap when the TXT's sha256 changes. Delete orphan sidecars when the TXT is gone.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


SKIP_DIR_NAMES = {
    ".git",
    ".raw",
    "node_modules",
    "__pycache__",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_txt_body(txt_path: Path) -> str:
    """Read plain text as UTF-8 (replace bad bytes); strip trailing whitespace."""
    try:
        raw = txt_path.read_bytes()
    except OSError as err:
        raise RuntimeError(f"cannot read {txt_path.name}: {err}") from err
    # BOM-aware utf-8, then latin-1 fallback for older exports
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    return text.strip()


def read_frontmatter_head(md_path: Path) -> str:
    if not md_path.is_file():
        return ""
    try:
        return md_path.read_text(encoding="utf-8", errors="replace")[:6000]
    except OSError:
        return ""


def read_frontmatter_field(head: str, field: str) -> str | None:
    match = re.search(rf"^{re.escape(field)}:\s*(.+?)\s*$", head, re.MULTILINE)
    if not match:
        return None
    value = match.group(1).strip()
    if (value.startswith('"') and value.endswith('"')) or (
        value.startswith("'") and value.endswith("'")
    ):
        value = value[1:-1]
    return value or None


def is_sidecar_for_txt(md_path: Path, txt_path: Path, files_root: Path) -> bool:
    """True when this markdown was generated from this TXT (frontmatter match)."""
    head = read_frontmatter_head(md_path)
    if not head or "txt_sha256:" not in head:
        return False
    source = read_frontmatter_field(head, "source_txt")
    if not source:
        return False
    if source == txt_path.name:
        return True
    try:
        rel = str(txt_path.resolve().relative_to(files_root.resolve()))
    except ValueError:
        rel = txt_path.name
    return source == rel or source.endswith("/" + txt_path.name)


def find_existing_sidecar(txt_path: Path, files_root: Path) -> Path | None:
    parent = txt_path.parent
    if not parent.is_dir():
        return None
    for entry in sorted(parent.iterdir()):
        if not entry.is_file() or entry.suffix.lower() != ".md":
            continue
        if is_sidecar_for_txt(entry, txt_path, files_root):
            return entry
    return None


def choose_new_sidecar_path(txt_path: Path) -> Path:
    """Prefer stem.md; on collision, use stem.txt.md (+n)."""
    parent = txt_path.parent
    stem = txt_path.stem
    preferred = parent / f"{stem}.md"
    if not preferred.exists():
        return preferred
    candidate = parent / f"{stem}.txt.md"
    if not candidate.exists():
        return candidate
    n = 2
    while True:
        alt = parent / f"{stem}.txt-{n}.md"
        if not alt.exists():
            return alt
        n += 1


def build_markdown(
    title: str,
    txt_name: str,
    source_txt: str,
    txt_hash: str,
    body: str,
) -> str:
    ingested_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    escaped_title = title.replace('"', '\\"')
    # Body is already plain text — keep as-is inside markdown (no fence wrap)
    # so FTS indexes the words without code-block noise.
    return (
        "---\n"
        f'title: "{escaped_title}"\n'
        f"source_txt: {source_txt}\n"
        f"ingested_at: {ingested_at}\n"
        f"txt_sha256: {txt_hash}\n"
        "---\n\n"
        f"# {title}\n\n"
        f"_Wrapped from `{txt_name}` (text file kept alongside this file)._\n\n"
        f"{body}\n"
    )


def should_skip_dir(path: Path) -> bool:
    return path.name in SKIP_DIR_NAMES or path.name.startswith(".")


def os_walk_filtered(root: Path):
    import os

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not should_skip_dir(Path(d))]
        yield dirpath, dirnames, filenames


def iter_txts(files_root: Path) -> list[Path]:
    results: list[Path] = []
    for dirpath, _dirnames, filenames in os_walk_filtered(files_root):
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            if not name.lower().endswith(".txt"):
                continue
            results.append(Path(dirpath) / name)
    return results


def ingest_txt(txt_path: Path, files_root: Path) -> str:
    txt_path = txt_path.resolve()
    files_root = files_root.resolve()
    if not txt_path.is_file():
        raise FileNotFoundError(txt_path)
    if txt_path.suffix.lower() != ".txt":
        raise ValueError(f"not a .txt file: {txt_path}")
    try:
        rel = str(txt_path.relative_to(files_root))
    except ValueError as err:
        raise ValueError(f"TXT outside files root: {txt_path}") from err

    title = txt_path.stem.replace("-", " ").replace("_", " ").strip() or "Document"

    existing = find_existing_sidecar(txt_path, files_root)
    if existing is not None:
        try:
            if existing.stat().st_mtime >= txt_path.stat().st_mtime:
                existing_hash = read_frontmatter_field(
                    read_frontmatter_head(existing), "txt_sha256"
                )
                if existing_hash and len(existing_hash) == 64:
                    return f"skip {rel} (unchanged → {existing.name})"
        except OSError:
            pass

    txt_hash = sha256_file(txt_path)

    if existing is not None:
        existing_hash = read_frontmatter_field(read_frontmatter_head(existing), "txt_sha256")
        if existing_hash == txt_hash:
            return f"skip {rel} (unchanged → {existing.name})"
        md_path = existing
        action = "updated"
    else:
        md_path = choose_new_sidecar_path(txt_path)
        action = "ingested"

    body = read_txt_body(txt_path)
    if len(body) < 1:
        raise RuntimeError(f"empty text file: {txt_path.name}")

    md_path.write_text(
        build_markdown(title, txt_path.name, rel, txt_hash, body),
        encoding="utf-8",
    )
    try:
        md_rel = str(md_path.relative_to(files_root))
    except ValueError:
        md_rel = md_path.name
    return f"{action} {rel} -> {md_rel}"


def resolve_source_txt(md_path: Path, source: str, files_root: Path) -> Path:
    if "/" in source or "\\" in source:
        return (files_root / source).resolve()
    return (md_path.parent / source).resolve()


def is_generated_sidecar(head: str) -> bool:
    return bool(
        head
        and "txt_sha256:" in head
        and read_frontmatter_field(head, "source_txt")
    )


def cleanup_orphan_sidecars(files_root: Path) -> list[str]:
    """Remove generated sidecars whose source TXT was deleted.

    Human-authored markdown (no source_txt/txt_sha256) is never touched.
    """
    results: list[str] = []
    for dirpath, _dirnames, filenames in os_walk_filtered(files_root):
        for name in sorted(filenames):
            if not name.lower().endswith(".md"):
                continue
            md_path = Path(dirpath) / name
            head = read_frontmatter_head(md_path)
            if not is_generated_sidecar(head):
                continue
            source = read_frontmatter_field(head, "source_txt")
            if not source:
                continue
            txt_path = resolve_source_txt(md_path, source, files_root)
            if txt_path.is_file():
                continue
            try:
                rel = str(md_path.resolve().relative_to(files_root.resolve()))
            except ValueError:
                rel = md_path.name
            try:
                md_path.unlink()
                results.append(f"removed {rel} (source TXT gone: {source})")
            except OSError as err:
                results.append(f"error {rel}: cleanup failed: {err}")
    return results


def scan_files_root(files_root: Path) -> list[str]:
    if not files_root.is_dir():
        return []
    results: list[str] = []
    for txt_path in iter_txts(files_root):
        try:
            results.append(ingest_txt(txt_path, files_root))
        except Exception as err:
            try:
                rel = str(txt_path.resolve().relative_to(files_root.resolve()))
            except ValueError:
                rel = txt_path.name
            results.append(f"error {rel}: {err}")
    results.extend(cleanup_orphan_sidecars(files_root))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Wrap .txt files as sibling markdown under the ArozOS Desktop tree.",
    )
    parser.add_argument(
        "--root",
        "--files-root",
        dest="root",
        help="Scan root (JOSHU_DESKTOP_ROOT; --files-root kept as alias)",
    )
    parser.add_argument("--txt", help="Single .txt path to ingest (must be under --root)")
    args = parser.parse_args()

    if not args.root:
        parser.error("--root is required")

    files_root = Path(args.root).resolve()

    if args.txt:
        print(ingest_txt(Path(args.txt).resolve(), files_root))
        return 0

    lines = scan_files_root(files_root)
    if not lines:
        return 0
    for line in lines:
        print(line)
    return 0 if all(not line.startswith("error ") for line in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
