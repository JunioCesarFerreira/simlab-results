# SimLab Results

An archive of multi-objective optimisation experiments run with
[SimLab](https://github.com/JunioCesarFerreira/simlab), a platform for
evaluating wireless sensor network topologies against Cooja/Contiki-NG
simulations.

51 experiments are preserved here, with an interactive viewer:

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
  index.json               one summary row per experiment
  exp/<id>/core.json       generations, objectives, Pareto front,
                           per-simulation network metrics
  exp/<id>/chromosomes.json  relay coordinates, for the topology view

raw/<n>_<name>_<id>.json.gz   the preservation copy: every MongoDB document
                              for that experiment, losslessly gzipped

tools/build_archive.py     rebuilds data/ and raw/ from a database export
```

`data/` is derived from `raw/` and rounded to the precision the charts use
(2 decimals for coordinates, 6 for objectives). `raw/` is the authority: it is
the export exactly as it left the database, and the build verifies every
gzip round-trip against a SHA-256 of the source before writing it.

### What is *not* in the archive

The database also held ~477 GB of GridFS artifacts that are not published here
and are not recoverable from these files:

- `sim_result.log` — the full Cooja log of every simulation (389 GB)
- `sim_result.csv` — per-node metric time series (77 GB)
- `simulation.xml`, `positions.dat` — the exact Cooja inputs per simulation
- firmware snapshots, topology images, pre-rendered analysis charts

What survives of them is the **summary** `network_metrics` on each simulation
(energy, latency, throughput, hop count, packet counters) and the DODAG tree,
both of which are inside the `raw/` records. The per-node time series and the
raw logs are not.

This matters for reproducibility: the archive documents *what the optimisation
found*, not enough to replay a specific Cooja run byte-for-byte.

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
objective, negated for objectives being maximised. Summary statistics over raw
objective values should be robust to it — the viewer plots medians for this
reason.

## Rebuilding

```bash
# in the simlab repository: dump MongoDB to one JSON file per experiment
python util/export_experiments.py --output experiments_export

# here: build raw/ and data/ from that dump
python tools/build_archive.py --input ../simlab/experiments_export
```

## Citation

If you use this data, please cite the SimLab repository
(see its `CITATION.cff`).

## Licence

[MIT](LICENSE).
