#!/usr/bin/env python3
"""Print the seed hashes of the factory Hermes skills tree.

Usage: hermes-skills-seed-key.py <skills dir>

Output, one line per factory skill folder (a folder with SKILL.md):
  <skill dir relative to the skills dir>\t<sha256 of the folder files>
and a last line with the seed key of the whole tree:
  *\tsha256:<first 16 hex of the tree hash>

bootstrap-hermes-learning-skills.sh compares the seed key with the box stamp.
A change to any file in the skills tree changes the seed key.
"""
import hashlib
import sys
from pathlib import Path


def folder_hash(folder: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(p for p in folder.rglob("*") if p.is_file()):
        rel = path.relative_to(folder).as_posix()
        h.update(rel.encode("utf-8") + b"\0")
        h.update(hashlib.sha256(path.read_bytes()).hexdigest().encode("ascii") + b"\n")
    return h.hexdigest()


def main() -> int:
    root = Path(sys.argv[1])
    skill_dirs = sorted({p.parent for p in root.rglob("SKILL.md")})
    tree = hashlib.sha256()
    for folder in skill_dirs:
        rel = folder.relative_to(root).as_posix()
        digest = folder_hash(folder)
        print(f"{rel}\t{digest}")
        tree.update(f"{rel}\t{digest}\n".encode("utf-8"))
    print(f"*\tsha256:{tree.hexdigest()[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
