import { extract, titleOf } from './extract/value.mjs';
import { record, stats } from './store.mjs';

// A real browser User-Agent. Not to be sneaky: a lot of CDNs serve a challenge
// page to anything that looks scripted, and a challenge page has no price on it.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};

export async function fetchPage(url, { fetchImpl = fetch, timeout = 20000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      headers: { ...DEFAULT_HEADERS, ...headers },
      redirect: 'follow',
      signal: controller.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** One watch, one reading. Never throws: a failed check is data, not a crash. */
export async function checkOne(watch, opts = {}) {
  try {
    const res = await fetchPage(watch.url, opts);
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const found = extract(res.body, watch);
    if (!found || found.value == null) {
      return {
        error: watch.selector
          ? `selector "${watch.selector}" matched nothing with a number in it`
          : 'no price found — this page publishes no structured data, so it needs a --selector',
      };
    }
    return {
      value: found.value,
      currency: found.currency ?? watch.currency ?? null,
      available: found.available ?? null,
      source: found.source,
      title: watch.name ? null : titleOf(res.body),
    };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timed out' : err.message };
  }
}

/** Should this reading wake somebody up? */
export function shouldNotify(watch, outcome, reading) {
  if (outcome.first) return false; // the first reading is a baseline, not news
  const rule = watch.notifyOn || 'change';
  if (rule === 'never') return false;
  if (reading.error) return false;

  const dropped = outcome.previous != null && reading.value < outcome.previous;
  const backInStock = reading.available === true && outcome.previousAvailable === false;

  if (rule === 'drop') return dropped || backInStock;
  if (rule === 'target') {
    return watch.target != null && reading.value <= watch.target && (outcome.previous ?? Infinity) > watch.target;
  }
  if (rule === 'stock') return backInStock;
  return outcome.changed || backInStock;
}

/**
 * Check every due watch. Concurrency is deliberately low: this is somebody's home
 * server hitting somebody else's shop, and twenty parallel requests to one host is
 * how you get blocked.
 */
export async function checkAll(db, { concurrency = 3, only = null, force = false, now = () => new Date(), ...opts } = {}) {
  const due = db.watches.filter((w) => {
    if (only && w.id !== only.id) return false;
    if (w.paused && !force) return false;
    if (force || !w.every) return true;
    const last = w.history[w.history.length - 1];
    if (!last) return true;
    return Date.parse(now().toISOString()) - Date.parse(last.to) >= w.every * 1000;
  });

  const results = [];
  const queue = [...due];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const watch = queue.shift();
      const reading = await checkOne(watch, opts);
      const previousPoint = watch.history[watch.history.length - 1];
      const previousAvailable = previousPoint?.available ?? null;
      const outcome = record(watch, reading, now().toISOString());
      outcome.previousAvailable = previousAvailable;
      if (reading.title && !watch.name) watch.name = reading.title;
      results.push({
        watch,
        reading,
        ...outcome,
        notify: shouldNotify(watch, outcome, reading),
        stats: stats(watch),
      });
    }
  });
  await Promise.all(workers);
  return { checked: results.length, skipped: db.watches.length - due.length, results };
}
