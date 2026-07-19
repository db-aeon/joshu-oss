#!/usr/bin/env python3
"""
Ingest PDFs under the ArozOS Desktop (JOSHU_DESKTOP_ROOT) into searchable sibling markdown.

Text PDFs: pdftotext (poppler) when available, else pypdf. No LLM required.
PDFs stay in place; extracted text is written alongside (e.g. report.pdf → report.md).
If report.md already exists and is not this PDF's sidecar, write report.pdf.md instead.
Re-extract when the PDF's sha256 changes. Delete orphan sidecars when the PDF is gone.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


# Skip machine / hidden trees under the files root (still allow PDFs elsewhere).
SKIP_DIR_NAMES = {
    ".git",
    ".raw",
    ".metadata",  # ArozOS trash + desktop metadata — never re-ingest deleted PDFs
    "node_modules",
    "__pycache__",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_with_pdftotext(pdf_path: Path) -> str | None:
    if not shutil.which("pdftotext"):
        return None
    try:
        proc = subprocess.run(
            ["pdftotext", "-layout", str(pdf_path), "-"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, OSError):
        return None
    text = (proc.stdout or "").strip()
    return text or None


def extract_with_pypdf(pdf_path: Path) -> str | None:
    try:
        from pypdf import PdfReader  # type: ignore
    except ImportError:
        return None
    try:
        reader = PdfReader(str(pdf_path))
        parts: list[str] = []
        for page in reader.pages:
            page_text = page.extract_text() or ""
            if page_text.strip():
                parts.append(page_text.strip())
    except Exception:
        return None
    text = "\n\n".join(parts).strip()
    return text or None


def extractor_available() -> bool:
    """True when at least one PDF text extractor is usable in this runtime."""
    if shutil.which("pdftotext"):
        return True
    try:
        import pypdf  # type: ignore  # noqa: F401
    except ImportError:
        return False
    return True


def extract_text(pdf_path: Path) -> str:
    # Distinguish an environment/config problem (no extractor at all) from a
    # scanned/image PDF (extractor ran but found no selectable text) so the
    # watcher log points at the right fix.
    if not extractor_available():
        raise RuntimeError(
            "no PDF text extractor installed — install poppler-utils (pdftotext) "
            "or run: pip install pypdf",
        )
    for extractor in (extract_with_pdftotext, extract_with_pypdf):
        text = extractor(pdf_path)
        if text:
            return text
    raise RuntimeError(
        "no selectable text extracted (scanned/image PDF?) — needs OCR or a "
        "manual transcript alongside the PDF as <name>.md",
    )


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


def is_sidecar_for_pdf(md_path: Path, pdf_path: Path, files_root: Path) -> bool:
    """True when this markdown was generated from this PDF (frontmatter match)."""
    head = read_frontmatter_head(md_path)
    if not head or "pdf_sha256:" not in head:
        return False
    source = read_frontmatter_field(head, "source_pdf")
    if not source:
        return False
    # Accept basename or path relative to files root.
    if source == pdf_path.name:
        return True
    try:
        rel = str(pdf_path.resolve().relative_to(files_root.resolve()))
    except ValueError:
        rel = pdf_path.name
    return source == rel or source.endswith("/" + pdf_path.name)


def find_existing_sidecar(pdf_path: Path, files_root: Path) -> Path | None:
    parent = pdf_path.parent
    if not parent.is_dir():
        return None
    for entry in sorted(parent.iterdir()):
        if not entry.is_file() or entry.suffix.lower() != ".md":
            continue
        if is_sidecar_for_pdf(entry, pdf_path, files_root):
            return entry
    return None


def choose_new_sidecar_path(pdf_path: Path) -> Path:
    """Prefer stem.md; on collision with a human (or other) file, use stem.pdf.md (+n)."""
    parent = pdf_path.parent
    stem = pdf_path.stem
    preferred = parent / f"{stem}.md"
    if not preferred.exists():
        return preferred
    candidate = parent / f"{stem}.pdf.md"
    if not candidate.exists():
        return candidate
    n = 2
    while True:
        alt = parent / f"{stem}.pdf-{n}.md"
        if not alt.exists():
            return alt
        n += 1


def build_markdown(
    title: str,
    pdf_name: str,
    source_pdf: str,
    pdf_hash: str,
    body: str,
) -> str:
    ingested_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    escaped_title = title.replace('"', '\\"')
    return (
        "---\n"
        f'title: "{escaped_title}"\n'
        f"source_pdf: {source_pdf}\n"
        f"ingested_at: {ingested_at}\n"
        f"pdf_sha256: {pdf_hash}\n"
        "---\n\n"
        f"# {title}\n\n"
        f"_Extracted from `{pdf_name}` (PDF kept alongside this file)._\n\n"
        f"{body}\n"
    )


def should_skip_dir(path: Path) -> bool:
    return path.name in SKIP_DIR_NAMES or path.name.startswith(".")


def iter_pdfs(files_root: Path) -> list[Path]:
    results: list[Path] = []
    for dirpath, dirnames, filenames in os_walk_filtered(files_root):
        for name in sorted(filenames):
            if name.startswith("."):
                continue
            if not name.lower().endswith(".pdf"):
                continue
            results.append(Path(dirpath) / name)
    return results


def os_walk_filtered(root: Path):
    """os.walk that prunes skip dirs in-place."""
    import os

    for dirpath, dirnames, filenames in os.walk(root):
        # Prune in-place so os.walk does not descend.
        dirnames[:] = [d for d in dirnames if not should_skip_dir(Path(d))]
        yield dirpath, dirnames, filenames


def ingest_pdf(pdf_path: Path, files_root: Path) -> str:
    pdf_path = pdf_path.resolve()
    files_root = files_root.resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)
    if pdf_path.suffix.lower() != ".pdf":
        raise ValueError(f"not a PDF: {pdf_path}")
    try:
        rel = str(pdf_path.relative_to(files_root))
    except ValueError as err:
        raise ValueError(f"PDF outside files root: {pdf_path}") from err

    title = pdf_path.stem.replace("-", " ").replace("_", " ").strip() or "Document"

    existing = find_existing_sidecar(pdf_path, files_root)
    if existing is not None:
        # Fast path: if sidecar is newer than the PDF and already has a hash, skip
        # without re-reading the whole PDF (polls every 2 minutes across the tree).
        try:
            if existing.stat().st_mtime >= pdf_path.stat().st_mtime:
                existing_hash = read_frontmatter_field(
                    read_frontmatter_head(existing), "pdf_sha256"
                )
                if existing_hash and len(existing_hash) == 64:
                    return f"skip {rel} (unchanged → {existing.name})"
        except OSError:
            pass

    pdf_hash = sha256_file(pdf_path)

    if existing is not None:
        existing_hash = read_frontmatter_field(read_frontmatter_head(existing), "pdf_sha256")
        if existing_hash == pdf_hash:
            return f"skip {rel} (unchanged → {existing.name})"
        md_path = existing
        action = "updated"
    else:
        md_path = choose_new_sidecar_path(pdf_path)
        action = "ingested"

    body = extract_text(pdf_path)
    if len(body) < 20:
        raise RuntimeError(f"extracted text too short for {pdf_path.name}")

    md_path.write_text(
        build_markdown(title, pdf_path.name, rel, pdf_hash, body),
        encoding="utf-8",
    )
    try:
        md_rel = str(md_path.relative_to(files_root))
    except ValueError:
        md_rel = md_path.name
    return f"{action} {rel} -> {md_rel}"


def resolve_source_pdf(md_path: Path, source: str, files_root: Path) -> Path:
    """Resolve a sidecar's source_pdf value (files-root-relative or basename)."""
    if "/" in source or "\\" in source:
        return (files_root / source).resolve()
    return (md_path.parent / source).resolve()


def is_generated_sidecar(head: str) -> bool:
    """Generated sidecars carry both source_pdf and pdf_sha256 frontmatter."""
    return bool(
        head
        and "pdf_sha256:" in head
        and read_frontmatter_field(head, "source_pdf")
    )


def cleanup_orphan_sidecars(files_root: Path) -> list[str]:
    """Remove generated sidecars whose source PDF was deleted.

    Human-authored markdown (no source_pdf/pdf_sha256 frontmatter) is never touched.
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
            source = read_frontmatter_field(head, "source_pdf")
            if not source:
                continue
            pdf_path = resolve_source_pdf(md_path, source, files_root)
            if pdf_path.is_file():
                continue
            try:
                rel = str(md_path.resolve().relative_to(files_root.resolve()))
            except ValueError:
                rel = md_path.name
            try:
                md_path.unlink()
                results.append(f"removed {rel} (source PDF gone: {source})")
            except OSError as err:
                results.append(f"error {rel}: cleanup failed: {err}")
    return results


def scan_files_root(files_root: Path) -> list[str]:
    if not files_root.is_dir():
        return []
    results: list[str] = []
    for pdf_path in iter_pdfs(files_root):
        try:
            results.append(ingest_pdf(pdf_path, files_root))
        except Exception as err:
            try:
                rel = str(pdf_path.resolve().relative_to(files_root.resolve()))
            except ValueError:
                rel = pdf_path.name
            results.append(f"error {rel}: {err}")
    results.extend(cleanup_orphan_sidecars(files_root))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Extract PDF text to sibling markdown under the ArozOS Desktop tree.",
    )
    parser.add_argument(
        "--root",
        "--files-root",
        dest="root",
        help="Scan root (JOSHU_DESKTOP_ROOT; --files-root kept as alias)",
    )
    parser.add_argument("--pdf", help="Single PDF path to ingest (must be under --root)")
    args = parser.parse_args()

    if not args.root:
        parser.error("--root is required")

    files_root = Path(args.root).resolve()

    if args.pdf:
        print(ingest_pdf(Path(args.pdf).resolve(), files_root))
        return 0

    lines = scan_files_root(files_root)
    if not lines:
        return 0
    for line in lines:
        print(line)
    return 0 if all(not line.startswith("error ") for line in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
