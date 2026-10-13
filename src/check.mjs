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

// A block is not a bug to engineer around. We detect it only so it can be
// reported honestly and so we can stop knocking on a door that has been shut:
// no retrying harder, no second identity, no challenge solving. If a site does
// not want to be read by a script, the correct outcome is that it is not read.

// Status codes a site serves when it is refusing the request outright.
const BLOCK_STATUS = new Set([401, 403, 429, 451, 503]);

// Fingerprints of the interstitial pages that come back with a 200 but carry no
// product — the "Just a moment…" wall people actually hit. Matched only against
// the top of the document, where these always sit, so a product page that merely
// mentions one of these words in its body is not mistaken for a challenge.
const CHALLENGE_MARKERS = [
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
  /cf[-_]chl|cf-browser-verification|challenge-platform|turnstile/i, // Cloudflare
  /px-captcha|_pxhd|perimeterx/i, // PerimeterX
  /datadome/i, // DataDome
  /distil_r_|imperva|incapsula/i, // Imperva / Incapsula
  /attention required/i,
  /unusual traffic|automated queries/i,
  /pardon our interruption/i,
  /access denied|request blocked/i,
  /\/recaptcha\/api|g-recaptcha|hcaptcha/i,
  /are you a human|verify you are human/i,
];

export function isBlockStatus(status) {
  return BLOCK_STATUS.has(status);
}

/**
 * Does this 200-OK body look like an anti-bot wall rather than the page we asked
 * for? Returns a short reason, or null. Only the first few KB are inspected, both
 * for speed and to keep the markers anchored to where challenges actually live.
 */
export function challengeReason(body) {
  const head = String(body ?? '').slice(0, 4000);
  for (const re of CHALLENGE_MARKERS) {
    if (re.test(head)) return 'the site served an anti-bot challenge page, not the product';
  }
  return null;
}

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
    // A watch may carry headers you supplied (a session cookie for a site you
    // have an account on, say). They win over the defaults, and over anything the
    // caller passed, because they are the most specific thing we know.
    const headers = { ...(opts.headers || {}), ...(watch.headers || {}) };
    const res = await fetchPage(watch.url, { ...opts, headers });

    // A hard refusal is a block whatever the body says.
    if (isBlockStatus(res.status)) {
      return { error: `blocked — the site refused the request (HTTP ${res.status})`, blocked: true };
    }
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const found = extract(res.body, watch);
    if (!found || found.value == null) {
      // Before blaming a selector, check whether the page is a challenge wall. It
      // has no price on it because it is not the page we asked for.
      const challenge = challengeReason(res.body);
      if (challenge) return { error: `blocked — ${challenge}`, blocked: true };
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
  const nowIso = now().toISOString();
  const due = db.watches.filter((w) => {
    if (only && w.id !== only.id) return false;
    if (w.paused && !force) return false;
    // Honour an active backoff: a site that is blocking us is left alone until
    // its retry time, so repeated checks do not turn into repeated knocking.
    // `--force` is the deliberate "try it anyway" and overrides this.
    if (!force && w.blockedUntil && Date.parse(w.blockedUntil) > Date.parse(nowIso)) return false;
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
