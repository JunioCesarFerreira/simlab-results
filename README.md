# SimLab Results

An archive of multi-objective optimisation experiments run with
[SimLab](https://github.com/JunioCesarFerreira/simlab), a platform for
evaluating wireless sensor network topologies against Cooja/Contiki-NG
simulations.

51 experiments are preserved here, with an interactive viewer — Pareto fronts,
parallel-coordinate trade-off plots, per-generation convergence, relay
topologies, and hypervolume/GD/IGD rankings across comparable runs:

**https://juniocesarferreira.github.io/simlab-results/**

> Publishing requires Pages to be enabled once, under
> **Settings → Pages → Build and deployment → Source: GitHub Actions**.
> Until then the deploy workflow fails with `Get Pages site failed … Not Found`.

The viewer needs no server and no build step. Open `index.html` from a local
copy and it works the same as it does on the web.

---

## What is in the archive

Each experiment is an NSGA-II/NSGA-III run that searches for relay placements,
evaluating every candidate by simulating the resulting network.

| | |
|---|---|
| Experiments | 51 (48 completed, 3 cancelled) |
| Generations | 1 153 |
| Individuals | 54 383 |
| Simulations | 53 969 |
| Problems | `problem0`–`problem3`, plus synthetic DTLZ2/SCH1 benchmarks |
| Strategies | `nsga3`, `nsga3_pymoo`, `nsga3_deap`, `nsga2`, `nsga2_deap` |

Objectives are network latency, energy and throughput, evaluated from the
simulated network rather than from an analytical model.

### Layout

```
data/                      what the viewer reads
  index.json               one summary row per experiment, with its final
                           HV / GD / IGD
  groups.json              the comparable groups: reference front, ideal and
                           nadir, and every run's indicators
  exp/<id>/core.json       generations (with their survivor sets, where the
                           run recorded them), objectives, Pareto front,
                           per-simulation network metrics
  exp/<id>/chromosomes.json  relay coordinates, for the topology view
  exp/<id>/metrics.json    hypervolume, GD and IGD per generation

raw/<n>_<name>_<id>.json.gz   the preservation copy: every MongoDB document
                              for that experiment, losslessly gzipped

reference/                 data not reachable from an experiment
  problems.json            the 9 saved problem definitions
  sources.json             the 2 firmware repository records
  sources/<repo>/*         the Contiki-NG code every simulation was built from
  problems/*-background.*  problem background images

tools/build_archive.py     rebuilds data/ and raw/ from a database export
tools/export_reference.py  captures reference/ straight from MongoDB
tools/build_gridfs_dataset.py  distils the Cooja simulation output (§ below)
tools/zenodo_upload.py     deposits that dataset on Zenodo
tools/compute_metrics.py   computes the quality indicators into data/
tools/moo_metrics.py       hypervolume, GD, IGD, IGD+ — standard library only
tools/check_parity.py      holds those four to moocore, the library the
                           platform itself computes with (dev check)
```

`data/` is derived from `raw/` and rounded to the precision the charts use
(2 decimals for coordinates, 6 for objectives). `raw/` is the authority: it is
the export exactly as it left the database, and the build verifies every
gzip round-trip against a SHA-256 of the source before writing it.

## Quality indicators

Every run is scored with the four usual multi-objective indicators, and the
viewer plots them per generation and ranks the runs against each other:

| | |
|---|---|
| **HV** — hypervolume | volume of objective space dominated by the front. **Higher is better**: it rewards converging *and* spreading out. |
| **GD** — generational distance | mean distance from each point of the front to the nearest reference point. **Lower is better**: pure convergence, blind to coverage. |
| **IGD** — inverted generational distance | mean distance from each *reference* point to the nearest point of the front. **Lower is better**: convergence and coverage together. |
| **IGD+** | the Pareto-compliant variant (Ishibuchi et al., 2015), which counts only the objectives where a solution is *worse* than the reference point. Plain IGD is not even weakly Pareto compliant — a front that dominates another can score worse — so the two are read side by side, IGD+ bounding IGD from below. |

They are computed once by `tools/compute_metrics.py` and stored, not computed
in the browser: IGD is `O(|reference| × |front|)` per generation, over 1 153
generations.

The **definitions** are the platform's own, from its `pylib/moo_metrics.py`:
the `p = 1` mean for GD and IGD, `d+` for IGD+, normalisation by the reference
front's ideal-nadir range. `tools/check_parity.py` holds the pure-Python
implementations here to moocore, the library the platform computes with: they
agree to ~1e-16 on all 1 149 non-empty generations in the archive and on 400
random fronts. The viewer also plots them in the GUI's layout — HV | GD | IGD
with IGD+, one panel each — and its colours.

The **reference** is not the same, so the values here will not reproduce the
live GUI's for the same run. The GUI measures a WSN run against its own final
Pareto front, and takes its hypervolume in raw objective units against a worst
point derived from that run alone; both are per-run choices, which makes the
numbers self-referential and not comparable between runs. The archive measures
every run in a group against one shared reference front and one shared scale,
because comparing the runs is what an archive of 51 of them is for. For the
synthetic benchmarks the GUI does better still: it uses the analytical true
front, which the archive does not, so DTLZ2 and SCH1 numbers here are also
comparisons between these runs rather than distances to a known optimum.

### Which set is measured

Each generation is measured on the non-dominated subset of the **survivor set**
`P_t` — the population environmental selection kept, which is what the search
carries forward, and what the live GUI plots. Most survivors were evaluated in
an *earlier* generation (4 663 of 5 050 in the longest run), so they are stored
as chromosome hashes on the generation and resolved against every individual
the run ever evaluated.

Only **6 of the 51 runs recorded survivors**; the other 45 predate the field
and fall back to their offspring `Q_t`, the individuals evaluated in that
generation. The viewer labels which set it is showing, and `metrics.json`
carries `population_source` (`survivors`, `offspring`, or `mixed`) plus a
`source` on every generation. The difference is not cosmetic — on one
problem1 run the survivor hypervolume rises over 11 generations and falls back
in 2 steps, while the offspring reading of the same run falls in 7 of 10 and
ends below where it started.

A generation in which nothing was feasible encloses no volume, so its HV is 0
and the curve stays continuous; its distances are left empty and drawn as a gap,
rather than as a zero that would read as perfect convergence.

**Runs are only compared within a group** — same problem, same objectives, same
directions. The archive has five: `problem0` with 2 objectives (SCH1),
`problem0` with 3 (DTLZ2), and `problem1`, `problem2`, `problem3` with
latency/energy/throughput. Indicators from different groups are different
numbers with the same name; the viewer never mixes them.

**The reference front is empirical.** These objectives come out of a Cooja
simulation, so no analytical Pareto front exists to measure against. Each
group's reference front is the non-dominated set of every feasible point every
run in that group evaluated, thinned to 500 points by farthest-point sampling
so the extremes and the spread survive. This is the usual substitute and it
carries the usual caveat: *it flatters a group whose runs all converge to the
same wrong place*, because then that place is the reference. These are
comparisons between the runs, not distances to the truth.

**Scaling.** Objectives being maximised are negated, then each objective is
scaled to `[0, 1]` over the reference front's range — its ideal and its nadir.
Latency in milliseconds and energy in millijoules are otherwise incommensurable
and the hypervolume would just measure whichever has the larger unit. The
hypervolume reference point is `1.1` in every scaled objective, so a solution
at the nadir of one objective still earns volume for being extreme in another.

**Infeasible individuals are dropped.** They are scored with a ~1.01e9 penalty
in every objective (negated where maximised), which is not a point in objective
space; `metrics.json` reports how many were dropped per generation.

The curves are per generation, not best-so-far, so they can dip when a
generation explores. The per-run figure is measured on the recorded Pareto
front, or on the last generation for the three cancelled runs that never
recorded one — all three of which were cancelled before finding a single
feasible individual.

### What is *not* in the archive

The database also held ~477 GB of GridFS artifacts that are not published here
and are not recoverable from these files:

- `sim_result.log` — the full Cooja log of every simulation (389 GB)
- `sim_result.csv` — per-node metric time series (77 GB)
- `simulation.xml`, `positions.dat` — the exact Cooja inputs per simulation
- firmware snapshots, topology images, pre-rendered analysis charts

The firmware sources under `reference/sources/` are the exception: they are
small, they define what the simulated nodes actually ran, and they are kept.

What survives of the rest is the **summary** `network_metrics` on each simulation
(energy, latency, throughput, hop count, packet counters) and the DODAG tree,
both of which are inside the `raw/` records. The per-node time series and the
raw logs are not.

This matters for reproducibility: the archive documents *what the optimisation
found*, not enough to replay a specific Cooja run byte-for-byte.

### The simulation dataset, published separately

Most of that volume is recoverable in a far smaller form, and is deposited on
Zenodo rather than committed here — it is ~15 GB, which belongs in a data
repository, not in git.

Every `{"node": ...}` line in a Cooja log is one metric sample with all 21 key
names repeated, and `sim_result.csv` was exactly those samples permuted. So the
samples are extracted from the logs into Parquet — keeping the `t_us`/`mote`
prefix the CSV dropped — and the CSV is not carried over: sorting the Parquet
by `node` reproduces it row for row. What remains of each log is kept verbatim,
compressed. That is ~30x smaller with nothing lost but the redundancy.

```bash
python tools/build_gridfs_dataset.py --output ../simlab-dataset
```

See [docs/ZENODO_DEPOSIT.md](docs/ZENODO_DEPOSIT.md) for depositing it with a
DOI, and [docs/dataset-README.md](docs/dataset-README.md) for the dataset's own
documentation.

## Reading the data without the viewer

```python
import gzip, json

with gzip.open("raw/01_p1-aggr-1-gen-4-pop-48_6a974fe6ba6edf3a370f707a.json.gz") as f:
    bundle = json.load(f)

bundle["experiment"]    # config: problem, algorithm, objectives, Pareto front
bundle["generations"]   # one document per generation
bundle["individuals"]   # chromosome + objectives per individual
bundle["simulations"]   # Cooja parameters, DODAG tree, network metrics
```

Objective values are an **array** on `individuals` (in the order given by
`experiment.parameters.objectives`) and an **object keyed by metric name** on
`experiment.pareto_front`. Both forms appear in the same file.

Infeasible individuals are scored with a large penalty value (~1.01e9) in every
objective, negated for objectives being maximised. It is a marker, not a
measurement: any statistic taken over raw objective values has to exclude it
first. A median is not enough on its own — 277 of this archive's 550
individuals in `P1-NSGA3-10g` are infeasible, so the median *is* the penalty —
so the viewer drops every value at or beyond 1e8 before plotting or measuring
anything, and says how many it dropped.

## Rebuilding

```bash
# in the simlab repository: dump MongoDB to one JSON file per experiment
python util/export_experiments.py --output experiments_export

# here: build raw/ and data/ from that dump, indicators included
python tools/build_archive.py --input ../simlab/experiments_export

# or recompute only the indicators, over the data/ already in the repository
python tools/compute_metrics.py

# optional, needs numpy + moocore: check them against the platform's library
../simlab/.venv/bin/python tools/check_parity.py
```

## Citation

If you use this data, please cite the SimLab repository
(see its `CITATION.cff`).

## Licence

[MIT](LICENSE).
