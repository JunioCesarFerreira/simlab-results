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

  /** Indicators are small and unitless; 3 significant-ish decimals read best. */
  function fmtInd(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    return Math.abs(n) >= 1 || n === 0 ? n.toFixed(3) : n.toFixed(Math.abs(n) < 0.001 ? 5 : 4);
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

  /** ``styleAxes`` false leaves the option's own axis styling alone — for the
      charts that copy the live GUI's look rather than this page's. */
  function makeChart(el, option, styleAxes = true) {
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
    if (styleAxes && option.xAxis) {
      chart.setOption({ xAxis: spread(option.xAxis), yAxis: spread(option.yAxis) });
    }
    charts.push(chart);
    return chart;
  }

  const PALETTE = ["#3f7fb0", "#c9772f", "#2f6f4f", "#8a5fa8", "#b04f6a", "#5f8f3f"];

  /** Follows the CSS: an explicit data-theme wins, otherwise the OS setting. */
  function isDark() {
    const forced = document.documentElement.getAttribute("data-theme");
    if (forced) return forced === "dark";
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  /** The indicator charts copy the live SimLab GUI's palette
      (gui/simlab/src/services/chartTheme.ts) so the same curve looks the same
      in both places. GD and IGD get distinct hues rather than shades of one:
      they answer different questions and are read side by side. */
  function metricPalette() {
    const dark = isDark();
    return {
      text: dark ? "#cdd6f4" : "#334155",
      muted: dark ? "#6c7086" : "#94a3b8",
      grid: dark ? "#313244" : "#e2e8f0",
      tooltip: dark ? "#1e1e2e" : "#ffffff",
      tooltipBorder: dark ? "#313244" : "#e2e8f0",
      hv: dark ? "#89b4fa" : "#2563eb",
      gd: dark ? "#f38ba8" : "#dc2626",
      igd: dark ? "#cba6f7" : "#7c3aed",
      igdPlus: dark ? "#f9e2af" : "#b45309",
      hvArea: dark ? "rgba(137,180,250,0.12)" : "rgba(37,99,235,0.08)",
      gdArea: dark ? "rgba(243,139,168,0.12)" : "rgba(220,38,38,0.08)",
      igdArea: dark ? "rgba(203,166,247,0.12)" : "rgba(124,58,237,0.08)",
    };
  }

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
    const [index, groups] = await Promise.all([
      getJSON("data/index.json"),
      getJSON("data/groups.json").catch(() => null),
    ]);
    const rows = index.experiments;

    const strategies = [...new Set(rows.map((r) => r.strategy).filter(Boolean))].sort();
    const problems = [...new Set(rows.map((r) => r.problem_name).filter(Boolean))].sort();
    const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))].sort();

    render(`
      <h1>Archived experiments</h1>
      <p class="sub">${rows.length} multi-objective optimisation runs, exported from the
      SimLab database. Every run keeps its full record — click through for charts,
      or download the lossless JSON.</p>

      ${groups ? `<div class="chips">
        <span class="chips-label">Compare runs:</span>
        ${groups.groups.map((g) => `<a class="chip" href="#/group/${encodeURIComponent(g.key)}">
          ${esc(g.problem)} · ${g.objectives.length} obj · ${g.runs.length} runs</a>`).join("")}
      </div>` : ""}

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
          <th class="sortable num" data-k="hv" title="Hypervolume of the final front (higher is better)">HV</th>
          <th class="sortable num" data-k="gd" title="Generational distance (lower is better)">GD</th>
          <th class="sortable num" data-k="igd" title="Inverted generational distance (lower is better)">IGD</th>
          <th class="sortable" data-k="start_time">Started</th>
          <th class="sortable" data-k="status">Status</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table></div>
      <p class="note" id="count"></p>
    `);

    let sortKey = "start_time", sortDir = -1;

    const keyOf = (r, k) => {
      if (["generations", "individuals", "simulations"].includes(k)) return r.counts[k];
      if (["hv", "gd", "igd"].includes(k)) return r.metrics ? r.metrics[k] : null;
      return r[k];
    };

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
          <td class="num">${fmtInd(r.metrics?.hv)}</td>
          <td class="num">${fmtInd(r.metrics?.gd)}</td>
          <td class="num">${fmtInd(r.metrics?.igd)}</td>
          <td>${esc(fmtDate(r.start_time))}</td>
          <td>${statusPill(r.status)}</td>
        </tr>`).join("") ||
        `<tr><td colspan="11" class="empty">No experiment matches these filters.</td></tr>`;

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

    const [core, metrics, groups] = await Promise.all([
      getJSON(`data/exp/${encodeURIComponent(id)}/core.json`),
      getJSON(`data/exp/${encodeURIComponent(id)}/metrics.json`).catch(() => null),
      getJSON("data/groups.json").catch(() => null),
    ]);
    const group = groups && metrics
      ? groups.groups.find((g) => g.key === metrics.group) : null;
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

      <h2>Quality indicators</h2>
      <div id="ind-wrap"></div>

      <h2>Pareto front</h2>
      <div id="pareto-wrap"></div>

      <h2>Objective trade-offs</h2>
      <div id="par-wrap"></div>

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

    drawIndicators(id, metrics, group);
    drawPareto(core, objs);
    drawParallel(core, objs, group);
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

  // ---------------------------------------------------- quality indicators

  // Same four indicators, same hues, as the live GUI's convergence panels.
  const IND = {
    hv: { label: "Hypervolume", better: "higher", hue: "hv" },
    gd: { label: "Generational distance", better: "lower", hue: "gd" },
    igd: { label: "Inverted generational distance", better: "lower", hue: "igd" },
    igd_plus: { label: "IGD+ (Pareto-compliant)", better: "lower", hue: "igdPlus" },
  };

  const indColour = (key) => metricPalette()[IND[key].hue];

  /** Where this run places among the comparable runs, 1 = best. */
  function rankIn(group, id, key) {
    if (!group) return null;
    const scored = group.runs.filter((r) => Number.isFinite(r[key]));
    if (!scored.length) return null;
    scored.sort((a, b) => (IND[key].better === "higher" ? b[key] - a[key] : a[key] - b[key]));
    const at = scored.findIndex((r) => r.id === id);
    return at < 0 ? null : { rank: at + 1, of: scored.length };
  }

  function drawIndicators(id, metrics, group) {
    const wrap = document.getElementById("ind-wrap");
    if (!metrics) {
      wrap.innerHTML = `<p class="empty">Indicators have not been computed for this run.
        Run <code>tools/compute_metrics.py</code> over the archive.</p>`;
      return;
    }

    const f = metrics.final;
    const card = (key) => {
      const r = Number.isFinite(f[key]) ? rankIn(group, id, key) : null;
      const caption = r ? `#${r.rank} of ${r.of} comparable runs`
        : Number.isFinite(f[key]) ? "nothing to compare with"
        : "this run left no front to score";
      return `<div class="card">
        <div class="k">${esc(key.toUpperCase())} · ${IND[key].better} is better</div>
        <div class="v">${fmtInd(f[key])}</div>
        <div class="k">${caption}</div>
      </div>`;
    };

    wrap.innerHTML = `
      <div class="grid">
        ${card("hv")}${card("gd")}${card("igd")}
        <div class="card">
          <div class="k">Measured on</div>
          <div class="v small">${f.front_size} points</div>
          <div class="k">${f.source === "pareto_front"
            ? "the recorded Pareto front" : "the last generation (no front recorded)"}</div>
        </div>
      </div>
      <p class="note">Objectives are scaled to the reference front's own range before
        measuring, so the three numbers are comparable between runs of
        ${group ? `<a href="#/group/${encodeURIComponent(metrics.group)}">${esc(group.problem)}
        with the same objectives</a>` : "the same problem"} — and meaningless outside it.
        Hypervolume uses the reference point ${metrics.hv_reference_point} in every scaled
        objective; the distances are measured against a reference front of
        ${metrics.reference_front_size} points.</p>
      <div id="ind-conv"></div>
      <div id="ind-cmp"></div>`;

    drawConvergence(metrics);
    drawGroupBars(group, id);
  }

  /** The three indicators over the generations of one run, laid out as in the
      live SimLab GUI: one panel each, HV | GD | IGD, so a near-zero GD next to
      a large IGD stays readable instead of collapsing onto one axis. */
  function drawConvergence(metrics) {
    const wrap = document.getElementById("ind-conv");
    const gens = metrics.generations;
    if (gens.length < 2) {
      wrap.innerHTML = `<p class="note">Too few generations to chart a convergence curve.</p>`;
      return;
    }
    // Three empty panels say less than one sentence does.
    if (gens.every((g) => g.front_size === 0)) {
      const evaluated = gens.reduce((n, g) => n + g.feasible + g.infeasible, 0);
      wrap.innerHTML = `<p class="note">Nothing to measure: not one of the
        ${evaluated.toLocaleString()} individuals this run evaluated was feasible —
        every one of them was scored with the infeasibility penalty.</p>`;
      return;
    }

    wrap.innerHTML = `
      <div class="measured">
        <span class="measured-label">Measured set</span>
        <span class="pill s-done">Offspring (Q<sub>t</sub>)</span>
        <span class="note" style="margin:0">the individuals each generation
          evaluated — it swings with every batch, and can drop while the search
          still holds a better parent</span>
      </div>
      <div class="hvgd">
        <div id="c-hv" class="hvgd-panel" role="img"
             aria-label="Hypervolume per generation, measured on the offspring"></div>
        <div id="c-gd" class="hvgd-panel" role="img"
             aria-label="Generational distance per generation"></div>
        <div id="c-igd" class="hvgd-panel" role="img"
             aria-label="Inverted generational distance per generation"></div>
      </div>
      <p class="note">Each generation is measured on the non-dominated subset of
        its own offspring, not on the best found so far, so these curves can dip
        when a generation explores. The live GUI can measure the survivor set
        P<sub>t</sub> instead; the archive cannot, because survivors were
        persisted for only 6 of its 51 runs. A generation with no feasible
        individual encloses no volume — HV 0 — and its distances are left as a
        gap rather than a zero that would read as perfect convergence.</p>`;

    const c = metricPalette();
    const labels = gens.map((g) => `Gen ${g.index}`);

    const base = (name, digits) => ({
      animation: false,
      tooltip: {
        trigger: "axis",
        backgroundColor: c.tooltip, borderColor: c.tooltipBorder,
        textStyle: { color: c.text, fontSize: 12 },
        formatter: (params) => {
          const rows = params.map((p) => {
            const v = p.value;
            const shown = v === null || v === undefined ? "—"
              : digits === null ? Number(v).toExponential(3) : Number(v).toFixed(digits);
            return `<b>${esc(p.seriesName)}</b>: ${shown}`;
          }).join("<br>");
          return `${esc(params[0].name)}<br>${rows}`;
        },
      },
      grid: { top: 34, right: 18, bottom: 34, left: 52, containLabel: true },
      xAxis: {
        type: "category", data: labels,
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { lineStyle: { color: c.grid } },
        axisLabel: { color: c.muted, fontSize: 11 },
      },
      yAxis: {
        type: "value", name, scale: true,
        nameTextStyle: { color: c.muted, fontSize: 11 },
        axisLine: { show: false },
        axisLabel: { color: c.muted, fontSize: 10, formatter: compactNum },
        splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
      },
    });

    const line = (name, data, colour, area) => ({
      name, type: "line", data,
      smooth: true, symbol: "circle", symbolSize: 6, showSymbol: false,
      // A null is a break in the line, not a point on the floor.
      connectNulls: false,
      itemStyle: { color: colour },
      lineStyle: { color: colour, width: 2 },
      ...(area ? { areaStyle: { color: area } } : {}),
    });

    makeChart(document.getElementById("c-hv"), {
      ...base("HV", 4),
      series: [line("Hypervolume", gens.map((g) => g.hv), c.hv, c.hvArea)],
    }, false);

    makeChart(document.getElementById("c-gd"), {
      ...base("GD", 4),
      series: [line("GD", gens.map((g) => g.gd), c.gd, c.gdArea)],
    }, false);

    // IGD and IGD+ answer the same question on the same scale, so they share a
    // panel. IGD+ bounds IGD from below, so it is a dashed line with no area —
    // a second fill would only muddy the first.
    makeChart(document.getElementById("c-igd"), {
      ...base("IGD", 4),
      legend: {
        top: 2, right: 2, itemWidth: 14, itemHeight: 8,
        textStyle: { color: c.muted, fontSize: 10 }, data: ["IGD", "IGD+"],
      },
      series: [
        line("IGD", gens.map((g) => g.igd), c.igd, c.igdArea),
        {
          ...line("IGD+", gens.map((g) => g.igd_plus), c.igdPlus, null),
          symbol: "triangle",
          lineStyle: { color: c.igdPlus, width: 2, type: "dashed" },
        },
      ],
    }, false);
  }

  /** This run against every comparable run, one indicator at a time. */
  function drawGroupBars(group, id) {
    const wrap = document.getElementById("ind-cmp");
    if (!group || group.runs.length < 2) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = `
      <div class="chartbar">
        <label for="ci">Compare by</label>
        <select id="ci">${Object.keys(IND).map((k) =>
          `<option value="${k}">${esc(IND[k].label)}</option>`).join("")}</select>
        <span class="note" style="margin:0">across ${group.runs.length} runs of
          ${esc(group.problem)} with the same objectives</span>
      </div>
      <div id="cmp" class="chart" style="height:${Math.max(180, 22 * group.runs.length + 60)}px"></div>`;

    const chart = makeChart(document.getElementById("cmp"), { xAxis: {}, yAxis: {} });
    const select = document.getElementById("ci");

    function update() {
      const key = select.value;
      const runs = group.runs
        .filter((r) => Number.isFinite(r[key]))
        .sort((a, b) => (IND[key].better === "higher" ? a[key] - b[key] : b[key] - a[key]));
      chart.setOption({
        tooltip: {
          trigger: "item",
          formatter: (p) => `${esc(runs[p.dataIndex].name)}<br>${esc(key.toUpperCase())}:
            <b>${fmtInd(p.value)}</b><br>${esc(runs[p.dataIndex].strategy || "")}`,
        },
        grid: { left: 8, right: 60, top: 10, bottom: 34, containLabel: true },
        xAxis: { type: "value", axisLabel: { formatter: (v) => fmtInd(v), color: css("--muted") } },
        yAxis: {
          type: "category", data: runs.map((r) => r.name || r.id),
          axisLabel: {
            color: css("--muted"), width: 190, overflow: "truncate",
            formatter: (v) => v,
          },
        },
        series: [{
          type: "bar", data: runs.map((r) => r[key]), barMaxWidth: 14,
          itemStyle: {
            color: (p) => (runs[p.dataIndex].id === id ? indColour(key) : css("--border")),
          },
          label: {
            show: true, position: "right", color: css("--muted"), fontSize: 11,
            formatter: (p) => fmtInd(p.value),
          },
        }],
      }, { replaceMerge: ["series", "xAxis", "yAxis"] });
    }

    select.addEventListener("change", update);
    update();
  }

  // ------------------------------------------------- parallel coordinates

  /** Every objective on its own vertical axis, one line per solution.
      Lines that cross between two axes are the trade-off between them. */
  function drawParallel(core, objs, group) {
    const wrap = document.getElementById("par-wrap");
    if (objs.length < 2) {
      wrap.innerHTML = `<p class="empty">A parallel plot needs at least two objectives.</p>`;
      return;
    }

    const feasible = (values) =>
      values.length === objs.length &&
      values.every((v) => Number.isFinite(v) && Math.abs(v) < 1e8);

    const fromPareto = core.pareto
      .map((p) => objs.map((o, i) => objValue(p.obj, i, o.name)))
      .filter(feasible);

    const lastGen = core.generations.slice().sort((a, b) => b.index - a.index)[0];
    const fromLast = core.individuals
      .filter((ind) => ind.gen === lastGen?.id)
      .map((ind) => objs.map((o, i) => objValue(ind.obj, i, o.name)))
      .filter(feasible);

    const fromAll = core.individuals
      .map((ind) => objs.map((o, i) => objValue(ind.obj, i, o.name)))
      .filter(feasible);

    const sources = [
      ["pareto", `Pareto front (${fromPareto.length})`, fromPareto],
      ["last", `Last generation (${fromLast.length})`, fromLast],
      ["all", `All feasible individuals (${fromAll.length})`, fromAll],
    ].filter(([, , rows]) => rows.length);

    if (!sources.length) {
      wrap.innerHTML = `<p class="empty">No feasible solution to plot.</p>`;
      return;
    }

    wrap.innerHTML = `
      <div class="chartbar">
        <label for="ps">Show</label>
        <select id="ps">${sources.map(([k, label]) =>
          `<option value="${k}">${esc(label)}</option>`).join("")}</select>
        <label for="pcol">Colour by</label>
        <select id="pcol">${objs.map((o, i) =>
          `<option value="${i}">${esc(o.name)}</option>`).join("")}</select>
      </div>
      <div id="par" class="chart" style="height:340px"></div>
      <p class="note">Every axis points the same way: <strong>best at the top</strong>
        (lowest for an objective being minimised, highest for one being maximised), so a
        line that stays high is good everywhere and crossing lines are a trade-off.
        ${group ? `Axes span the range of the reference front for
        ${esc(group.problem)}, so the picture is comparable between runs.` : ""}
        Lines are capped at 2 000 — beyond that the plot is ink, not information.</p>`;

    const chart = makeChart(document.getElementById("par"), {});
    const pick = document.getElementById("ps");
    const colour = document.getElementById("pcol");

    const LIMIT = 2000;
    function thin(rows) {
      if (rows.length <= LIMIT) return rows;
      const step = rows.length / LIMIT;
      return Array.from({ length: LIMIT }, (_, i) => rows[Math.floor(i * step)]);
    }

    function update() {
      const rows = thin((sources.find(([k]) => k === pick.value) || sources[0])[2]);
      const dim = +colour.value;
      const column = rows.map((r) => r[dim]).filter(Number.isFinite);

      const axes = objs.map((o, i) => {
        const bounds = group?.objectives?.[i];
        const values = rows.map((r) => r[i]).filter(Number.isFinite);
        let lo = bounds ? Math.min(bounds.best, bounds.worst) : Math.min(...values);
        let hi = bounds ? Math.max(bounds.best, bounds.worst) : Math.max(...values);
        // An objective every solution agrees on collapses the axis to a point.
        if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
        return {
          dim: i, name: `${o.name} (${o.goal})`,
          min: lo, max: hi,
          // Best at the top: a minimised axis therefore counts downwards.
          inverse: o.goal !== "max",
          nameTextStyle: { color: css("--muted") },
          axisLabel: { formatter: compactNum, color: css("--muted") },
          axisLine: { lineStyle: { color: css("--border") } },
          axisTick: { lineStyle: { color: css("--border") } },
        };
      });

      chart.setOption({
        tooltip: {
          trigger: "item",
          formatter: (p) => objs
            .map((o, i) => `${esc(o.name)}: <b>${fmtNum(p.value[i])}</b>`).join("<br>"),
        },
        visualMap: column.length ? {
          min: Math.min(...column), max: Math.max(...column), dimension: dim,
          calculable: true, orient: "horizontal", left: "center", bottom: 0,
          text: [objs[dim].name, ""], textStyle: { color: css("--muted") },
          inRange: { color: ["#3f7fb0", "#7fae7a", "#c9772f"] },
        } : { show: false },
        parallel: { left: 46, right: 46, top: 26, bottom: 74 },
        parallelAxis: axes,
        series: [{
          type: "parallel", data: rows, smooth: false,
          lineStyle: { width: 1, opacity: rows.length > 400 ? 0.16 : 0.45 },
          progressive: 600,
        }],
      }, { replaceMerge: ["series", "parallelAxis", "visualMap"] });
    }

    [pick, colour].forEach((el) => el.addEventListener("change", update));
    update();
  }

  // ------------------------------------------------------------ group view

  async function renderGroup(key) {
    const groups = await getJSON("data/groups.json");
    const group = groups.groups.find((g) => g.key === key);
    if (!group) {
      render(`<div class="error">No comparison group <code>${esc(key)}</code> in this archive.</div>`);
      return;
    }
    crumbs.innerHTML = `<a href="#/">Experiments</a> / ${esc(group.problem)} comparison`;

    const scored = group.runs.filter((r) => Number.isFinite(r.hv));

    render(`
      <h1>${esc(group.problem)} · ${group.objectives.map((o) => esc(o.name)).join(", ")}</h1>
      <p class="sub">${group.runs.length} runs measured against one another.
        ${scored.length} produced a front that could be scored.</p>

      <div class="grid">
        <div class="panel"><dl class="kv">
          <dt>Reference front</dt><dd>${group.reference_front_size.toLocaleString()} points
            ${group.reference_front_total > group.reference_front_size
              ? `(thinned from ${group.reference_front_total.toLocaleString()})` : ""}</dd>
          <dt>HV reference</dt><dd>${group.hv_reference_point} in every scaled objective</dd>
          ${group.objectives.map((o) => `<dt>${esc(o.name)} (${esc(o.goal)})</dt>
            <dd>best ${compactNum(o.best)} · worst ${compactNum(o.worst)}</dd>`).join("")}
        </dl></div>
        <div class="panel">
          <p class="note" style="margin:0">These problems have no analytical Pareto front —
            the objectives come out of a Cooja simulation — so the reference front is the
            non-dominated set of every feasible point these ${group.runs.length} runs
            evaluated, and each objective is scaled to its range. That makes the runs
            comparable with each other; it does not make them comparable with the truth.
            A group whose runs all converge to the same wrong place will score well.</p>
        </div>
      </div>

      <h2>Ranking</h2>
      <div class="chartbar">
        <label for="gi">Indicator</label>
        <select id="gi">${Object.keys(IND).map((k) =>
          `<option value="${k}">${esc(IND[k].label)}</option>`).join("")}</select>
      </div>
      <div id="grank" class="chart" style="height:${Math.max(200, 22 * scored.length + 60)}px"></div>

      <h2>Convergence against coverage</h2>
      <div id="gscatter" class="chart" style="height:340px"></div>
      <p class="note">Each point is a run: hypervolume against inverted generational
        distance. The two disagree when a run finds an excellent piece of the front and
        misses the rest.</p>

      <h2>Runs</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Run</th><th>Strategy</th><th>Status</th>
          <th class="num">Gens</th><th class="num">Front</th>
          <th class="num">HV</th><th class="num">GD</th><th class="num">IGD</th>
          <th class="num" title="Pareto-compliant IGD (Ishibuchi et al., 2015)">IGD+</th></tr></thead>
        <tbody>${group.runs.map((r) => `<tr>
          <td><a class="rowlink" href="#/exp/${encodeURIComponent(r.id)}">${esc(r.name || r.id)}</a></td>
          <td>${esc(r.strategy || "—")}</td><td>${statusPill(r.status)}</td>
          <td class="num">${r.generations}</td><td class="num">${r.front_size}</td>
          <td class="num">${fmtInd(r.hv)}</td><td class="num">${fmtInd(r.gd)}</td>
          <td class="num">${fmtInd(r.igd)}</td>
          <td class="num">${fmtInd(r.igd_plus)}</td></tr>`).join("")}</tbody>
      </table></div>
    `);

    const rank = makeChart(document.getElementById("grank"), { xAxis: {}, yAxis: {} });
    const select = document.getElementById("gi");

    function updateRank() {
      const k = select.value;
      const runs = scored.slice()
        .sort((a, b) => (IND[k].better === "higher" ? a[k] - b[k] : b[k] - a[k]));
      rank.setOption({
        tooltip: { trigger: "item", formatter: (p) =>
          `${esc(runs[p.dataIndex].name)}<br>${esc(k.toUpperCase())}: <b>${fmtInd(p.value)}</b>` },
        grid: { left: 8, right: 60, top: 10, bottom: 34, containLabel: true },
        xAxis: { type: "value", axisLabel: { formatter: (v) => fmtInd(v), color: css("--muted") } },
        yAxis: { type: "category", data: runs.map((r) => r.name || r.id),
                 axisLabel: { color: css("--muted"), width: 220, overflow: "truncate" } },
        series: [{
          type: "bar", data: runs.map((r) => r[k]), barMaxWidth: 14,
          itemStyle: { color: indColour(k), opacity: 0.85 },
          label: { show: true, position: "right", color: css("--muted"), fontSize: 11,
                   formatter: (p) => fmtInd(p.value) },
        }],
      }, { replaceMerge: ["series", "xAxis", "yAxis"] });
    }
    select.addEventListener("change", updateRank);
    updateRank();

    makeChart(document.getElementById("gscatter"), {
      tooltip: { trigger: "item", formatter: (p) =>
        `${esc(p.data[2])}<br>HV <b>${fmtInd(p.data[0])}</b> · IGD <b>${fmtInd(p.data[1])}</b>` },
      xAxis: { name: "hypervolume (higher is better)", nameLocation: "middle", nameGap: 28,
               scale: true, axisLabel: { formatter: (v) => fmtInd(v), color: css("--muted") } },
      yAxis: { name: "IGD (lower is better)", nameLocation: "end", nameRotate: 0, nameGap: 14,
               nameTextStyle: { align: "left", color: css("--muted") }, scale: true,
               axisLabel: { formatter: (v) => fmtInd(v), color: css("--muted") } },
      series: [{
        type: "scatter", symbolSize: 11,
        data: scored.map((r) => [r.hv, r.igd, r.name || r.id]),
        itemStyle: { color: PALETTE[0], opacity: 0.85 },
      }],
    });

    footMeta.textContent = `${group.problem} · ${group.runs.length} comparable runs`;
  }

  // --------------------------------------------------------------- routing

  async function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const exp = hash.match(/^\/exp\/([^/]+)/);
    const grp = hash.match(/^\/group\/(.+)$/);
    render(`<p class="loading">Loading…</p>`);
    try {
      if (exp) await renderDetail(decodeURIComponent(exp[1]));
      else if (grp) await renderGroup(decodeURIComponent(grp[1]));
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
