#!/usr/bin/env python3
"""
Captures the reference data that ``build_archive.py`` does not cover.

``util/export_experiments.py`` walks outward from each experiment, so it picks
up generations, individuals, simulations, the genome cache and campaigns. Two
collections are not reachable that way and are not embedded in the experiment
documents either:

``problems``
    The saved problem definitions from the editor. An experiment embeds a
    *snapshot* of its problem under ``parameters.problem``, so runs stay
    readable without these — but the reusable definitions, their drafts and
    their background images live only here.

``sources``
    The Contiki-NG firmware repositories every simulation was built from. The
    experiment records only the repository id; the code itself is in GridFS.
    Without it there is no record of what the simulated nodes actually ran.

Both are tiny (~0.5 MB together), and both are lost when the database volume
is reclaimed. Firmware sources are written out as real files rather than
embedded strings so they stay readable and diffable.

Usage:
    python tools/export_reference.py [--uri URI] [--db DB] [--output DIR]
"""

import argparse
import base64
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import gridfs
from bson import ObjectId
from pymongo import MongoClient

# Sniffed from the bytes rather than read from GridOut.content_type, which
# PyMongo deprecates and which older records may not carry at all.
MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"<?xml", ".svg"),
    (b"<svg", ".svg"),
)


def image_ext(data: bytes) -> str:
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    for prefix, ext in MAGIC:
        if data.startswith(prefix):
            return ext
    return ".bin"


def bson_default(obj):
    if type(obj).__name__ in ("ObjectId", "Decimal128", "Int64", "Int32"):
        return str(obj)
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, bytes):
        return {"$binary": base64.b64encode(obj).decode("ascii")}
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def safe(name: str) -> str:
    """A filename that survives every filesystem and a git checkout."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "unnamed")).strip("-.")
    return cleaned or "unnamed"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--uri", default=os.getenv(
        "MONGO_URI", "mongodb://localhost:27017/?directConnection=true"))
    parser.add_argument("--db", default=os.getenv("DB_NAME", "simlab"))
    parser.add_argument("--output", default="reference")
    args = parser.parse_args()

    client = MongoClient(args.uri, serverSelectionTimeoutMS=10000)
    try:
        db = client[args.db]
        fs = gridfs.GridFS(db)
        out = Path(args.output)
        (out / "sources").mkdir(parents=True, exist_ok=True)
        (out / "problems").mkdir(parents=True, exist_ok=True)

        # ---- sources: firmware, written out as the files they are ----------
        sources = list(db.sources.find())
        written = 0
        for src in sources:
            folder = out / "sources" / safe(src.get("name") or src["_id"])
            folder.mkdir(parents=True, exist_ok=True)
            here = 0
            for entry in src.get("source_files") or []:
                fid = entry.get("id")
                fname = safe(entry.get("file_name") or fid)
                if not fid:
                    continue
                try:
                    data = fs.get(ObjectId(fid)).read()
                except Exception as exc:  # noqa: BLE001 - report, keep going
                    print(f"  ! {src.get('name')}/{fname}: {exc}", file=sys.stderr)
                    continue
                (folder / fname).write_bytes(data)
                here += 1
            written += here
            print(f"  sources/{folder.name}: {here} file(s)")

        (out / "sources.json").write_text(
            json.dumps(sources, default=bson_default, ensure_ascii=False, indent=2),
            encoding="utf-8")

        # ---- problems: definitions plus their background images ------------
        problems = list(db.problems.find())
        images = 0
        for prob in problems:
            bg = prob.get("background_image_id")
            if not bg:
                continue
            try:
                data = fs.get(ObjectId(bg)).read()
                target = out / "problems" / f"{safe(prob.get('name'))}-background{image_ext(data)}"
                target.write_bytes(data)
                images += 1
                print(f"  problems/{target.name}: {target.stat().st_size / 1024:.0f} KB")
            except Exception as exc:  # noqa: BLE001
                print(f"  ! background of {prob.get('name')}: {exc}", file=sys.stderr)

        (out / "problems.json").write_text(
            json.dumps(problems, default=bson_default, ensure_ascii=False, indent=2),
            encoding="utf-8")

        (out / "manifest.json").write_text(json.dumps({
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "database": args.db,
            "problems": len(problems),
            "sources": len(sources),
            "source_files": written,
            "background_images": images,
        }, indent=2), encoding="utf-8")

        print(f"\n{len(problems)} problem(s), {len(sources)} source repo(s), "
              f"{written} firmware file(s), {images} image(s) -> {out}/")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
