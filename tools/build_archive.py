#!/usr/bin/env python3
"""
Builds the published archive from a SimLab MongoDB export.

Input is the directory produced by ``util/export_experiments.py`` in the main
simlab repository: one JSON file per experiment, ~805 MB in total.

Two outputs are written, with different jobs:

``raw/<name>.json.gz``
    The export, gzipped, byte-for-byte recoverable. This is the preservation
    copy — every document the database held for that experiment, including the
    per-simulation Cooja parameters and DODAG trees. ~66 MB for all 51.

``data/``
    What the web viewer reads. Split so a page loads one small file instead of
    a 100 MB one, and rounded to the precision the charts actually use:

    index.json              one summary row per experiment       (~60 KB)
    exp/<id>/core.json      generations, objectives, pareto,
                            per-simulation network metrics       (median 0.3 MB)
    exp/<id>/chromosomes.json  relay coordinates for the topology view

Usage:
    python tools/build_archive.py --input ../simlab/experiments_export
"""

import argparse
import glob
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

# Coordinates and objectives are stored at full float64 in Mongo
# (-13.203721577336898). Nothing in the viewer resolves past these.
GEOMETRY_DECIMALS = 2
OBJECTIVE_DECIMALS = 6
METRIC_DECIMALS = 3


def round_floats(obj, decimals: int):
    if isinstance(obj, float):
        return round(obj, decimals)
    if isinstance(obj, dict):
        return {k: round_floats(v, decimals) for k, v in obj.items()}
    if isinstance(obj, list):
        return [round_floats(v, decimals) for v in obj]
    return obj


def compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def write_json(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = compact(obj).encode("utf-8")
    path.write_bytes(payload)
    return len(payload)


def experiment_summary(exp: dict, counts: dict, file_stem: str) -> dict:
    params = exp.get("parameters") or {}
    algorithm = params.get("algorithm") or {}
    problem = params.get("problem") or {}
    objectives = params.get("objectives") or []
    return {
        "id": str(exp.get("_id")),
        "name": exp.get("name"),
        "status": exp.get("status"),
        "created_time": exp.get("created_time"),
        "start_time": exp.get("start_time"),
        "end_time": exp.get("end_time"),
        "strategy": params.get("strategy"),
        "problem_name": problem.get("name"),
        "objectives": [
            {"name": o.get("metric_name"), "goal": o.get("goal")} for o in objectives
        ],
        "population_size": algorithm.get("population_size"),
        "generations_planned": algorithm.get("number_of_generations"),
        "random_seed": algorithm.get("random_seed"),
        "counts": counts,
        "raw_file": f"{file_stem}.json.gz",
    }


def build_core(bundle: dict) -> dict:
    """Everything the charts need, and nothing else."""
    exp = dict(bundle["experiment"])
    pareto = exp.pop("pareto_front", None) or []

    individuals = [
        {
            "gen": str(i.get("generation_id")),
            "iid": i.get("individual_id"),
            "obj": round_floats(i.get("objectives"), OBJECTIVE_DECIMALS),
        }
        for i in bundle.get("individuals", [])
    ]

    simulations = [
        {
            "id": str(s.get("_id")),
            "gen": str(s.get("generation_id")),
            "iid": s.get("individual_id"),
            "seed": s.get("random_seed"),
            "status": s.get("status"),
            "metrics": round_floats(s.get("network_metrics") or {}, METRIC_DECIMALS),
        }
        for s in bundle.get("simulations", [])
    ]

    generations = [
        {
            "id": str(g.get("_id")),
            "index": g.get("index"),
            "status": g.get("status"),
            "start_time": g.get("start_time"),
            "end_time": g.get("end_time"),
        }
        for g in bundle.get("generations", [])
    ]

    return {
        "experiment": round_floats(exp, GEOMETRY_DECIMALS),
        "generations": generations,
        "individuals": individuals,
        "simulations": simulations,
        "pareto": [
            {
                "obj": round_floats(p.get("objectives"), OBJECTIVE_DECIMALS),
                "chromosome": round_floats(p.get("chromosome"), GEOMETRY_DECIMALS),
            }
            for p in pareto
        ],
        "campaigns": [
            {"id": str(c.get("_id")), "name": c.get("name")}
            for c in bundle.get("campaigns", [])
        ],
    }


def build_chromosomes(bundle: dict) -> list:
    return [
        {
            "gen": str(i.get("generation_id")),
            "iid": i.get("individual_id"),
            "chromosome": round_floats(i.get("chromosome"), GEOMETRY_DECIMALS),
        }
        for i in bundle.get("individuals", [])
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--input", required=True,
                        help="Directory produced by util/export_experiments.py")
    parser.add_argument("--output", default=".",
                        help="Archive root (default: the repository root)")
    parser.add_argument("--skip-raw", action="store_true",
                        help="Only rebuild data/, leaving raw/ untouched")
    args = parser.parse_args()

    src = Path(args.input)
    root = Path(args.output)
    raw_dir, data_dir = root / "raw", root / "data"

    files = sorted(f for f in glob.glob(str(src / "*.json"))
                   if os.path.basename(f) != "index.json")
    if not files:
        print(f"No experiment files in {src}", file=sys.stderr)
        return 1

    if data_dir.exists():
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True)
    if not args.skip_raw:
        raw_dir.mkdir(parents=True, exist_ok=True)

    built_at = datetime.now(timezone.utc).isoformat()
    summaries, raw_bytes, data_bytes = [], 0, 0

    for n, path in enumerate(files, start=1):
        stem = Path(path).stem
        with open(path, encoding="utf-8") as f:
            bundle = json.load(f)

        exp_id = str(bundle["experiment"]["_id"])
        counts = {
            "generations": len(bundle.get("generations", [])),
            "individuals": len(bundle.get("individuals", [])),
            "simulations": len(bundle.get("simulations", [])),
        }

        if not args.skip_raw:
            gz_path = raw_dir / f"{stem}.json.gz"
            source = Path(path).read_bytes()
            with gzip.open(gz_path, "wb", compresslevel=9) as out:
                out.write(source)
            # The preservation copy is only worth anything if it reads back
            # identical to what came out of the database.
            with gzip.open(gz_path, "rb") as check:
                if hashlib.sha256(check.read()).hexdigest() != \
                   hashlib.sha256(source).hexdigest():
                    print(f"  ! {stem}: gzip round-trip mismatch", file=sys.stderr)
                    return 1
            raw_bytes += gz_path.stat().st_size

        core = build_core(bundle)
        data_bytes += write_json(data_dir / "exp" / exp_id / "core.json", core)
        data_bytes += write_json(data_dir / "exp" / exp_id / "chromosomes.json",
                                 build_chromosomes(bundle))

        summaries.append(experiment_summary(bundle["experiment"], counts, stem))
        print(f"  [{n}/{len(files)}] {summaries[-1]['name']}"
              f"  gens={counts['generations']} inds={counts['individuals']}"
              f" sims={counts['simulations']}")

    index = {
        "built_at": built_at,
        "experiment_count": len(summaries),
        "experiments": summaries,
    }
    data_bytes += write_json(data_dir / "index.json", index)

    print(f"\nraw/   {raw_bytes / 1048576:7.1f} MB   (lossless, gzip -9)")
    print(f"data/  {data_bytes / 1048576:7.1f} MB   ({len(summaries)} experiments)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
