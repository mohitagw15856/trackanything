import { stats, currentValue } from './store.mjs';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', INR: '₹' };
const money = (v, cur) =>
  v == null ? '—' : `${SYMBOLS[cur] || (cur ? cur + ' ' : '')}${Number(v).toFixed(2)}`;

/**
 * A step chart, because a price is a step function: it was £40 until Tuesday, then
 * it was £32. Joining those with a diagonal would draw a week of prices that never
 * existed.
 */
function sparkline(history, { w = 420, h = 90, pad = 6 } = {}) {
  const points = history.filter((p) => typeof p.value === 'number');
  if (points.length < 2) return '';
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || max || 1;

  const t0 = Date.parse(points[0].from);
  const t1 = Date.parse(points[points.length - 1].to);
  const width = t1 - t0 || 1;
  const x = (t) => pad + ((Date.parse(t) - t0) / width) * (w - pad * 2);
  const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);

  let d = '';
  points.forEach((p, i) => {
    const x0 = x(p.from);
    const x1 = x(p.to);
    d += i === 0 ? `M${x0.toFixed(1)},${y(p.value).toFixed(1)}` : `L${x0.toFixed(1)},${y(p.value).toFixed(1)}`;
    d += `L${x1.toFixed(1)},${y(p.value).toFixed(1)}`;
    const next = points[i + 1];
    if (next) d += `L${x(next.from).toFixed(1)},${y(p.value).toFixed(1)}`;
  });

  const last = points[points.length - 1];
  const isLow = last.value === min;
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" role="img" aria-label="price history">
    <path d="${d}" fill="none" stroke="${isLow ? 'var(--good)' : 'var(--accent)'}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(last.to).toFixed(1)}" cy="${y(last.value).toFixed(1)}" r="3.5" fill="${isLow ? 'var(--good)' : 'var(--accent)'}"/>
  </svg>`;
}

function card(w) {
  const s = stats(w);
  const last = w.history[w.history.length - 1];
  const cur = currentValue(w);
  const currency = last?.currency;
  const flags = [
    s?.isLow ? '<span class="flag good">lowest yet</span>' : '',
    w.target != null && cur != null && cur <= w.target ? '<span class="flag good">under your target</span>' : '',
    last?.available === false ? '<span class="flag">out of stock</span>' : '',
    w.paused ? '<span class="flag">paused</span>' : '',
    w.lastError ? `<span class="flag bad">${esc(w.lastError)}</span>` : '',
  ].join('');

  const change =
    s && s.changes > 0 && s.first
      ? (() => {
          const pct = Math.round(((s.current - s.first) / s.first) * 100);
          if (pct === 0) return '<span class="muted">unchanged since you started watching</span>';
          return pct < 0
            ? `<span class="good">down ${Math.abs(pct)}% since you started watching</span>`
            : `<span class="bad">up ${pct}% since you started watching</span>`;
        })()
      : '<span class="muted">no change yet</span>';

  return `<article>
    <header>
      <h2><a href="${esc(w.url)}" rel="noreferrer">${esc(w.name || w.url)}</a></h2>
      <div class="price ${s?.isLow ? 'low' : ''}">${money(cur, currency)}</div>
    </header>
    <div class="flags">${flags}</div>
    ${sparkline(w.history)}
    <dl>
      <div><dt>low</dt><dd>${money(s?.low, currency)}</dd></div>
      <div><dt>high</dt><dd>${money(s?.high, currency)}</dd></div>
      <div><dt>changes</dt><dd>${s?.changes ?? 0}</dd></div>
      ${w.target != null ? `<div><dt>target</dt><dd>${money(w.target, currency)}</dd></div>` : ''}
    </dl>
    <p class="since">${change}</p>
  </article>`;
}

export function renderReport(db, { now = new Date().toISOString().slice(0, 16).replace('T', ' ') } = {}) {
  const watches = [...db.watches].sort((a, b) => {
    const as = stats(a);
    const bs = stats(b);
    return (bs?.isLow ? 1 : 0) - (as?.isLow ? 1 : 0);
  });
  const lows = watches.filter((w) => stats(w)?.isLow).length;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>trackanything — ${watches.length} watches</title>
<style>
:root{--bg:#fbfaf9;--panel:#fff;--ink:#1a1a1a;--muted:#6b6b6b;--line:#e6e3df;--accent:#3b6ea5;--good:#2f855a;--bad:#c0392b;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--panel:#1c1c1c;--ink:#f0eeec;--muted:#9a9a9a;--line:#2c2c2c;--accent:#7aa7dd;--good:#4ade80;--bad:#ff6b5e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;padding:32px 20px 72px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 6px;font-weight:600}
.sub{color:var(--muted);margin:0 0 28px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
article{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
h2{font-size:15px;margin:0;font-weight:600;line-height:1.3}
h2 a{color:inherit;text-decoration:none}
h2 a:hover{text-decoration:underline}
.price{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
.price.low{color:var(--good)}
.flags{margin:8px 0 0;min-height:0}
.flag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted);margin:0 4px 4px 0}
.flag.good{color:var(--good);border-color:var(--good)}
.flag.bad{color:var(--bad);border-color:var(--bad)}
.spark{width:100%;height:auto;display:block;margin:10px 0 4px}
dl{display:flex;gap:18px;margin:6px 0 0;flex-wrap:wrap}
dt{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
dd{margin:0;font-variant-numeric:tabular-nums;font-weight:600}
.since{font-size:13px;margin:10px 0 0}
.good{color:var(--good)}.bad{color:var(--bad)}.muted{color:var(--muted)}
footer{color:var(--muted);font-size:12px;text-align:center;margin-top:32px}
</style></head><body><div class="wrap">
<h1>trackanything</h1>
<p class="sub">${watches.length} watches${lows ? ` · <strong class="good">${lows} at their lowest recorded price</strong>` : ''} · generated ${esc(now)}</p>
<div class="grid">${watches.map(card).join('')}</div>
<footer>Read from a file on your machine. Nothing was uploaded.</footer>
</div></body></html>`;
}
