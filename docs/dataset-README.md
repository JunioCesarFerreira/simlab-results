# SimLab simulation dataset

Per-node network metric samples and Cooja log residues from multi-objective
optimisation experiments run with [SimLab](https://github.com/JunioCesarFerreira/simlab).

The experiment records they belong to — configurations, Pareto fronts,
individuals, objectives and DODAG trees — are published separately at
https://github.com/JunioCesarFerreira/simlab-results, with a browsable viewer.

## Layout

```
metrics/<slug>_<experiment_id>.parquet   metric samples, chronological
logs/<slug>_<experiment_id>.tar.zst      non-sample Cooja log lines
manifest.json                            counts, sizes and SHA-256 per file
```

### `metrics/*.parquet`

One row per metric sample emitted by one node during one simulation.

| column | meaning |
|---|---|
| `simulation_id` | the simulation this sample came from; joins to `simulations[]._id` in the experiment records |
| `t_us` | Cooja timestamp in microseconds. **Null for older runs** whose logs did not carry it |
| `mote` | Cooja mote index |
| `node` | the node's IPv6 address |
| `cpu_energy_mj`, `lpm_energy_mj`, `radio_tx_energy_mj`, `radio_rx_energy_mj`, `total_energy_mj` | energy counters |
| `node_time`, `root_time_now` | node and root clocks |
| `total_sent`, `total_received`, `server_sent`, `server_received` | packet counters |
| `bytes_tx`, `bytes_rx`, `server_bytes_rx` | byte counters |
| `r2n_latency`, `n2r_latency`, `rtt_latency` | latencies |
| `lqi`, `rssi`, `hops` | link quality, signal strength, hop count |

Rows are in the order the log emitted them. Integer columns that never go
negative are typed `uint64`, because Contiki emits these as C `uint64` and an
underflowed latency surfaces as a value near 1.8e19 that does not fit in
`int64`. **Those large values are real artifacts of the source data, not
corruption in this dataset** — filter them before computing latency statistics.

### `logs/*.tar.zst`

One member per simulation, named `<simulation_id>.log`, holding what remains of
that simulation's Cooja log after the metric sample lines are removed: the boot
banner, RPL parent changes, `Sensor IPv6 =` announcements and reachability
probes.

```bash
zstd -dc logs/<file>.tar.zst | tar -xO <simulation_id>.log
```

## How this was derived, and what it replaces

The database held, per simulation, a full Cooja log and a `sim_result.csv` of
metric samples. The CSV was **exactly** the log's sample records permuted —
grouped by node instead of chronological — and nothing else. The samples were
therefore taken from the log, which additionally carries the `t_us`/`mote`
prefix the CSV drops, and the CSV is not carried over: sorting a Parquet file
by `node` (stable) reproduces it row for row. That equivalence was checked
against the original CSVs on a sample of simulations during the build.

## What is not here

- the complete Cooja logs — only the samples and the non-sample residue;
- `simulation.xml` / `positions.dat`, the exact Cooja inputs per simulation;
- topology images and pre-rendered analysis charts.

Each simulation's `parameters` in the experiment records still hold the node
deployment, seeds and duration, so an equivalent run can be regenerated — but
not the original byte-for-byte.

## Reading it

```python
import pyarrow.parquet as pq

t = pq.read_table("metrics/<file>.parquet")
t.filter(pq.compute.equal(t["simulation_id"], "<id>"))
```

## Licence

CC-BY-4.0. Please cite the Zenodo DOI and the SimLab repository.
