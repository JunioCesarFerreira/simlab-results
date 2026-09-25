#!/usr/bin/env python3
"""
Uploads the simulation dataset to Zenodo as a draft deposition.

A 10-20 GB browser upload is a long single point of failure; this does the same
thing over the API, one file at a time, verifying each one after it lands.

The script deliberately stops **before** publishing. A published Zenodo record
cannot be deleted and its files cannot be changed, so the last step stays a
deliberate human action — either in the web interface, or by re-running with
``--publish``.

Usage:
    export ZENODO_TOKEN=...
    python tools/zenodo_upload.py --dataset ../simlab-dataset \
        --metadata docs/zenodo-metadata.json --sandbox

Requires ``requests`` (pip install requests).
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import requests

LIVE = "https://zenodo.org/api"
SANDBOX = "https://sandbox.zenodo.org/api"
CHUNK = 1 << 20


def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} PB"


def md5_of(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(dataset: Path):
    """Every file to upload, as (published name, path). Directories are flattened
    into the name because Zenodo stores a flat file list per record."""
    files = []
    for p in sorted(dataset.rglob("*")):
        if not p.is_file() or p.name == "build.log":
            continue
        files.append((str(p.relative_to(dataset)).replace(os.sep, "/"), p))
    return files


def die(msg, response=None):
    print(f"error: {msg}", file=sys.stderr)
    if response is not None:
        print(f"  HTTP {response.status_code}: {response.text[:400]}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", required=True, help="Directory to upload")
    ap.add_argument("--metadata", required=True, help="JSON file, see docs/zenodo-metadata.json")
    ap.add_argument("--sandbox", action="store_true",
                    help="Use sandbox.zenodo.org — do this first")
    ap.add_argument("--deposition", type=int,
                    help="Add to an existing draft instead of creating one")
    ap.add_argument("--publish", action="store_true",
                    help="Publish after uploading. Irreversible: the record and "
                         "its files can never be deleted or changed afterwards.")
    args = ap.parse_args()

    token = os.getenv("ZENODO_TOKEN")
    if not token:
        die("ZENODO_TOKEN is not set")

    base = SANDBOX if args.sandbox else LIVE
    dataset = Path(args.dataset)
    if not dataset.is_dir():
        die(f"{dataset} is not a directory")
    metadata = json.loads(Path(args.metadata).read_text())

    files = collect(dataset)
    if not files:
        die(f"no files under {dataset}")
    total = sum(p.stat().st_size for _, p in files)
    print(f"{'SANDBOX' if args.sandbox else 'LIVE'}  {len(files)} file(s), {human(total)}")

    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {token}"

    # --- deposition -------------------------------------------------------
    if args.deposition:
        r = session.get(f"{base}/deposit/depositions/{args.deposition}")
        if r.status_code != 200:
            die(f"cannot open deposition {args.deposition}", r)
        dep = r.json()
    else:
        r = session.post(f"{base}/deposit/depositions", json={})
        if r.status_code not in (200, 201):
            die("could not create the deposition", r)
        dep = r.json()
    dep_id = dep["id"]
    bucket = dep["links"]["bucket"]
    print(f"deposition {dep_id}  →  {dep['links'].get('html', '(no link)')}")

    # --- metadata ---------------------------------------------------------
    r = session.put(f"{base}/deposit/depositions/{dep_id}",
                    json={"metadata": metadata})
    if r.status_code != 200:
        die("metadata rejected", r)
    print("metadata accepted")

    # --- files ------------------------------------------------------------
    already = {f["filename"] for f in dep.get("files", [])}
    done = 0
    for name, path in files:
        size = path.stat().st_size
        if name in already:
            print(f"  = {name} already uploaded, skipping")
            continue
        local_md5 = md5_of(path)
        with open(path, "rb") as fh:
            r = session.put(f"{bucket}/{name}", data=fh)
        if r.status_code not in (200, 201):
            die(f"upload of {name} failed", r)
        remote = r.json().get("checksum", "")
        if remote.removeprefix("md5:") != local_md5:
            die(f"{name}: checksum mismatch — Zenodo reports {remote}, local md5 is {local_md5}")
        done += size
        print(f"  + {name}  {human(size)}  verified  ({human(done)}/{human(total)})")

    print(f"\nUploaded {human(done)} to draft {dep_id}.")

    if args.publish:
        r = session.post(f"{base}/deposit/depositions/{dep_id}/actions/publish")
        if r.status_code not in (200, 202):
            die("publish failed", r)
        out = r.json()
        print(f"PUBLISHED  DOI {out.get('doi')}  {out['links'].get('html','')}")
        print("The concept DOI (always newest version) is on the record page.")
    else:
        print("Not published. Review the draft, then publish from the web "
              "interface or re-run with --publish.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
