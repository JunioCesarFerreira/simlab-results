#!/usr/bin/env python3
"""
Precomputes the quality indicators the viewer shows: hypervolume, generational
distance, inverted generational distance and its Pareto-compliant variant
IGD+, per generation and per run.

They are computed here, once, rather than in the browser: IGD against a
reference front is O(|R| x |A|) per generation, and the archive has 1 153
generations.

The definitions follow the platform's own ``pylib/moo_metrics.py`` — the p = 1
mean for GD and IGD, the d+ of Ishibuchi et al. (2015) for IGD+, normalisation
by the reference front's ideal-nadir range — so a number here and the same
number in the live GUI mean the same thing. ``tools/check_parity.py`` holds that
claim to moocore, the library the platform computes with.

Each generation is measured on the non-dominated subset of the **survivor
set** P_t — the population environmental selection kept, which is what the
search carries forward and what the live GUI plots. Only 6 of the 51 archived
runs recorded it; the other 45 predate the field and fall back to their
offspring Q_t, the individuals that generation evaluated. Every generation
records which set it used, and the run reports ``population_source``:
``survivors``, ``offspring``, or ``mixed`` for a series that is neither.

The viewer only plots numbers.

Input is the built ``data/`` directory; output goes back into it:

    data/groups.json            one reference front per comparable group,
                                its ideal/nadir box, and every run's final
                                indicators — the cross-run comparison
    data/exp/<id>/metrics.json  per-generation indicators for that run
    data/index.json             gains ``group`` and final ``metrics`` per row

Method
------
Runs are comparable only within a *group*: same problem, same objectives, same
directions. Indicators are meaningless across groups and are never mixed.

No analytical Pareto front exists for these problems — the objectives come out
of a Cooja simulation — so each group's reference front is the non-dominated
set of every feasible point every run in that group ever evaluated. This is
the usual substitute, and it has the usual caveat: it flatters a group whose
runs all converge to the same wrong place, because then that place *is* the
reference. It is a comparison between these runs, not a distance to the truth.

Objectives being maximised are negated, so everything below is minimisation.
Each objective is then scaled to [0, 1] over the reference front's own range
(its ideal and nadir), which puts latency in ms and energy in mJ on one
footing and makes the hypervolume of different groups the same kind of number.
Hypervolume uses the reference point 1.1 in every normalised objective, the
common choice: far enough outside the front that an extreme solution still
earns volume for being extreme.

Usage:
    python tools/compute_metrics.py            # over ./data
    python tools/compute_metrics.py --root ..  # over another archive root
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from moo_metrics import (  # noqa: E402
    generational_distance,
    hypervolume,
    inverted_generational_distance,
    inverted_generational_distance_plus,
    nondominated,
    normalise,
    thin_front,
)

# Infeasible individuals are scored with a large penalty (~1.01e9) in every
# objective, negated where the objective is maximised. They are not points in
# objective space and would wreck every indicator; they are dropped, and their
# count is reported instead.
PENALTY_THRESHOLD = 1e8

# The reference point for the hypervolume, in normalised objectives.
HV_REF = 1.1

# Reference fronts run to thousands of points (SCH1's front is a curve: almost
# everything evaluated on it is non-dominated). IGD against all of them would
# dominate the build, and adds nothing: farthest-point thinning keeps the
# extremes and the spread.
REFERENCE_CAP = 500

DECIMALS = 6


def is_feasible(values):
    return bool(values) and all(abs(v) < PENALTY_THRESHOLD for v in values)


def as_list(objectives, names):
    """Objectives are an array on individuals, a name-keyed object on the
    Pareto front. The same run holds both forms."""
    if objectives is None:
        return None
    if isinstance(objectives, dict):
        if any(n not in objectives for n in names):
            return None
        return [objectives[n] for n in names]
    return list(objectives)


def group_key(row):
    objs = ",".join(f"{o['name']}:{o['goal']}" for o in row["objectives"])
    return f"{row['problem_name']}|{objs}"


def rnd(v):
    return None if v is None else round(v, DECIMALS)


def load_group_points(experiments, cores, signs, names):
    """Every feasible point any run in the group evaluated, in min-space."""
    points = set()
    for row in experiments:
        core = cores[row["id"]]
        for ind in core["individuals"]:
            values = as_list(ind.get("obj"), names)
            if is_feasible(values):
                points.add(tuple(s * v for s, v in zip(signs, values)))
        for p in core["pareto"]:
            values = as_list(p.get("obj"), names)
            if is_feasible(values):
                points.add(tuple(s * v for s, v in zip(signs, values)))
    return points


def run_fronts(core, signs, names):
    """(final front, [generation records], unresolved survivor count) in
    min-space.

    Each generation is measured on the **survivor set** P_t where the run
    recorded one: the population environmental selection kept, which is what
    the search carries forward and what the live GUI plots. Most survivors were
    evaluated in an *earlier* generation — 4 663 of 5 050 in the longest run —
    so they are resolved against every individual the run ever evaluated, not
    against the generation's own. Runs that predate the field fall back to
    their offspring Q_t, and each generation says which set it used.

    The final front is the recorded Pareto front where there is one, and the
    last generation's own front otherwise — a cancelled run never got to
    record a front.
    """
    order = {g["id"]: (g.get("index") if g.get("index") is not None else 0)
             for g in core["generations"]}

    # None marks an infeasible individual: it is still a member of the set, it
    # just contributes no point.
    by_hash = {}
    offspring = {}
    for ind in core["individuals"]:
        values = as_list(ind.get("obj"), names)
        point = (tuple(s * v for s, v in zip(signs, values))
                 if is_feasible(values) else None)
        if ind.get("iid") is not None:
            by_hash[ind["iid"]] = point
        index = order.get(ind.get("gen"))
        if index is not None:
            offspring.setdefault(index, []).append(point)

    generations, unresolved = [], 0
    for gen in sorted(core["generations"], key=lambda g: order[g["id"]]):
        index = order[gen["id"]]
        keep = gen.get("survivors")
        if keep:
            points = [by_hash[h] for h in keep if h in by_hash]
            unresolved += sum(1 for h in keep if h not in by_hash)
            source = "survivors"
        elif index in offspring:
            points = offspring[index]
            source = "offspring"
        else:
            continue
        feasible = [p for p in points if p is not None]
        generations.append({
            "index": index,
            "source": source,
            "feasible": len(feasible),
            "infeasible": len(points) - len(feasible),
            "front": nondominated(feasible),
        })

    final = [tuple(s * v for s, v in zip(signs, values))
             for values in (as_list(p.get("obj"), names) for p in core["pareto"])
             if is_feasible(values)]
    final = nondominated(final) if final else (
        generations[-1]["front"] if generations else [])
    return final, generations, unresolved


def indicators(front, ideal, spread, reference, ref_point, empty_hv=None):
    """The four indicators for one front.

    A generation in which nothing was feasible dominates no volume, so its
    hypervolume is 0 and the curve stays continuous; the distances are left
    null, which the chart draws as a gap rather than as the perfect convergence
    a zero would imply. ``empty_hv`` is None for a whole run, where "no front at
    all" is not the same statement as "a front worth zero".
    """
    if not front:
        return {"hv": empty_hv, "gd": None, "igd": None, "igd_plus": None,
                "front_size": 0}
    scaled = normalise(front, ideal, spread)
    return {
        "hv": rnd(hypervolume(scaled, ref_point)),
        "gd": rnd(generational_distance(scaled, reference)),
        "igd": rnd(inverted_generational_distance(scaled, reference)),
        "igd_plus": rnd(inverted_generational_distance_plus(scaled, reference)),
        "front_size": len(front),
    }


def build_metrics(root: Path) -> int:
    data = root / "data"
    index_path = data / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    rows = index["experiments"]

    grouped = {}
    for row in rows:
        grouped.setdefault(group_key(row), []).append(row)

    groups_out = []
    for key in sorted(grouped):
        members = grouped[key]
        objectives = members[0]["objectives"]
        names = [o["name"] for o in objectives]
        signs = [-1.0 if o["goal"] == "max" else 1.0 for o in objectives]

        cores = {row["id"]: json.loads((data / "exp" / row["id"] / "core.json")
                                       .read_text(encoding="utf-8"))
                 for row in members}

        print(f"{key}  ({len(members)} runs)")
        points = load_group_points(members, cores, signs, names)
        reference_full = nondominated(points)
        if not reference_full:
            print("  ! no feasible point in this group — skipped", file=sys.stderr)
            for row in members:
                row["group"] = key
                row["metrics"] = {"hv": None, "gd": None, "igd": None}
            continue

        ideal = [min(p[i] for p in reference_full) for i in range(len(names))]
        nadir = [max(p[i] for p in reference_full) for i in range(len(names))]
        # A degenerate objective (every run found the same value) would divide
        # by zero; scaling it by 1 leaves it at 0 everywhere, which is right.
        spread = [(hi - lo) or 1.0 for lo, hi in zip(ideal, nadir)]

        reference = thin_front(normalise(reference_full, ideal, spread), REFERENCE_CAP)
        ref_point = [HV_REF] * len(names)
        print(f"  reference front {len(reference_full)} points"
              f" -> {len(reference)} after thinning")

        finals = []
        for row in members:
            core = cores[row["id"]]
            final, generations, unresolved = run_fronts(core, signs, names)
            if unresolved:
                print(f"  ! {row['name']}: {unresolved} survivor hashes match no"
                      f" evaluated individual", file=sys.stderr)

            per_gen = [
                {
                    "index": g["index"],
                    "source": g["source"],
                    "feasible": g["feasible"],
                    "infeasible": g["infeasible"],
                    **indicators(g["front"], ideal, spread, reference, ref_point,
                                 empty_hv=0.0),
                }
                for g in generations
            ]
            # "mixed" is the GUI's word for a series that is not one set: it
            # must not be read as a survivor trajectory. A run with no
            # generation at all reports neither.
            used = {g["source"] for g in generations}
            population_source = (used.pop() if len(used) == 1 else "mixed") if used else None

            summary = indicators(final, ideal, spread, reference, ref_point)
            out = {
                "group": key,
                "objectives": objectives,
                "hv_reference_point": HV_REF,
                "reference_front_size": len(reference),
                # What was asked for, and what could actually be used: the
                # survivor set P_t where the run recorded one, its offspring
                # Q_t where it did not. Same contract as the live GUI's
                # population / population_source pair.
                "population": "survivors",
                "population_source": population_source,
                "final": {**summary,
                          "source": "pareto_front" if core["pareto"] else "last_generation"},
                "generations": per_gen,
            }
            path = data / "exp" / row["id"] / "metrics.json"
            path.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False),
                            encoding="utf-8")

            row["group"] = key
            row["metrics"] = {k: summary[k] for k in ("hv", "gd", "igd")}
            finals.append({
                "id": row["id"],
                "name": row["name"],
                "strategy": row.get("strategy"),
                "status": row.get("status"),
                "generations": row["counts"]["generations"],
                **summary,
            })
            print(f"    {row['name'][:40]:<40} hv={summary['hv']}"
                  f" gd={summary['gd']} igd={summary['igd']}"
                  f" igd+={summary['igd_plus']}")

        groups_out.append({
            "key": key,
            "problem": members[0]["problem_name"],
            "objectives": [
                {
                    "name": o["name"],
                    "goal": o["goal"],
                    # In the objective's own units, for axis ranges: the best
                    # and worst value on the reference front, best first.
                    "best": rnd(s * (lo if s > 0 else hi)),
                    "worst": rnd(s * (hi if s > 0 else lo)),
                }
                for o, s, lo, hi in zip(objectives, signs, ideal, nadir)
            ],
            "ideal": [rnd(v) for v in ideal],
            "nadir": [rnd(v) for v in nadir],
            "hv_reference_point": HV_REF,
            "reference_front_total": len(reference_full),
            "reference_front_size": len(reference),
            "runs": sorted(finals, key=lambda r: (r["hv"] is None, -(r["hv"] or 0))),
        })

    index["metrics_built_at"] = datetime.now(timezone.utc).isoformat()
    index_path.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False),
                          encoding="utf-8")

    groups = {
        "built_at": index["metrics_built_at"],
        "penalty_threshold": PENALTY_THRESHOLD,
        "hv_reference_point": HV_REF,
        "reference_cap": REFERENCE_CAP,
        "groups": groups_out,
    }
    (data / "groups.json").write_text(
        json.dumps(groups, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"\ndata/groups.json  {len(groups_out)} groups, {len(rows)} runs")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=".", help="Archive root (default: .)")
    args = parser.parse_args()
    return build_metrics(Path(args.root))


if __name__ == "__main__":
    sys.exit(main())
