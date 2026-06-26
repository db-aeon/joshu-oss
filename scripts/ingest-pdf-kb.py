#!/usr/bin/env python3
"""
Ingest PDFs from research/kb/inbox/ into searchable markdown under research/kb/.

Text PDFs: pdftotext (poppler) when available, else pypdf. No LLM required.
Originals move to research/kb/.raw/ after successful ingest.
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


def slugify(stem: str) -> str:
    slug = stem.strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug or "document"


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


def extract_text(pdf_path: Path) -> str:
    for extractor in (extract_with_pdftotext, extract_with_pypdf):
        text = extractor(pdf_path)
        if text:
            return text
    raise RuntimeError(
        "could not extract text (install poppler-utils/pdftotext or: pip install pypdf)",
    )


def read_existing_hash(md_path: Path) -> str | None:
    if not md_path.is_file():
        return None
    try:
        head = md_path.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return None
    match = re.search(r"^pdf_sha256:\s*([a-f0-9]{64})\s*$", head, re.MULTILINE)
    return match.group(1) if match else None


def build_markdown(title: str, pdf_name: str, raw_name: str, pdf_hash: str, body: str) -> str:
    ingested_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    escaped_title = title.replace('"', '\\"')
    return (
        "---\n"
        f'title: "{escaped_title}"\n'
        f"source_pdf: {raw_name}\n"
        f"ingested_at: {ingested_at}\n"
        f"pdf_sha256: {pdf_hash}\n"
        "---\n\n"
        f"# {title}\n\n"
        f"_Imported from `{pdf_name}`._\n\n"
        f"{body}\n"
    )


def unique_raw_path(raw_dir: Path, filename: str) -> Path:
    candidate = raw_dir / filename
    if not candidate.exists():
        return candidate
    stem = Path(filename).stem
    suffix = Path(filename).suffix
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return raw_dir / f"{stem}-{stamp}{suffix}"


def ingest_pdf(pdf_path: Path, kb_root: Path, raw_dir: Path) -> str:
    pdf_path = pdf_path.resolve()
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)
    if pdf_path.suffix.lower() != ".pdf":
        raise ValueError(f"not a PDF: {pdf_path}")

    kb_root.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    pdf_hash = sha256_file(pdf_path)
    title = pdf_path.stem.replace("-", " ").replace("_", " ").strip() or "Document"
    slug = slugify(pdf_path.stem)
    md_path = kb_root / f"{slug}.md"

    existing_hash = read_existing_hash(md_path)
    if existing_hash == pdf_hash:
        # Already ingested — remove duplicate drop from inbox so the watcher stops retrying.
        if pdf_path.parent.resolve() == (kb_root / "inbox").resolve():
            pdf_path.unlink(missing_ok=True)
        return f"skip {pdf_path.name} (unchanged)"

    body = extract_text(pdf_path)
    if len(body) < 20:
        raise RuntimeError(f"extracted text too short for {pdf_path.name}")

    raw_target = unique_raw_path(raw_dir, pdf_path.name)
    shutil.move(str(pdf_path), str(raw_target))

    raw_rel = f".raw/{raw_target.name}"
    md_path.write_text(
        build_markdown(title, pdf_path.name, raw_rel, pdf_hash, body),
        encoding="utf-8",
    )
    return f"ingested {pdf_path.name} -> research/kb/{md_path.name}"


def scan_inbox(inbox: Path, kb_root: Path, raw_dir: Path) -> list[str]:
    if not inbox.is_dir():
        return []
    results: list[str] = []
    for entry in sorted(inbox.iterdir()):
        if not entry.is_file():
            continue
        if entry.name.startswith("."):
            continue
        if entry.suffix.lower() != ".pdf":
            continue
        try:
            results.append(ingest_pdf(entry, kb_root, raw_dir))
        except Exception as err:
            results.append(f"error {entry.name}: {err}")
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description="Ingest KB PDFs to markdown for gbrain.")
    parser.add_argument("--files-root", help="JOSHU_FILES_ROOT (parent of research/kb/)")
    parser.add_argument("--pdf", help="Single PDF path to ingest")
    parser.add_argument("--inbox", help="Inbox directory (default: <files-root>/research/kb/inbox)")
    args = parser.parse_args()

    files_root = Path(args.files_root).resolve() if args.files_root else None
    kb_root = (files_root / "research" / "kb") if files_root else None
    inbox = Path(args.inbox).resolve() if args.inbox else (kb_root / "inbox" if kb_root else None)
    raw_dir = (kb_root / ".raw") if kb_root else None

    if args.pdf:
        if not kb_root or not raw_dir:
            parser.error("--files-root is required with --pdf")
        print(ingest_pdf(Path(args.pdf).resolve(), kb_root, raw_dir))
        return 0

    if not inbox or not kb_root or not raw_dir:
        parser.error("--files-root or --inbox is required")

    lines = scan_inbox(inbox, kb_root, raw_dir)
    if not lines:
        return 0
    for line in lines:
        print(line)
    return 0 if all(not line.startswith("error ") for line in lines) else 1


if __name__ == "__main__":
    sys.exit(main())
