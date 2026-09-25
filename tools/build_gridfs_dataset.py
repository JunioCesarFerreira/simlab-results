#!/usr/bin/env python3
"""
Builds the publishable simulation dataset out of GridFS.

The database stores, per simulation, a full Cooja log (~7.4 MB average) and a
CSV of per-node metric samples (~1.5 MB). Together they are ~466 GB and 98% of
the database. Almost all of it is redundant:

* Every ``{"node": ...}`` line in the log is one metric sample, with all 21 key
  names repeated on every record.
* ``sim_result.csv`` holds exactly those same samples, permuted: grouped by
  node instead of chronological. Nothing else.

So the samples are extracted from the *log* — which additionally carries the
``[t_us=...] [Mote:N]`` prefix the CSV drops — and written to Parquet. The CSV
then holds nothing the Parquet does not, and is not carried over: sorting the
Parquet by ``node`` reproduces it row for row. What is left of the log (boot
banner, RPL parent changes, reachability probes) is kept verbatim, compressed.

Output, per experiment:

    metrics/<slug>.parquet   every metric sample, chronological, with the
                             simulation id, t_us and mote as columns
    logs/<slug>.tar.zst      the non-sample log lines, one member per simulation
    manifest.json            counts, byte sizes and SHA-256 per output file

Usage:
    python tools/build_gridfs_dataset.py --output ../simlab-dataset
    python tools/build_gridfs_dataset.py --output DIR --limit-experiments 2
    python tools/build_gridfs_dataset.py --output DIR --verify-fraction 1.0
"""

import argparse
import hashlib
import io
import json
import os
import random
import re
import sys
import tarfile
import time
from datetime import datetime, timezone
from pathlib import Path

import gridfs
import pyarrow as pa
import pyarrow.parquet as pq
import zstandard as zstd
from bson import ObjectId
from pymongo import MongoClient

SAMPLE_MARK = '{"node":'
# Two log generations are in the database: newer runs prefix every line with
# "[t_us=N] [Mote:M]", older ones with "[Mote:M]" alone. Both are matched, and
# a line with neither keeps nulls rather than being dropped.
PREFIX = re.compile(r"^(?:\[t_us=(\d+)\]\s*)?\[Mote:(\d+)\]\s*")

# Columns this tool injects; their type is known, so it is not inferred. A run
# whose logs carry no t_us would otherwise type the all-null column as string.
INJECTED = {"t_us": pa.uint64(), "mote": pa.uint64()}
INT64_MAX = 2**63 - 1
ZSTD_LEVEL = 12
ROWS_PER_GROUP = 200_000
PRESCAN_SIMS = 12
PRESCAN_ROWS = 5_000


def slugify(name, fallback):
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(name or "")).strip("-").lower()
    return (s[:60] or str(fallback))


def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.1f} {u}"
        n /= 1024
    return f"{n:.1f} PB"


def parse_log(raw: bytes):
    """Split a Cooja log into metric samples and everything else."""
    samples, residue = [], []
    for line in raw.decode("utf-8", "replace").splitlines(keepends=True):
        idx = line.find(SAMPLE_MARK)
        if idx < 0:
            residue.append(line)
            continue
        try:
            rec = json.loads(line[idx:])
        except json.JSONDecodeError:
            # A truncated or interleaved line is not a sample we can trust;
            # keep it verbatim so nothing is silently dropped.
            residue.append(line)
            continue
        m = PREFIX.match(line)
        rec["t_us"] = int(m.group(1)) if m and m.group(1) else None
        rec["mote"] = int(m.group(2)) if m and m.group(2) else None
        samples.append(rec)
    return samples, residue


def build_schema(samples, columns):
    """Types wide enough for the data, decided by what the value *is* rather
    than by the range one sample happens to span.

    Contiki emits its counters and latencies as C ``uint64``; an underflowed
    latency surfaces as ~1.8e19, which does not fit in int64. Typing every
    never-negative integer column as uint64 accommodates that by construction,
    so a simulation late in the run cannot overflow a type inferred from an
    early one. Columns that do go negative (rssi) are signed readings and stay
    int64 — an unsigned artifact cannot appear in them."""
    fields = [pa.field("simulation_id", pa.string())]
    for c in columns:
        if c in INJECTED:
            fields.append(pa.field(c, INJECTED[c]))
            continue
        vals = [r.get(c) for r in samples if r.get(c) is not None]
        if not vals:
            t = pa.string()
        elif any(isinstance(v, str) for v in vals):
            t = pa.string()
        elif any(isinstance(v, float) for v in vals):
            t = pa.float64()
        elif min(vals) < 0:
            t = pa.int64()
        else:
            t = pa.uint64()
        fields.append(pa.field(c, t))
    return pa.schema(fields)


def to_batch(rows, schema):
    arrays = []
    for field in schema:
        vals = [r.get(field.name) for r in rows]
        if field.type == pa.float64():
            vals = [None if v is None else float(v) for v in vals]
        elif field.type == pa.string():
            vals = [None if v is None else str(v) for v in vals]
        try:
            arrays.append(pa.array(vals, field.type))
        except (OverflowError, pa.ArrowInvalid) as exc:
            # Name the column and the value: a silent cast here would corrupt
            # the dataset the whole exercise exists to preserve.
            offenders = [v for v in vals if isinstance(v, int)
                         and not (0 <= v <= 2**64 - 1)][:3]
            raise RuntimeError(
                f"column {field.name!r} does not fit {field.type}: {offenders} ({exc})"
            ) from exc
    return pa.RecordBatch.from_arrays(arrays, schema=schema)


def reconstructs_csv(samples, csv_bytes, columns) -> bool:
    """The claim that lets the CSV be dropped: sorting the samples by node,
    stable, reproduces it exactly."""
    import csv as csvmod

    rows = list(csvmod.DictReader(io.StringIO(csv_bytes.decode("utf-8", "replace"))))
    if len(rows) != len(samples):
        return False
    order, seen = {}, 0
    for r in rows:
        if r["node"] not in order:
            order[r["node"]] = seen
            seen += 1
    idx = sorted(range(len(samples)),
                 key=lambda i: (order.get(samples[i].get("node"), 1 << 30), i))
    for k, i in enumerate(idx):
        for c in columns:
            a, b = samples[i].get(c), rows[k][c]
            if str(a) == b:
                continue
            try:
                if float(a) == float(b):
                    continue
            except (TypeError, ValueError):
                pass
            return False
    return True


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--uri", default=os.getenv(
        "MONGO_URI", "mongodb://localhost:27017/?directConnection=true"))
    ap.add_argument("--db", default=os.getenv("DB_NAME", "simlab"))
    ap.add_argument("--output", required=True)
    ap.add_argument("--limit-experiments", type=int)
    ap.add_argument("--limit-simulations", type=int,
                    help="Per experiment; for smoke tests")
    ap.add_argument("--verify-fraction", type=float, default=0.02,
                    help="Share of simulations whose CSV is checked against the "
                         "extracted samples (default 0.02; 1.0 checks all)")
    ap.add_argument("--seed", type=int, default=20260925)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    out = Path(args.output)
    (out / "metrics").mkdir(parents=True, exist_ok=True)
    (out / "logs").mkdir(parents=True, exist_ok=True)

    client = MongoClient(args.uri, serverSelectionTimeoutMS=10000)
    db = client[args.db]
    fs = gridfs.GridFS(db)

    manifest_path = out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "built_at": None, "database": args.db, "experiments": {},
    }

    experiments = list(db.experiments.find({}, {"_id": 1, "name": 1}).sort("_id", 1))
    if args.limit_experiments:
        experiments = experiments[:args.limit_experiments]

    t_start = time.time()
    src_total = out_total = 0
    verified = verify_failed = 0

    for n, exp in enumerate(experiments, 1):
        exp_id = exp["_id"]
        slug = slugify(exp.get("name"), exp_id)
        key = f"{slug}_{exp_id}"
        if key in manifest["experiments"]:
            print(f"  [{n}/{len(experiments)}] {slug}: already built, skipping", flush=True)
            continue

        query = {"experiment_id": exp_id, "log_cooja_id": {"$ne": None}}
        sims = list(db.simulations.find(query, {"_id": 1, "log_cooja_id": 1,
                                                "csv_log_id": 1}).sort("_id", 1))
        if args.limit_simulations:
            sims = sims[:args.limit_simulations]
        if not sims:
            print(f"  [{n}/{len(experiments)}] {slug}: no logs, skipping", flush=True)
            continue

        pq_path = out / "metrics" / f"{key}.parquet"
        tar_path = out / "logs" / f"{key}.tar.zst"
        # Types are inferred from a handful of simulations, not from whichever
        # one happens to be read first.
        prescan = []
        for probe in sims[:PRESCAN_SIMS]:
            try:
                probe_samples, _ = parse_log(fs.get(ObjectId(probe["log_cooja_id"])).read())
            except Exception:  # noqa: BLE001 - inference only; the real read reports
                continue
            prescan.extend(probe_samples[:PRESCAN_ROWS])

        writer = None
        schema = None
        columns = None
        pending = []
        rows_written = src_bytes = 0
        cctx = zstd.ZstdCompressor(level=ZSTD_LEVEL)

        with open(tar_path, "wb") as raw_out, cctx.stream_writer(raw_out) as zf, \
                tarfile.open(fileobj=zf, mode="w|") as tar:
            for s in sims:
                try:
                    log_bytes = fs.get(ObjectId(s["log_cooja_id"])).read()
                except Exception as exc:  # noqa: BLE001
                    print(f"    ! {s['_id']}: log unreadable: {exc}", file=sys.stderr)
                    continue
                src_bytes += len(log_bytes)
                samples, residue = parse_log(log_bytes)

                if schema is None and samples:
                    columns = [k for k in samples[0] if k not in ("t_us", "mote")]
                    columns = ["t_us", "mote"] + columns
                    schema = build_schema(prescan or samples, columns)
                    writer = pq.ParquetWriter(
                        pq_path, schema, compression="zstd", compression_level=9,
                        use_dictionary=["node", "simulation_id"], version="2.6",
                        column_encoding={f.name: "DELTA_BINARY_PACKED" for f in schema
                                         if str(f.type).startswith(("int", "uint"))},
                        use_byte_stream_split=[f.name for f in schema
                                               if f.type == pa.float64()],
                    )

                if samples and s.get("csv_log_id") and rng.random() < args.verify_fraction:
                    try:
                        csv_bytes = fs.get(ObjectId(s["csv_log_id"])).read()
                        src_bytes += len(csv_bytes)
                        if reconstructs_csv(samples, csv_bytes,
                                            [c for c in columns if c not in ("t_us", "mote")]):
                            verified += 1
                        else:
                            verify_failed += 1
                            print(f"    ! {s['_id']}: CSV does not reconstruct",
                                  file=sys.stderr)
                    except Exception as exc:  # noqa: BLE001
                        print(f"    ! {s['_id']}: CSV check failed: {exc}", file=sys.stderr)

                sid = str(s["_id"])
                for r in samples:
                    r["simulation_id"] = sid
                pending.extend(samples)
                while len(pending) >= ROWS_PER_GROUP:
                    writer.write_batch(to_batch(pending[:ROWS_PER_GROUP], schema))
                    rows_written += ROWS_PER_GROUP
                    pending = pending[ROWS_PER_GROUP:]

                if residue:
                    blob = "".join(residue).encode("utf-8")
                    info = tarfile.TarInfo(name=f"{sid}.log")
                    info.size = len(blob)
                    info.mtime = 0
                    tar.addfile(info, io.BytesIO(blob))

            if pending and writer is not None:
                writer.write_batch(to_batch(pending, schema))
                rows_written += len(pending)
        if writer is not None:
            writer.close()

        entry = {
            "experiment_id": str(exp_id),
            "name": exp.get("name"),
            "simulations": len(sims),
            "metric_rows": rows_written,
            "source_bytes": src_bytes,
            "parquet": {"path": f"metrics/{key}.parquet",
                        "bytes": pq_path.stat().st_size if pq_path.exists() else 0},
            "logs": {"path": f"logs/{key}.tar.zst", "bytes": tar_path.stat().st_size},
        }
        entry["parquet"]["sha256"] = sha256_of(pq_path) if pq_path.exists() else None
        entry["logs"]["sha256"] = sha256_of(tar_path)
        produced = entry["parquet"]["bytes"] + entry["logs"]["bytes"]
        entry["ratio"] = round(src_bytes / produced, 1) if produced else None
        manifest["experiments"][key] = entry
        manifest["built_at"] = datetime.now(timezone.utc).isoformat()
        manifest_path.write_text(json.dumps(manifest, indent=2))

        src_total += src_bytes
        out_total += produced
        rate = src_total / max(time.time() - t_start, 1e-9)
        print(f"  [{n}/{len(experiments)}] {slug}: {len(sims)} sims, "
              f"{rows_written:,} rows, {human(src_bytes)} -> {human(produced)} "
              f"({entry['ratio']}x) | {human(rate)}/s", flush=True)

    elapsed = time.time() - t_start
    print(f"\nread {human(src_total)} -> wrote {human(out_total)}"
          + (f"  ({src_total / out_total:.0f}x)" if out_total else ""))
    print(f"elapsed {elapsed / 60:.1f} min"
          + (f" | {human(src_total / elapsed)}/s" if elapsed else ""))
    print(f"CSV reconstruction checks: {verified} passed, {verify_failed} failed")
    client.close()
    return 1 if verify_failed else 0


if __name__ == "__main__":
    sys.exit(main())
