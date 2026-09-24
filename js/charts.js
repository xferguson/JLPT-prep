// Small dependency-free SVG charts for the Stats view.
// Conventions: one y-axis, recessive grid, 2px surface gaps between stacked
// segments, 4px rounded bar tops, 2px lines, every chart has a hover/focus
// tooltip and a table view (rendered by the caller).

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function yAxis(w, h, m, max) {
  let out = '';
  for (let i = 0; i <= 2; i++) {
    const v = (max / 2) * i;
    const y = h - m.b - ((h - m.t - m.b) * i) / 2;
    out += `<line class="grid" x1="${m.l}" x2="${w - m.r}" y1="${y}" y2="${y}"/>`;
    out += `<text class="tick" x="${m.l - 6}" y="${y + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  return out;
}

// Every `every`-th x label plus the last one, dropping a regular label that
// would sit too close to the last.
function showLabel(i, n, every) {
  if (i === n - 1) return true;
  return i % every === 0 && n - 1 - i >= Math.max(2, every);
}

// Rect with only the top corners rounded.
function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Stacked vertical bars.
 * rows: [{ label, title, values: { key: number } }]
 * series: [{ key, name, color }]  (bottom to top)
 */
export function stackedBars(width, { rows, series, height = 180, labelEvery = 1 }) {
  const m = { t: 10, r: 8, b: 24, l: 34 };
  const w = Math.max(260, width);
  const h = height;
  const totals = rows.map((r) => series.reduce((n, s) => n + (r.values[s.key] || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const plotW = w - m.l - m.r;
  const plotH = h - m.t - m.b;
  const band = plotW / rows.length;
  const barW = Math.max(3, Math.min(28, band * 0.7));
  let marks = '';
  let labels = '';
  rows.forEach((row, i) => {
    const cx = m.l + band * i + band / 2;
    let y = h - m.b;
    const segs = series.filter((s) => row.values[s.key] > 0);
    const lines = series.map((s) => [s.name, row.values[s.key] || 0, s.color]);
    segs.forEach((s, j) => {
      const v = row.values[s.key];
      const segH = (v / max) * plotH;
      const gap = j > 0 ? 2 : 0; // surface gap between stacked segments
      const top = y - segH;
      const hh = Math.max(1, segH - gap);
      const d = j === segs.length - 1 ? topRounded(cx - barW / 2, top, barW, hh, 4)
        : `M${cx - barW / 2},${top}h${barW}v${hh}h${-barW}Z`;
      marks += `<path d="${d}" style="fill:${s.color}"/>`;
      y = top;
    });
    // hit target: the whole column, larger than the mark
    marks += `<rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${plotH}" tabindex="0"
      data-tip='${esc(JSON.stringify({ title: row.title || row.label, lines }))}'/>`;
    if (showLabel(i, rows.length, labelEvery)) {
      labels += `<text class="tick" x="${cx}" y="${h - 6}" text-anchor="middle">${esc(row.label)}</text>`;
    }
  });
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">
    ${yAxis(w, h, m, max)}<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>
    ${marks}${labels}</svg>`;
}

/**
 * Multi-series line chart with a crosshair tooltip and direct end labels.
 * labels: [x labels]; series: [{ key, name, color, values: [] }]
 */
export function lineChart(width, { labels, titles = labels, series, height = 190, labelEvery = 1 }) {
  const m = { t: 12, r: 92, b: 24, l: 34 };
  const w = Math.max(280, width);
  const h = height;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const plotW = w - m.l - m.r;
  const plotH = h - m.t - m.b;
  const n = labels.length;
  const x = (i) => m.l + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v) => h - m.b - (v / max) * plotH;
  let out = yAxis(w, h, m, max);
  out += `<line class="axis" x1="${m.l}" x2="${w - m.r}" y1="${h - m.b}" y2="${h - m.b}"/>`;
  labels.forEach((l, i) => {
    if (showLabel(i, n, labelEvery)) out += `<text class="tick" x="${x(i)}" y="${h - 6}" text-anchor="middle">${esc(l)}</text>`;
  });
  // end labels, nudged apart so they don't collide
  const ends = series.map((s) => ({ s, v: s.values[n - 1], y: y(s.values[n - 1]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const s of series) {
    const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    out += `<polyline class="line" points="${pts}" style="stroke:${s.color}"/>`;
    out += `<circle class="end-dot" cx="${x(n - 1)}" cy="${y(s.values[n - 1])}" r="4" style="fill:${s.color}"/>`;
  }
  for (const e of ends) {
    out += `<text class="end-label" x="${x(n - 1) + 8}" y="${e.y + 4}">${esc(e.s.name)} <tspan class="end-value">${e.v}</tspan></text>`;
  }
  const data = { titles, series: series.map((s) => ({ name: s.name, color: s.color, values: s.values })), m, w, h, n };
  out += `<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${h - m.b}" visibility="hidden"/>`;
  out += `<rect class="hit crosshair-hit" x="${m.l - 6}" y="${m.t}" width="${plotW + 12}" height="${plotH}" tabindex="0"
    data-line='${esc(JSON.stringify(data))}'/>`;
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img">${out}</svg>`;
}

/**
 * Horizontal bars for rates / counts (single series).
 * rows: [{ label, value (0..1 or count), text, detail }]
 */
export function hBars(rows, { max = 1, color = 'var(--series-1)' } = {}) {
  return `<div class="hbars">${rows.map((r) => `<div class="hbar" tabindex="0" data-tip='${esc(JSON.stringify({ title: r.label, lines: [[r.detail || r.text, r.text, color]] }))}'>
      <span class="hbar-label">${esc(r.label)}</span>
      <span class="hbar-track">${r.value == null ? '' : `<span class="hbar-fill" style="width:${Math.max(0.5, (r.value / max) * 100)}%;background:${color}"></span>`}</span>
      <span class="hbar-value">${esc(r.text)}</span></div>`).join('')}</div>`;
}

// ------------------------------------------------------------ tooltip layer

let tip;
function tooltip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  return tip;
}

function showTip(clientX, clientY, title, lines) {
  const t = tooltip();
  t.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-title';
  head.textContent = title;
  t.appendChild(head);
  for (const [name, value, color] of lines) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const key = document.createElement('span');
    key.className = 'tip-key';
    key.style.background = color;
    const v = document.createElement('b');
    v.textContent = value;
    const nm = document.createElement('span');
    nm.textContent = name;
    row.append(key, v, nm);
    t.appendChild(row);
  }
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, clientX - r.width / 2));
  const top = clientY - r.height - 14 < 8 ? clientY + 18 : clientY - r.height - 14;
  t.style.left = `${left + window.scrollX}px`;
  t.style.top = `${top + window.scrollY}px`;
}

export function hideTip() {
  if (tip) tip.hidden = true;
}

// Wire hover + keyboard focus tooltips for every chart inside `root`.
export function bindCharts(root) {
  root.querySelectorAll('[data-tip]').forEach((el) => {
    const { title, lines } = JSON.parse(el.dataset.tip);
    const show = (e) => {
      const b = el.getBoundingClientRect();
      const cx = e.clientX ?? b.left + b.width / 2;
      const cy = e.clientY ?? b.top;
      el.classList.add('hover');
      showTip(cx, cy, title, lines);
    };
    el.addEventListener('pointermove', show);
    el.addEventListener('focus', show);
    el.addEventListener('pointerleave', () => { el.classList.remove('hover'); hideTip(); });
    el.addEventListener('blur', () => { el.classList.remove('hover'); hideTip(); });
  });
  root.querySelectorAll('[data-line]').forEach((el) => {
    const d = JSON.parse(el.dataset.line);
    const svg = el.ownerSVGElement;
    const hair = svg.querySelector('.crosshair');
    const plotW = d.w - d.m.l - d.m.r;
    let idx = d.n - 1;
    const place = (i, clientX, clientY) => {
      idx = Math.max(0, Math.min(d.n - 1, i));
      const px = d.m.l + (d.n === 1 ? plotW / 2 : (plotW * idx) / (d.n - 1));
      hair.setAttribute('x1', px);
      hair.setAttribute('x2', px);
      hair.setAttribute('visibility', 'visible');
      const sb = svg.getBoundingClientRect();
      showTip(clientX ?? sb.left + px, clientY ?? sb.top + d.m.t, d.titles[idx],
        d.series.map((s) => [s.name, s.values[idx], s.color]));
    };
    el.addEventListener('pointermove', (e) => {
      const sb = svg.getBoundingClientRect();
      const px = ((e.clientX - sb.left) / sb.width) * d.w;
      place(Math.round(((px - d.m.l) / plotW) * (d.n - 1)), e.clientX, e.clientY);
    });
    el.addEventListener('focus', () => place(idx));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); place(idx - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); place(idx + 1); }
    });
    const hide = () => { hair.setAttribute('visibility', 'hidden'); hideTip(); };
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
  });
}

// Table view for any chart (identity never relies on color alone).
export function tableHtml(headers, rows) {
  return `<details class="table-view"><summary>Show as table</summary><div class="table-scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div></details>`;
}

export function legendHtml(series, shape = 'rect') {
  return `<div class="chart-legend">${series.map((s) => `<span><i class="lg-${shape}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`;
}
