/* SimLab Results — static viewer over the archived experiment data.
   No build step on purpose: an archive should keep opening long after the
   toolchain that produced it stops installing. */
(() => {
  "use strict";

  const view = document.getElementById("view");
  const crumbs = document.getElementById("crumbs");
  const footMeta = document.getElementById("foot-meta");
  const cache = new Map();
  let charts = [];

  // ---------------------------------------------------------------- helpers

  async function getJSON(path) {
    if (cache.has(path)) return cache.get(path);
    const p = fetch(path).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${path}`);
      return r.json();
    });
    cache.set(path, p);
    return p;
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function fmtNum(v, digits = 3) {
    if (v === null || v === undefined || Number.isNaN(v)) return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (n !== 0 && (Math.abs(n) >= 1e6 || Math.abs(n) < 1e-3)) return n.toExponential(2);
    return n.toLocaleString(undefined, { maximumFractionDigits: digits });
  }

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : d.toISOString().slice(0, 16).replace("T", " ");
  }

  function duration(a, b) {
    if (!a || !b) return "—";
    const ms = new Date(b) - new Date(a);
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const h = Math.floor(ms / 3.6e6), m = Math.round((ms % 3.6e6) / 6e4);
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  // The status is namespaced: a generation with status "Error" would otherwise
  // pick up the .error class used for the page-level failure box.
  function statusPill(s) {
    const cls = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return `<span class="pill s-${esc(cls)}">${esc(s || "—")}</span>`;
  }

  function disposeCharts() {
    charts.forEach((c) => c.dispose());
    charts = [];
  }

  /** ECharts inherits the page theme rather than fighting it. */
  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function makeChart(el, option) {
    const chart = echarts.init(el, null, { renderer: "canvas" });
    const ink = css("--ink"), muted = css("--muted"), border = css("--border");
    chart.setOption({
      textStyle: { color: ink, fontFamily: getComputedStyle(document.body).fontFamily },
      tooltip: { trigger: "item" },
      grid: { left: 62, right: 24, top: 34, bottom: 46, containLabel: true },
      ...option,
    });
    const axisStyle = {
      axisLine: { lineStyle: { color: border } },
      axisLabel: { color: muted },
      nameTextStyle: { color: muted },
      splitLine: { lineStyle: { color: border, opacity: 0.55 } },
    };
    // xAxis/yAxis may be a single axis or one per panel; merging an object
    // onto an array would only ever style the first.
    const spread = (axis) => (Array.isArray(axis) ? axis.map(() => axisStyle) : axisStyle);
    if (option.xAxis) {
      chart.setOption({ xAxis: spread(option.xAxis), yAxis: spread(option.yAxis) });
    }
    charts.push(chart);
    return chart;
  }

  const PALETTE = ["#3f7fb0", "#c9772f", "#2f6f4f", "#8a5fa8", "#b04f6a", "#5f8f3f"];

  /** Axis labels: 5,436,228 is nine characters of noise on a tick. */
  function compactNum(v) {
    const n = Math.abs(v);
    if (n >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "G";
    if (n >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    if (n > 0 && n < 0.01) return v.toExponential(1);
    return String(Math.round(v * 100) / 100);
  }

  // Objective values arrive as an array on individuals and as a name-keyed
  // object on the Pareto front. One accessor hides the difference.
  function objValue(obj, index, name) {
    if (Array.isArray(obj)) return obj[index];
    if (obj && typeof obj === "object") return obj[name];
    return undefined;
  }

  function objectiveNames(exp) {
    const list = (exp?.parameters?.objectives) || [];
    return list.map((o, i) => ({
      name: o.metric_name ?? `f${i + 1}`,
      goal: o.goal ?? "min",
    }));
  }

  function render(html) {
    disposeCharts();
    view.innerHTML = html;
  }

  function showError(err) {
    render(`<div class="error"><strong>Could not load this page.</strong><br>${esc(err.message)}</div>`);
  }

  // ------------------------------------------------------------- list view

  async function renderList() {
    crumbs.innerHTML = "";
    const index = await getJSON("data/index.json");
    const rows = index.experiments;

    const strategies = [...new Set(rows.map((r) => r.strategy).filter(Boolean))].sort();
    const problems = [...new Set(rows.map((r) => r.problem_name).filter(Boolean))].sort();
    const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort();

    render(`
      <h1>Archived experiments</h1>
      <p class="sub">${rows.length} multi-objective optimisation runs, exported from the
      SimLab database. Every run keeps its full record — click through for charts,
      or download the lossless JSON.</p>

      <div class="filters">
        <input id="q" type="search" placeholder="Filter by name…" aria-label="Filter by name">
        <select id="f-strategy"><option value="">All strategies</option>
          ${strategies.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        <select id="f-problem"><option value="">All problems</option>
          ${problems.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        <select id="f-status"><option value="">All statuses</option>
          ${statuses.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      </div>

      <div class="tablewrap"><table>
        <thead><tr>
          <th class="sortable" data-k="name">Experiment</th>
          <th class="sortable" data-k="strategy">Strategy</th>
          <th class="sortable" data-k="problem_name">Problem</th>
          <th class="sortable num" data-k="generations">Gens</th>
          <th class="sortable num" data-k="individuals">Individuals</th>
          <th class="sortable num" data-k="simulations">Simulations</th>
          <th class="sortable" data-k="start_time">Started</th>
          <th class="sortable" data-k="status">Status</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <p class="note" id="count"></p>
    `);

    let sortKey = "start_time", sortDir = -1;

    const keyOf = (r, k) =>
      ["generations", "individuals", "simulations"].includes(k) ? r.counts[k] : r[k];

    function draw() {
      const q = document.getElementById("q").value.trim().toLowerCase();
      const fs = document.getElementById("f-strategy").value;
      const fp = document.getElementById("f-problem").value;
      const fst = document.getElementById("f-status").value;

      const shown = rows
        .filter((r) =>
          (!q || String(r.name || "").toLowerCase().includes(q)) &&
          (!fs || r.strategy === fs) &&
          (!fp || r.problem_name === fp) &&
          (!fst || r.status === fst))
        .sort((a, b) => {
          const x = keyOf(a, sortKey), y = keyOf(b, sortKey);
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x > y ? 1 : -1) * sortDir;
        });

      document.getElementById("rows").innerHTML = shown.map((r) => `
        <tr>
          <td><a class="rowlink" href="#/exp/${encodeURIComponent(r.id)}">${esc(r.name || r.id)}</a></td>
          <td>${esc(r.strategy || "—")}</td>
          <td>${esc(r.problem_name || "—")}</td>
          <td class="num">${r.counts.generations}</td>
          <td class="num">${r.counts.individuals.toLocaleString()}</td>
          <td class="num">${r.counts.simulations.toLocaleString()}</td>
          <td>${esc(fmtDate(r.start_time))}</td>
          <td>${statusPill(r.status)}</td>
        </tr>`).join("") ||
        `<tr><td colspan="8" class="empty">No experiment matches these filters.</td></tr>`;

      document.getElementById("count").textContent =
        `${shown.length} of ${rows.length} experiments`;
    }

    ["q", "f-strategy", "f-problem", "f-status"].forEach((id) =>
      document.getElementById(id).addEventListener("input", draw));

    view.querySelectorAll("th.sortable").forEach((th) =>
      th.addEventListener("click", () => {
        const k = th.dataset.k;
        sortDir = sortKey === k ? -sortDir : 1;
        sortKey = k;
        draw();
      }));

    draw();
    footMeta.textContent = `Archive built ${fmtDate(index.built_at)} · ${rows.length} experiments`;
  }

  // ----------------------------------------------------------- detail view

  async function renderDetail(id) {
    const index = await getJSON("data/index.json");
    const summary = index.experiments.find((e) => e.id === id);
    if (!summary) {
      render(`<div class="error">No experiment with id <code>${esc(id)}</code> in this archive.</div>`);
      return;
    }
    crumbs.innerHTML = `<a href="#/">Experiments</a> / ${esc(summary.name || id)}`;

    const core = await getJSON(`data/exp/${encodeURIComponent(id)}/core.json`);
    const exp = core.experiment;
    const objs = objectiveNames(exp);
    const algo = exp?.parameters?.algorithm || {};
    const problem = exp?.parameters?.problem || {};
    const sim = exp?.parameters?.simulation || {};

    render(`
      <h1>${esc(summary.name || id)}</h1>
      <p class="sub">${statusPill(summary.status)} &nbsp; ${esc(summary.strategy || "")} ·
        ${esc(problem.name || "—")} · ${esc(fmtDate(summary.start_time))} ·
        ran for ${esc(duration(summary.start_time, summary.end_time))}</p>

      <div class="grid">
        <div class="card"><div class="k">Generations</div><div class="v">${core.generations.length}</div></div>
        <div class="card"><div class="k">Individuals</div><div class="v">${core.individuals.length.toLocaleString()}</div></div>
        <div class="card"><div class="k">Simulations</div><div class="v">${core.simulations.length.toLocaleString()}</div></div>
        <div class="card"><div class="k">Pareto front</div><div class="v">${core.pareto.length}</div></div>
      </div>

      <h2>Configuration</h2>
      <div class="grid">
        <div class="panel"><dl class="kv">
          <dt>Strategy</dt><dd>${esc(exp?.parameters?.strategy || "—")}</dd>
          <dt>Population</dt><dd>${esc(algo.population_size ?? "—")}</dd>
          <dt>Generations</dt><dd>${esc(algo.number_of_generations ?? "—")}</dd>
          <dt>Random seed</dt><dd>${esc(algo.random_seed ?? "—")}</dd>
          <dt>Crossover</dt><dd>${esc(algo.crossover_method || "—")} (p=${esc(algo.prob_cx ?? "—")})</dd>
          <dt>Mutation</dt><dd>${esc(algo.mutation_method || "—")} (p=${esc(algo.prob_mt ?? "—")})</dd>
          <dt>Selection</dt><dd>${esc(algo.selection_method || "—")}</dd>
        </dl></div>
        <div class="panel"><dl class="kv">
          <dt>Problem</dt><dd>${esc(problem.name || "—")}</dd>
          <dt>Region</dt><dd>${problem.region ? esc(JSON.stringify(problem.region)) : "—"}</dd>
          <dt>Reach radius</dt><dd>${esc(problem.radius_of_reach ?? "—")}</dd>
          <dt>Interference</dt><dd>${esc(problem.radius_of_inter ?? "—")}</dd>
          <dt>Duration</dt><dd>${esc(sim.duration ?? "—")} s</dd>
          <dt>Seeds</dt><dd>${sim.random_seeds ? esc(sim.random_seeds.join(", ")) : "—"}</dd>
          <dt>Objectives</dt><dd>${objs.map((o) => `${esc(o.name)} (${esc(o.goal)})`).join(", ") || "—"}</dd>
        </dl></div>
      </div>

      <h2>Pareto front</h2>
      <div id="pareto-wrap"></div>

      <h2>Objectives across generations</h2>
      <div id="evo-wrap"></div>

      <h2>Topology</h2>
      <div id="topo-wrap"></div>

      <h2>Generations</h2>
      <div class="tablewrap"><table>
        <thead><tr><th class="num">#</th><th>Status</th><th>Started</th><th>Ended</th>
          <th class="num">Individuals</th><th class="num">Simulations</th></tr></thead>
        <tbody>${core.generations.map((g) => {
          const ni = core.individuals.filter((i) => i.gen === g.id).length;
          const ns = core.simulations.filter((s) => s.gen === g.id).length;
          return `<tr><td class="num">${esc(g.index)}</td><td>${statusPill(g.status)}</td>
            <td>${esc(fmtDate(g.start_time))}</td><td>${esc(fmtDate(g.end_time))}</td>
            <td class="num">${ni}</td><td class="num">${ns}</td></tr>`;
        }).join("")}</tbody>
      </table></div>

      <div class="actions">
        <a class="btn" href="raw/${esc(summary.raw_file)}" download>Download full record (.json.gz)</a>
        <a class="btn" href="data/exp/${encodeURIComponent(id)}/core.json" download>Download core.json</a>
      </div>
      <p class="note">The full record is the complete set of MongoDB documents for this
        experiment, including the per-simulation Cooja parameters and DODAG trees that the
        viewer does not chart.</p>
    `);

    drawPareto(core, objs);
    drawEvolution(core, objs);
    await drawTopology(id, core, problem);
    footMeta.textContent = `${esc(summary.name || id)} · id ${id}`;
  }

  // --------------------------------------------------------------- charts

  function drawPareto(core, objs) {
    const wrap = document.getElementById("pareto-wrap");
    if (!core.pareto.length) {
      wrap.innerHTML = `<p class="empty">This run recorded no Pareto front.</p>`;
      return;
    }
    if (objs.length < 2) {
      wrap.innerHTML = `<p class="empty">A front needs at least two objectives to plot.</p>`;
      return;
    }

    const opts = objs.map((o, i) => `<option value="${i}">${esc(o.name)}</option>`).join("");
    wrap.innerHTML = `
      <div class="chartbar">
        <label for="px">x</label><select id="px">${opts}</select>
        <label for="py">y</label><select id="py">${opts}</select>
        ${objs.length > 2 ? `<label for="pc">colour</label><select id="pc">${opts}</select>` : ""}
      </div>
      <div id="pareto" class="chart"></div>`;

    const px = document.getElementById("px"), py = document.getElementById("py");
    const pc = document.getElementById("pc");
    px.value = "0"; py.value = "1";
    if (pc) pc.value = "2";

    const chart = makeChart(document.getElementById("pareto"), { xAxis: {}, yAxis: {} });

    function update() {
      const ix = +px.value, iy = +py.value, ic = pc ? +pc.value : -1;
      const pts = core.pareto.map((p) => {
        const x = objValue(p.obj, ix, objs[ix].name);
        const y = objValue(p.obj, iy, objs[iy].name);
        const c = ic >= 0 ? objValue(p.obj, ic, objs[ic].name) : undefined;
        return [x, y, c];
      }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

      const cs = pts.map((p) => p[2]).filter(Number.isFinite);
      const visualMap = ic >= 0 && cs.length ? {
        min: Math.min(...cs), max: Math.max(...cs), dimension: 2,
        calculable: true, orient: "horizontal", left: "center", bottom: 0,
        text: [objs[ic].name, ""], textStyle: { color: css("--muted") },
        inRange: { color: ["#3f7fb0", "#7fae7a", "#c9772f"] },
      } : null;

      chart.setOption({
        visualMap: visualMap || { show: false },
        xAxis: { name: objs[ix].name, nameLocation: "middle", nameGap: 30, scale: true,
                 axisLabel: { formatter: compactNum, color: css("--muted") } },
        // The y name sits above the axis, horizontal: rotated in the middle it
        // collides with wide tick labels like 5,436,228.
        yAxis: { name: objs[iy].name, nameLocation: "end", nameRotate: 0, nameGap: 14,
                 nameTextStyle: { align: "left", color: css("--muted") }, scale: true,
                 axisLabel: { formatter: compactNum, color: css("--muted") } },
        grid: { left: 52, right: 24, top: 38, bottom: visualMap ? 68 : 46, containLabel: true },
        tooltip: {
          formatter: (p) =>
            `${esc(objs[ix].name)}: <b>${fmtNum(p.value[0])}</b><br>` +
            `${esc(objs[iy].name)}: <b>${fmtNum(p.value[1])}</b>` +
            (ic >= 0 ? `<br>${esc(objs[ic].name)}: <b>${fmtNum(p.value[2])}</b>` : ""),
        },
        series: [{
          type: "scatter", data: pts, symbolSize: 9,
          itemStyle: { color: PALETTE[2], opacity: 0.85 },
        }],
      }, { replaceMerge: ["visualMap"] });
    }

    [px, py, pc].filter(Boolean).forEach((s) => s.addEventListener("change", update));
    update();
  }

  function drawEvolution(core, objs) {
    const wrap = document.getElementById("evo-wrap");
    const order = new Map(core.generations
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((g, i) => [g.id, { index: g.index ?? i }]));

    if (!order.size || !objs.length) {
      wrap.innerHTML = `<p class="empty">Not enough generation data to chart.</p>`;
      return;
    }

    // Per generation: the best value each objective reached, and the mean.
    const buckets = new Map();
    for (const ind of core.individuals) {
      const g = order.get(ind.gen);
      if (!g) continue;
      if (!buckets.has(g.index)) buckets.set(g.index, []);
      buckets.get(g.index).push(ind.obj);
    }
    const gens = [...buckets.keys()].sort((a, b) => a - b);
    if (!gens.length) {
      wrap.innerHTML = `<p class="empty">No individuals recorded per generation.</p>`;
      return;
    }

    // One panel per objective. A shared y-axis is unreadable here: latency is
    // ~10^2 and energy ~10^6, so on one scale every line but the largest is
    // flat against the floor.
    //
    // The central line is the median, not the mean. Infeasible individuals are
    // scored with a large penalty value (~1e9 in every objective), and a single
    // one of them moves a 240-individual mean by four orders of magnitude.
    const bottomPad = 48;  // room for the x-axis labels and its name
    const height = Math.max(180, 120 * objs.length + bottomPad + 20);
    wrap.innerHTML = `<div id="evo" class="chart" style="height:${height}px"></div>
      <p class="note">Solid line: best value reached in that generation.
      Dashed: population median. One panel per objective, each on its own scale.</p>`;

    const grids = [], xAxes = [], yAxes = [], series = [], titles = [];
    const topPad = 26, gap = 34;
    const panelH = (height - topPad - bottomPad - gap * (objs.length - 1)) / objs.length;

    objs.forEach((o, i) => {
      const best = [], mid = [];
      for (const g of gens) {
        const vals = buckets.get(g)
          .map((ob) => objValue(ob, i, o.name))
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        if (!vals.length) { best.push(null); mid.push(null); continue; }
        best.push(o.goal === "max" ? vals[vals.length - 1] : vals[0]);
        const h = vals.length >> 1;
        mid.push(vals.length % 2 ? vals[h] : (vals[h - 1] + vals[h]) / 2);
      }
      const colour = PALETTE[i % PALETTE.length];
      const top = topPad + i * (panelH + gap);
      const last = i === objs.length - 1;

      grids.push({ left: 64, right: 24, top, height: panelH });
      titles.push({
        text: `${o.name} (${o.goal})`, top: top - 17, left: 64,
        textStyle: { fontSize: 12, fontWeight: 600, color: css("--muted") },
      });
      xAxes.push({
        type: "category", data: gens, gridIndex: i,
        axisLabel: { show: last, color: css("--muted") },
        name: last ? "generation" : "", nameLocation: "middle", nameGap: 26,
      });
      yAxes.push({
        type: "value", scale: true, gridIndex: i,
        axisLabel: { formatter: compactNum, color: css("--muted") },
      });
      series.push({
        name: `${o.name} best`, type: "line", data: best,
        xAxisIndex: i, yAxisIndex: i, showSymbol: false,
        lineStyle: { width: 2, color: colour }, itemStyle: { color: colour },
      });
      series.push({
        name: `${o.name} median`, type: "line", data: mid,
        xAxisIndex: i, yAxisIndex: i, showSymbol: false,
        lineStyle: { width: 1.4, type: "dashed", color: colour, opacity: 0.8 },
        itemStyle: { color: colour },
      });
    });

    makeChart(document.getElementById("evo"), {
      tooltip: { trigger: "axis", valueFormatter: (v) => fmtNum(v) },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      title: titles,
      grid: grids, xAxis: xAxes, yAxis: yAxes, series,
    });
  }

  async function drawTopology(id, core, problem) {
    const wrap = document.getElementById("topo-wrap");
    const region = problem.region;
    if (!Array.isArray(region) || region.length < 4) {
      wrap.innerHTML = `<p class="empty">This problem has no spatial layout
        (synthetic benchmark).</p>`;
      return;
    }

    let chroms;
    try {
      chroms = await getJSON(`data/exp/${encodeURIComponent(id)}/chromosomes.json`);
    } catch (err) {
      wrap.innerHTML = `<p class="empty">Chromosome data unavailable: ${esc(err.message)}</p>`;
      return;
    }
    const usable = chroms.filter((c) => c.chromosome &&
      (Array.isArray(c.chromosome.relays) || Array.isArray(c.chromosome.mask)));
    if (!usable.length) {
      wrap.innerHTML = `<p class="empty">No positional chromosome in this run.</p>`;
      return;
    }

    const lastGen = core.generations.slice().sort((a, b) => b.index - a.index)[0];
    const preferred = usable.filter((c) => c.gen === lastGen?.id);
    const list = preferred.length ? preferred : usable;

    wrap.innerHTML = `
      <div class="chartbar">
        <label for="ts">Individual</label>
        <select id="ts">${list.slice(0, 300).map((c, i) =>
          `<option value="${i}">${esc(String(c.iid).slice(0, 10))}…</option>`).join("")}</select>
      </div>
      <div id="topo" class="chart"></div>
      <p class="note">Relay placement decoded from the chromosome. Sink in orange,
        candidate positions in grey where the problem defines them.</p>`;

    const chart = makeChart(document.getElementById("topo"), { xAxis: {}, yAxis: {} });
    const candidates = Array.isArray(problem.candidates) ? problem.candidates : null;

    function positions(chromosome) {
      if (Array.isArray(chromosome.relays)) {
        return chromosome.relays.map((r) => [r.x, r.y]);
      }
      if (Array.isArray(chromosome.mask) && candidates) {
        return candidates
          .filter((_, i) => chromosome.mask[i])
          .map((c) => (Array.isArray(c) ? [c[0], c[1]] : [c.x, c.y]));
      }
      return [];
    }

    function update() {
      const pick = list[+document.getElementById("ts").value] || list[0];
      const relays = positions(pick.chromosome).filter((p) => Number.isFinite(p[0]));
      const sink = Array.isArray(problem.sink)
        ? [[problem.sink[0], problem.sink[1]]]
        : [];
      const cand = candidates
        ? candidates.map((c) => (Array.isArray(c) ? [c[0], c[1]] : [c.x, c.y]))
        : [];

      chart.setOption({
        tooltip: { formatter: (p) => `${esc(p.seriesName)}<br>x ${fmtNum(p.value[0], 1)}, y ${fmtNum(p.value[1], 1)}` },
        legend: { top: 0, textStyle: { color: css("--muted") } },
        grid: { left: 52, right: 24, top: 36, bottom: 40, containLabel: true },
        xAxis: { min: region[0], max: region[2], scale: false },
        yAxis: { min: region[1], max: region[3], scale: false },
        series: [
          cand.length ? {
            name: "candidates", type: "scatter", data: cand, symbolSize: 5,
            itemStyle: { color: css("--muted"), opacity: 0.35 },
          } : null,
          {
            name: "relays", type: "scatter", data: relays, symbolSize: 11,
            itemStyle: { color: PALETTE[2], opacity: 0.9 },
          },
          {
            name: "sink", type: "scatter", data: sink, symbolSize: 16, symbol: "diamond",
            itemStyle: { color: PALETTE[1] },
          },
        ].filter(Boolean),
      }, { replaceMerge: ["series"] });
    }

    document.getElementById("ts").addEventListener("change", update);
    update();
  }

  // --------------------------------------------------------------- routing

  async function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const m = hash.match(/^\/exp\/([^/]+)/);
    render(`<p class="loading">Loading…</p>`);
    try {
      if (m) await renderDetail(decodeURIComponent(m[1]));
      else await renderList();
      window.scrollTo(0, 0);
    } catch (err) {
      showError(err);
    }
  }

  window.addEventListener("hashchange", route);
  window.addEventListener("resize", () => charts.forEach((c) => c.resize()));
  route();
})();
