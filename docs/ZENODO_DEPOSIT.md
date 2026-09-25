# Depositing the simulation dataset on Zenodo

The experiment records live in this repository. The **simulation dataset** — the
per-node metric samples and Cooja log residues distilled from ~466 GB of GridFS —
does not: it is ~10–20 GB, which belongs in a data repository rather than in git.

Zenodo gives it a DOI, a landing page and long-term storage, and lets the
repository and the dataset point at each other. This is the procedure.

---

## 0. Before you start

- A Zenodo account, linked to your ORCID (Zenodo → Account → Linked accounts).
- The dataset built and verified:
  ```bash
  python tools/build_gridfs_dataset.py --output ../simlab-dataset
  ```
- Check the current per-record size limit on Zenodo's own pages before you
  begin. It has been 50 GB per record for some time, with more available on
  request, but do not take this document's word for a number that Zenodo can
  change — and ask them *before* uploading if you are near it.
- Practise on **https://sandbox.zenodo.org** first. It is a full copy of the
  service with throwaway DOIs; nothing you publish there is permanent. Real
  Zenodo records, once published, **cannot be deleted** and their files cannot
  be changed — only superseded by a new version.

## 1. What to deposit

```
simlab-dataset/
├── metrics/<slug>_<id>.parquet   per-node metric samples, chronological
├── logs/<slug>_<id>.tar.zst      the non-sample Cooja log lines
├── manifest.json                 counts, byte sizes, SHA-256 per file
├── README.md                     ← copy docs/dataset-README.md here
└── LICENSE                       copy the repository's
```

```bash
cp docs/dataset-README.md ../simlab-dataset/README.md
cp LICENSE ../simlab-dataset/LICENSE
```

Zenodo renders nothing automatically, so that README is what a reader finds
after downloading: what a row in the Parquet is, what the log residue is and is
not, why `sim_result.csv` is not carried over, and how the dataset relates to
the experiment records in this repository.

`manifest.json` is what makes the deposit auditable: it carries a SHA-256 for
every file, so anyone can verify their download.

## 2. Metadata that matters

Zenodo's form is long; these are the fields that change how findable and
citable the record is.

| Field | What to put |
|---|---|
| Resource type | **Dataset** |
| Title | Something a stranger can place, e.g. "SimLab: Cooja simulation metrics for multi-objective WSN topology optimisation" |
| Authors | With ORCID and affiliation. The order is the citation order. |
| Description | What the data is, how it was produced, what each directory holds, and what is *not* in it (the full Cooja logs and the per-simulation `.csc` inputs were not preserved). |
| License | Match the repository's — `MIT` for code, but consider **CC-BY-4.0** for data; Zenodo lists both. |
| Keywords | `wireless sensor networks`, `Contiki-NG`, `Cooja`, `NSGA-III`, `multi-objective optimisation`, `RPL` |
| Related identifiers | `https://github.com/JunioCesarFerreira/simlab-results` — *is supplemented by*; `https://github.com/JunioCesarFerreira/simlab` — *is derived from* |
| Version | `1.0.0`, and keep semantic versions across future depositions |

Say plainly in the description that the dataset is derived, and how. A reader
who knows the metric samples came out of the logs will trust a missing
`sim_result.csv` far more than one who has to guess.

## 3. Uploading

### Through the web interface

Workable, but a browser upload of 10–20 GB is a long single point of failure.
Use it for the sandbox rehearsal, and for the real deposit only if the API path
is unavailable.

New upload → fill the metadata → drag the files → **Save** → **Publish**.

### Through the API (recommended at this size)

Create a personal access token at Zenodo → Applications → Personal access
tokens, with the `deposit:write` and `deposit:actions` scopes. Then:

```bash
export ZENODO_TOKEN=...                      # sandbox token for a rehearsal
python tools/zenodo_upload.py \
    --dataset ../simlab-dataset \
    --metadata docs/zenodo-metadata.json \
    --sandbox                                # drop this for the real deposit
```

The script creates the deposition, uploads each file to the bucket endpoint
with a resumable PUT, verifies the checksum Zenodo reports against the one in
`manifest.json`, and stops **before** publishing. Review the draft in the web
interface, then publish from there — or re-run with `--publish` once you are
certain.

## 4. After publishing

Zenodo mints two DOIs:

- a **concept DOI**, which always resolves to the newest version — this is the
  one to cite in a paper, and the one to put in `CITATION.cff`;
- a **version DOI**, unique to this deposition — cite this one when an analysis
  must be pinned to the exact bytes it ran on.

Then:

1. Add the concept DOI badge to this repository's `README.md`.
2. Add the dataset to `CITATION.cff` as a `references` entry.
3. In the Zenodo record, confirm the related identifiers resolve.

## 5. Publishing a new version

Never edit a published record's files. Use **New version** on the record page,
which keeps the concept DOI and mints a fresh version DOI. Re-run
`build_gridfs_dataset.py`, bump the version, and say in the description what
changed relative to the previous one.

## 6. What this deposit does not rescue

Depositing this dataset does **not** preserve:

- the complete Cooja logs — only the sample records (as Parquet) and the
  non-sample residue are kept;
- `simulation.xml` / `positions.dat`, the exact Cooja inputs per simulation;
- topology images and pre-rendered analysis charts.

If any of those matter, they have to be captured **before** the database volume
is reclaimed. Afterwards there is no source to rebuild them from.
