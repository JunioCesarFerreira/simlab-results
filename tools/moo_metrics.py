#!/usr/bin/env python3
"""
Multi-objective quality indicators, in the standard library only.

The archive tools have no third-party dependencies on purpose: they have to
keep running years after the environment that produced the data is gone, so
numpy/pymoo are not available here and the indicators are implemented
directly. The sets involved are small — a front is tens to a few hundred
points in at most three objectives — so a careful pure-Python implementation
is fast enough for a one-off build.

Everything below works in *minimisation space*: objectives being maximised are
negated by the caller before they get here.
"""

from math import sqrt

__all__ = [
    "nondominated", "hypervolume", "generational_distance",
    "inverted_generational_distance", "thin_front", "normalise",
]


def nondominated(points):
    """The non-dominated subset, duplicates collapsed.

    Lexicographic order guarantees that any point dominating ``p`` is already
    in the archive when ``p`` is tested, so a single forward scan suffices.
    """
    out = []
    for p in sorted(set(map(tuple, points))):
        if not any(all(a <= b for a, b in zip(q, p)) for q in out):
            out.append(p)
    return out


def _hv2(points, ref):
    """Area dominated in 2-D, by a sweep along the first objective."""
    area, best_y = 0.0, ref[1]
    for x, y in sorted(points):
        if y < best_y:
            area += (ref[0] - x) * (best_y - y)
            best_y = y
    return area


def hypervolume(points, ref):
    """Volume of the region dominated by ``points`` and bounded by ``ref``.

    Dimension slicing: the m-dimensional volume is the sum, over the slabs
    between consecutive values of the last objective, of the (m-1)-dimensional
    volume dominated by the points below that slab. Exponential in m, which is
    irrelevant at m <= 3 and would not be at m = 10.

    A point that does not strictly dominate ``ref`` in every objective encloses
    no volume at all, so it is simply dropped.
    """
    m = len(ref)
    pts = [tuple(p) for p in points if all(a < b for a, b in zip(p, ref))]
    if not pts:
        return 0.0
    if m == 1:
        return ref[0] - min(p[0] for p in pts)
    if m == 2:
        return _hv2(pts, ref)

    pts = nondominated(pts)
    pts.sort(key=lambda p: p[-1])
    vol = 0.0
    for i, p in enumerate(pts):
        top = pts[i + 1][-1] if i + 1 < len(pts) else ref[-1]
        if top <= p[-1]:
            continue
        vol += hypervolume([q[:-1] for q in pts[:i + 1]], ref[:-1]) * (top - p[-1])
    return vol


def _min_distance(p, others):
    best = float("inf")
    for q in others:
        d = 0.0
        for a, b in zip(p, q):
            d += (a - b) * (a - b)
            if d >= best:
                break
        else:
            best = d
    return sqrt(best)


def generational_distance(front, reference):
    """Mean distance from each point of ``front`` to the nearest reference
    point — how close the approximation got. Lower is better."""
    if not front or not reference:
        return None
    return sum(_min_distance(p, reference) for p in front) / len(front)


def inverted_generational_distance(front, reference):
    """Mean distance from each *reference* point to the nearest point of
    ``front`` — convergence and coverage together. Lower is better."""
    if not front or not reference:
        return None
    return sum(_min_distance(r, front) for r in reference) / len(reference)


def normalise(points, ideal, spread):
    return [tuple((v - lo) / s for v, lo, s in zip(p, ideal, spread)) for p in points]


def thin_front(points, limit):
    """Reduce a reference front to ``limit`` points, keeping its spread.

    Greedy farthest-point sampling: start from the point closest to the origin
    of the normalised space and repeatedly take the point furthest from
    everything already chosen. Deterministic, and it keeps the extremes —
    which plain subsampling does not, and IGD is sensitive to.
    """
    pts = sorted(set(map(tuple, points)))
    if len(pts) <= limit:
        return pts

    start = min(range(len(pts)), key=lambda i: sum(v * v for v in pts[i]))
    chosen = [start]
    taken = [False] * len(pts)
    taken[start] = True
    dist = [sum((a - b) ** 2 for a, b in zip(p, pts[start])) for p in pts]

    while len(chosen) < limit:
        far = max((d, i) for i, d in enumerate(dist) if not taken[i])[1]
        taken[far] = True
        chosen.append(far)
        ref = pts[far]
        for i, p in enumerate(pts):
            if taken[i]:
                continue
            d = sum((a - b) ** 2 for a, b in zip(p, ref))
            if d < dist[i]:
                dist[i] = d
    return [pts[i] for i in sorted(chosen)]
