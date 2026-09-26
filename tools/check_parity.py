#!/usr/bin/env python3
"""
Checks ``tools/moo_metrics.py`` against moocore, the library the SimLab platform
computes its indicators with.

The archive tools carry their own pure-Python hypervolume, GD, IGD and IGD+ so
that ``data/`` can be rebuilt from nothing but a Python install, years from now,
with no wheels to resolve. That independence is only worth having if the numbers
are the same ones the platform reports, so this script holds them to it — on
random fronts and on the archive's own generations.

It needs numpy and moocore, which the archive deliberately does not, so it is a
development check rather than part of the build. In the simlab repository:

    ../simlab/.venv/bin/python tools/check_parity.py

Exit status 0 means every indicator agreed to within 1e-9.
"""

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import moo_metrics as mm  # noqa: E402

try:
    import numpy as np
    import moocore
except ImportError as exc:  # pragma: no cover - the whole point of the script
    print(f"needs numpy and moocore ({exc}); run it under a venv that has them,\n"
          f"e.g. ../simlab/.venv/bin/python {Path(__file__).name}", file=sys.stderr)
    raise SystemExit(2)

TOLERANCE = 1e-9


class Worst:
    """Largest disagreement seen for each indicator."""

    def __init__(self):
        self.gaps = {}
        self.cases = 0

    def note(self, name, mine, theirs):
        gap = abs(mine - theirs)
        if gap > self.gaps.get(name, (-1.0, None))[0]:
            self.gaps[name] = (gap, (mine, theirs))

    def report(self, title):
        print(f"{title} ({self.cases} cases)")
        ok = True
        for name in sorted(self.gaps):
            gap, (mine, theirs) = self.gaps[name]
            flag = "ok " if gap <= TOLERANCE else "FAIL"
            print(f"  {flag} {name:<5} max |difference| {gap:.3e}"
                  + ("" if gap <= TOLERANCE else f"   ({mine} vs {theirs})"))
            ok &= gap <= TOLERANCE
        return ok


def compare(worst, front, reference, hv_ref):
    a = np.asarray(front, dtype=float)
    r = np.asarray(reference, dtype=float)
    worst.cases += 1

    # moocore.hypervolume takes only the points that dominate the reference;
    # ours drops them itself, so the two are given the same set.
    dominating = a[np.all(a < np.asarray(hv_ref, dtype=float), axis=1)]
    theirs_hv = float(moocore.hypervolume(dominating, ref=hv_ref)) if len(dominating) else 0.0
    worst.note("hv", mm.hypervolume(front, hv_ref), theirs_hv)

    # GD is IGD with the two sets swapped — the platform's own note.
    worst.note("gd", mm.generational_distance(front, reference),
               float(moocore.igd(r, ref=a)))
    worst.note("igd", mm.inverted_generational_distance(front, reference),
               float(moocore.igd(a, ref=r)))
    worst.note("igd+", mm.inverted_generational_distance_plus(front, reference),
               float(moocore.igd_plus(a, ref=r)))

    mine_nd = set(mm.nondominated(front))
    theirs_nd = {tuple(row) for row in moocore.filter_dominated(a).tolist()}
    worst.note("nd", 0.0, 0.0 if mine_nd == theirs_nd else 1.0)


def random_cases(trials=400, seed=11):
    worst = Worst()
    rng = random.Random(seed)
    for _ in range(trials):
        m = rng.choice([2, 3])
        front = [tuple(round(rng.random(), 4) for _ in range(m))
                 for _ in range(rng.randint(1, 40))]
        reference = [tuple(round(rng.random(), 4) for _ in range(m))
                     for _ in range(rng.randint(1, 60))]
        compare(worst, front, reference, [1.2] * m)
    return worst.report("random fronts")


def archive_cases(root: Path):
    """The real thing: every group's reference front against the generations of
    its runs, in the same normalised space ``compute_metrics.py`` uses."""
    data = root / "data"
    if not (data / "groups.json").exists():
        print("no data/groups.json — run tools/compute_metrics.py first", file=sys.stderr)
        return False

    import compute_metrics as cmet

    index = json.loads((data / "index.json").read_text(encoding="utf-8"))
    rows = {r["id"]: r for r in index["experiments"]}
    grouped = {}
    for row in index["experiments"]:
        grouped.setdefault(cmet.group_key(row), []).append(row)

    worst = Worst()
    for key, members in grouped.items():
        objectives = members[0]["objectives"]
        names = [o["name"] for o in objectives]
        signs = [-1.0 if o["goal"] == "max" else 1.0 for o in objectives]
        cores = {r["id"]: json.loads((data / "exp" / r["id"] / "core.json")
                                     .read_text(encoding="utf-8")) for r in members}

        points = cmet.load_group_points(members, cores, signs, names)
        reference_full = mm.nondominated(points)
        if not reference_full:
            continue
        ideal = [min(p[i] for p in reference_full) for i in range(len(names))]
        nadir = [max(p[i] for p in reference_full) for i in range(len(names))]
        spread = [(hi - lo) or 1.0 for lo, hi in zip(ideal, nadir)]
        reference = mm.thin_front(mm.normalise(reference_full, ideal, spread),
                                  cmet.REFERENCE_CAP)
        hv_ref = [cmet.HV_REF] * len(names)

        for row in members:
            _, generations = cmet.run_fronts(cores[row["id"]], signs, names)
            for _, _, _, front in generations:
                if front:
                    compare(worst, mm.normalise(front, ideal, spread), reference, hv_ref)
        print(f"  checked {key}")
    return worst.report("archive generations")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    ok = random_cases()
    ok &= archive_cases(root)
    print("\nagreed" if ok else "\nDISAGREED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
