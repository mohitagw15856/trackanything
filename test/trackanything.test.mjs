import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseAmount, detectCurrency, extract, titleOf, fromStructuredData, fromMeta, fromSelector, fromRegex, fromJsonPath } from '../src/extract/value.mjs';
import { select, textOf, decodeEntities, jsonLd, metaTags } from '../src/extract/html.mjs';
import { record, stats, addWatch, findWatch, newId, backoffMs } from '../src/store.mjs';
import { checkOne, checkAll, shouldNotify, isBlockStatus, challengeReason } from '../src/check.mjs';
import { headline, parseChannel, notify } from '../src/notify/index.mjs';
import { renderReport } from '../src/report.mjs';
import { seedDemo } from '../src/demo.mjs';
import { parseArgs, parseDuration, run } from '../src/cli.mjs';
import { PAGES, fixtureFetch } from '../fixtures/pages.mjs';

const isolate = () => {
  process.env.TRACKANYTHING_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-'));
};

// --- number parsing ----------------------------------------------------------

test('amounts parse in both hemispheres of punctuation', () => {
  assert.equal(parseAmount('£1,234.56'), 1234.56);
  assert.equal(parseAmount('1.234,56 €'), 1234.56);
  assert.equal(parseAmount('$99'), 99);
  assert.equal(parseAmount('12.99'), 12.99);
  assert.equal(parseAmount('1 234,50'), 1234.5);
  assert.equal(parseAmount('1.234.567,89'), 1234567.89);
  assert.equal(parseAmount(24.99), 24.99);
});

test('a lone group separator is not mistaken for a decimal point', () => {
  // "1,234" is 1234, not 1.234 -- the tell is exactly three digits after it.
  assert.equal(parseAmount('1,234'), 1234);
  assert.equal(parseAmount('1.234'), 1234);
  // But two digits after cannot be thousands.
  assert.equal(parseAmount('1,23'), 1.23);
});

test('text with no number yields nothing rather than zero', () => {
  assert.equal(parseAmount('Call for price'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount(undefined), null);
});

test('currency is read from a symbol or a code', () => {
  assert.equal(detectCurrency('£10'), 'GBP');
  assert.equal(detectCurrency('10 EUR'), 'EUR');
  assert.equal(detectCurrency('¥900'), 'JPY');
  assert.equal(detectCurrency('10'), null);
});

// --- HTML --------------------------------------------------------------------

test('script and style contents never leak into text', () => {
  const text = textOf('<style>.a{color:red}</style><script>var x=1</script><p>Hello</p>');
  assert.equal(text.trim(), 'Hello');
});

test('entities decode, including numeric ones', () => {
  assert.equal(decodeEntities('&pound;10 &amp; &#163;20 &#xA3;30'), '£10 & £20 £30');
});

test('a malformed entity is left alone rather than mangled', () => {
  assert.equal(decodeEntities('&notarealentity;'), '&notarealentity;');
});

test('json-ld blocks are found and flattened through @graph', () => {
  const html = `<script type="application/ld+json">
    {"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"X","offers":{"price":"5"}}]}
  </script>`;
  const names = jsonLd(html).map((n) => n['@type']).filter(Boolean);
  assert.ok(names.includes('Product'));
});

test('a broken json-ld block does not take the page down', () => {
  assert.deepEqual(jsonLd('<script type="application/ld+json">{not json</script>'), []);
});

test('meta tags are read by property, name or itemprop', () => {
  const tags = metaTags('<meta property="og:title" content="A"><meta name="price" content="9">');
  assert.equal(tags['og:title'], 'A');
  assert.equal(tags['price'], '9');
});

// --- the selector engine -----------------------------------------------------

const NESTED = `<div class="a"><p>outer</p><div id="b"><span class="c">target</span></div></div>`;

test('descendant selectors reach a nested element', () => {
  assert.equal(textOf(select(NESTED, '.a #b .c')[0].inner), 'target');
  assert.equal(textOf(select(NESTED, '#b .c')[0].inner), 'target');
});

test('a selector that matches nothing returns nothing', () => {
  assert.deepEqual(select(NESTED, '.nope'), []);
});

test('select returns the tag as well as the contents', () => {
  const [hit] = select('<span class="c" data-x="7">£5</span>', '.c');
  assert.match(hit.tag, /^<span/);
  assert.equal(hit.inner, '£5');
});

test('attribute selectors work, with and without an operator', () => {
  const html = '<a data-price="9.99" class="x">Buy</a>';
  assert.equal(select(html, '[data-price]').length, 1);
  assert.equal(select(html, '[data-price="9.99"]').length, 1);
  assert.equal(select(html, '[data-price="1"]').length, 0);
});

test('void elements do not swallow the rest of the document', () => {
  const html = '<div class="p"><img src="x.png"><span>£5</span></div>';
  assert.match(textOf(select(html, '.p span')[0].inner), /5/);
});

test('the first match wins, so page furniture before the product loses', () => {
  // The desk fixture deliberately has a decoy .price in the breadcrumb.
  const found = fromSelector(PAGES['https://demo.local/desk']({ price: 389 }), '#product .now');
  assert.equal(found.value, 389);
});

// --- extraction preference order --------------------------------------------

test('structured data is used when it is there, with no selector needed', () => {
  const found = extract(PAGES['https://demo.local/headphones']({ price: 249.99 }));
  assert.equal(found.value, 249.99);
  assert.equal(found.currency, 'GBP');
  assert.equal(found.available, true);
  assert.equal(found.source, 'json-ld');
});

test('availability is read from schema.org', () => {
  const out = fromStructuredData(PAGES['https://demo.local/headphones']({ stock: false }));
  assert.equal(out.available, false);
});

test('meta tags are the fallback when there is no json-ld', () => {
  const found = extract(PAGES['https://demo.local/kettle']({ price: 64 }));
  assert.equal(found.value, 64);
  assert.equal(found.source, 'meta');
});

test('a page with neither yields nothing, rather than a wrong number', () => {
  assert.equal(extract(PAGES['https://demo.local/desk']({})), null);
});

test('an explicit selector overrides the automatic path', () => {
  const html = PAGES['https://demo.local/headphones']({ price: 249.99 });
  const found = extract(html, { selector: '.price' });
  assert.equal(found.source, 'selector');
});

test('an attribute can be read instead of the text', () => {
  const html = PAGES['https://demo.local/desk']({ price: 389 });
  const found = extract(html, { selector: '#product .now', attribute: 'data-price' });
  assert.equal(found.value, 389);
});

test('a json path reaches into an API response', () => {
  const body = PAGES['https://demo.local/api/lens']({ price: 1099 });
  assert.equal(extract(body, { jsonPath: 'data.product.pricing.current' }).value, 1099);
  assert.equal(fromJsonPath(body, 'data.nope.here'), null);
});

test('a regex is available for the pages that defeat everything else', () => {
  const found = fromRegex('<p>Now only 42.50 quid</p>', 'only ([\\d.]+)');
  assert.equal(found.value, 42.5);
});

test('an aggregate offer uses the low price the page leads with', () => {
  const found = extract(PAGES['https://demo.local/bike']({ price: 1249.5 }));
  assert.equal(found.value, 1249.5);
  assert.equal(found.currency, 'EUR');
});

test('the page names itself, so --name is optional', () => {
  assert.equal(titleOf(PAGES['https://demo.local/headphones']({})), 'Aurora Over-Ear Headphones');
  assert.match(titleOf('<title>Plain Page</title>'), /Plain Page/);
});

// --- fetching ----------------------------------------------------------------

test('a successful check reads the value', async () => {
  const r = await checkOne({ url: 'https://demo.local/headphones' }, { fetchImpl: fixtureFetch() });
  assert.equal(r.value, 249.99);
  assert.equal(r.error, undefined);
});

test('a 404 is an error on the reading, not an exception', async () => {
  const r = await checkOne({ url: 'https://demo.local/nope' }, { fetchImpl: fixtureFetch() });
  assert.match(r.error, /HTTP 404/);
});

test('a challenge page is reported as a block, not a missing selector', async () => {
  const r = await checkOne({ url: 'https://demo.local/blocked' }, { fetchImpl: fixtureFetch() });
  assert.equal(r.blocked, true);
  assert.match(r.error, /blocked/);
  assert.match(r.error, /anti-bot|challenge/);
  assert.doesNotMatch(r.error, /--selector/);
});

test('a hard refusal status is a block whatever the body contains', async () => {
  const r = await checkOne(
    { url: 'https://demo.local/headphones' },
    { fetchImpl: fixtureFetch({}, { 'https://demo.local/headphones': 403 }) }
  );
  assert.equal(r.blocked, true);
  assert.match(r.error, /blocked/);
  assert.match(r.error, /403/);
});

test('block detection does not fire on an ordinary product page', async () => {
  assert.equal(challengeReason(PAGES['https://demo.local/headphones']()), null);
  assert.equal(isBlockStatus(200), false);
  assert.equal(isBlockStatus(403), true);
  assert.equal(isBlockStatus(429), true);
});

test('a selector that stops matching says which selector', async () => {
  const r = await checkOne(
    { url: 'https://demo.local/desk', selector: '.gone' },
    { fetchImpl: fixtureFetch() }
  );
  assert.match(r.error, /\.gone/);
});

test('a network failure is caught and reported', async () => {
  const boom = async () => {
    throw new Error('ECONNREFUSED');
  };
  const r = await checkOne({ url: 'https://x' }, { fetchImpl: boom });
  assert.equal(r.error, 'ECONNREFUSED');
});

// --- history -----------------------------------------------------------------

const watch = () => ({ id: 'x', url: 'u', history: [], notifyOn: 'change', target: null });

test('an unchanged price extends the existing point rather than adding one', () => {
  const w = watch();
  record(w, { value: 10 }, '2026-01-01T00:00:00Z');
  record(w, { value: 10 }, '2026-01-02T00:00:00Z');
  record(w, { value: 10 }, '2026-01-03T00:00:00Z');
  assert.equal(w.history.length, 1);
  assert.equal(w.history[0].to, '2026-01-03T00:00:00Z');
  assert.equal(w.history[0].checks, 3);
});

test('a changed price starts a new point', () => {
  const w = watch();
  record(w, { value: 10 }, '2026-01-01T00:00:00Z');
  const out = record(w, { value: 8 }, '2026-01-02T00:00:00Z');
  assert.equal(w.history.length, 2);
  assert.equal(out.changed, true);
  assert.equal(out.previous, 10);
});

test('the first reading is a baseline, not a change', () => {
  const w = watch();
  const out = record(w, { value: 10 });
  assert.equal(out.changed, false);
  assert.equal(out.first, true);
});

test('a failed check does not corrupt the history', () => {
  const w = watch();
  record(w, { value: 10 });
  record(w, { error: 'HTTP 503' });
  assert.equal(w.history.length, 1);
  assert.equal(w.lastError, 'HTTP 503');
});

test('stats find the low, the high and whether now is the low', () => {
  const w = watch();
  for (const v of [100, 80, 120, 80]) record(w, { value: v }, new Date(Date.now() + v).toISOString());
  const s = stats(w);
  assert.equal(s.low, 80);
  assert.equal(s.high, 120);
  assert.equal(s.current, 80);
  assert.equal(s.isLow, true);
});

// --- notification rules ------------------------------------------------------

const rule = (notifyOn, target = null) => ({ ...watch(), notifyOn, target });

test('change notifies on any move, drop only on the way down', () => {
  assert.equal(shouldNotify(rule('change'), { changed: true, previous: 10 }, { value: 12 }), true);
  assert.equal(shouldNotify(rule('drop'), { changed: true, previous: 10 }, { value: 12 }), false);
  assert.equal(shouldNotify(rule('drop'), { changed: true, previous: 10 }, { value: 8 }), true);
});

test('target fires once, on the crossing', () => {
  const w = rule('target', 50);
  assert.equal(shouldNotify(w, { changed: true, previous: 60 }, { value: 45 }), true);
  // Already below: a second check must not fire again.
  assert.equal(shouldNotify(w, { changed: true, previous: 45 }, { value: 44 }), false);
});

test('back-in-stock fires even when the price did not move', () => {
  const w = rule('stock');
  const out = { changed: false, previous: 10, previousAvailable: false };
  assert.equal(shouldNotify(w, out, { value: 10, available: true }), true);
});

test('never means never, and the first reading never notifies', () => {
  assert.equal(shouldNotify(rule('never'), { changed: true, previous: 10 }, { value: 1 }), false);
  assert.equal(shouldNotify(rule('change'), { first: true }, { value: 10 }), false);
});

test('an errored check notifies nobody', () => {
  assert.equal(shouldNotify(rule('change'), { changed: true, previous: 10 }, { error: 'HTTP 500' }), false);
});

// --- messages ----------------------------------------------------------------

const result = (over = {}) => ({
  watch: { name: 'Headphones', url: 'https://x', target: null },
  reading: { value: 80, currency: 'GBP' },
  previous: 100,
  stats: { current: 80, low: 80, high: 100, isLow: true },
  ...over,
});

test('a drop is described as a drop, with the percentage', () => {
  assert.match(headline(result()), /dropped 20% to £80\.00/);
  assert.match(headline(result()), /lowest it has been/);
});

test('a rise is described as a rise', () => {
  assert.match(headline(result({ reading: { value: 120, currency: 'GBP' }, stats: null })), /went up 20%/);
});

test('back in stock leads with being back in stock', () => {
  const r = result({ reading: { value: 80, currency: 'GBP', available: true }, previousAvailable: false });
  assert.match(headline(r), /back in stock/);
});

test('channel specs parse, and a bad one says what the shape is', () => {
  assert.deepEqual(parseChannel('ntfy:my-topic'), { type: 'ntfy', target: 'my-topic' });
  assert.deepEqual(parseChannel('discord:https://x/y'), { type: 'discord', target: 'https://x/y' });
  assert.deepEqual(parseChannel('stdout'), { type: 'stdout', target: '' });
  assert.throws(() => parseChannel('carrier-pigeon:home'), /unknown channel/);
  assert.throws(() => parseChannel('nonsense'), /type:target/);
});

test('one failing channel does not stop the others', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('bad')) return { ok: false, status: 500 };
    return { ok: true, status: 200 };
  };
  const out = await notify(result(), [
    { type: 'webhook', target: 'https://bad/hook' },
    { type: 'webhook', target: 'https://good/hook' },
  ], { fetchImpl });
  assert.equal(out.sent.length, 1);
  assert.equal(out.failed.length, 1);
  assert.equal(calls.length, 2);
});

// --- CLI ---------------------------------------------------------------------

test('durations parse', () => {
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('6h'), 21600);
  assert.equal(parseDuration('2d'), 172800);
  assert.throws(() => parseDuration('soon'), /durations look like/);
});

test('argument parsing', () => {
  const o = parseArgs(['add', 'https://x', '--name', 'Thing', '--target', '9.99']);
  assert.equal(o.cmd, 'add');
  assert.deepEqual(o.args, ['https://x']);
  assert.equal(o.name, 'Thing');
  assert.equal(o.target, 9.99);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});

test('add stores a watch and reads it once immediately', async () => {
  isolate();
  const { stdout } = await run(['add', 'https://demo.local/headphones'], { fetchImpl: fixtureFetch() });
  assert.match(stdout, /Watching/);
  assert.match(stdout, /Aurora Over-Ear Headphones/);
  assert.match(stdout, /No selector needed/);
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /249\.99/);
});

test('add refuses a page it cannot read, rather than storing a broken watch', async () => {
  isolate();
  await assert.rejects(
    () => run(['add', 'https://demo.local/desk'], { fetchImpl: fixtureFetch() }),
    /--selector/
  );
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /Nothing watched yet/);
});

test('add tells you a page is blocked, and does not suggest a selector', async () => {
  isolate();
  await assert.rejects(
    () => run(['add', 'https://demo.local/blocked'], { fetchImpl: fixtureFetch() }),
    (err) => {
      assert.match(err.message, /blocked|anti-bot/);
      assert.match(err.message, /--cookie/);
      assert.doesNotMatch(err.message, /trackanything test <url> --selector/);
      return true;
    }
  );
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /Nothing watched yet/);
});

test('an invalid --on is refused up front', async () => {
  isolate();
  await assert.rejects(
    () => run(['add', 'https://demo.local/headphones', '--on', 'whenever'], { fetchImpl: fixtureFetch() }),
    /--on must be one of/
  );
});

test('check records a drop and reports it', async () => {
  isolate();
  await run(['add', 'https://demo.local/headphones'], { fetchImpl: fixtureFetch() });
  const cheaper = fixtureFetch({ 'https://demo.local/headphones': { price: 199.99 } });
  const { stdout } = await run(['check', '--force'], { fetchImpl: cheaper });
  assert.match(stdout, /1 changed/);
  assert.match(stdout, /199\.99/);
});

test('test does not save anything', async () => {
  isolate();
  const { stdout } = await run(['test', 'https://demo.local/kettle'], { fetchImpl: fixtureFetch() });
  assert.match(stdout, /64\.00/);
  assert.match(stdout, /Nothing was saved/);
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /Nothing watched yet/);
});

// --- blocking: detect, report, back off, bring your own session --------------

test('backoff grows per consecutive block and is capped at a day', () => {
  assert.equal(backoffMs(1), 3_600_000);
  assert.equal(backoffMs(2), 7_200_000);
  assert.equal(backoffMs(3), 14_400_000);
  assert.equal(backoffMs(100), 86_400_000);
});

test('a block sets a retry time; a good read clears it', () => {
  const watch = addWatch({ version: 1, watches: [] }, { url: 'https://demo.local/x' });
  record(watch, { blocked: true, error: 'blocked — nope' }, '2026-01-01T00:00:00.000Z');
  assert.equal(watch.blockStreak, 1);
  assert.equal(watch.blockedUntil, '2026-01-01T01:00:00.000Z');
  record(watch, { blocked: true, error: 'blocked — nope' }, '2026-01-01T01:00:00.000Z');
  assert.equal(watch.blockStreak, 2);
  assert.equal(watch.blockedUntil, '2026-01-01T03:00:00.000Z'); // +2h
  record(watch, { value: 10 }, '2026-01-01T03:00:00.000Z');
  assert.equal(watch.blockStreak, 0);
  assert.equal(watch.blockedUntil, null);
});

test('an ordinary (non-block) error does not start a backoff', () => {
  const watch = addWatch({ version: 1, watches: [] }, { url: 'https://demo.local/x' });
  record(watch, { error: 'selector ".gone" matched nothing' }, '2026-01-01T00:00:00.000Z');
  assert.equal(watch.blockStreak, 0);
  assert.equal(watch.blockedUntil, null);
});

test('a blocked watch is left alone until its backoff expires, but --force tries it', async () => {
  isolate();
  await run(['add', 'https://demo.local/headphones'], { fetchImpl: fixtureFetch() });
  // The site starts blocking. A forced check hits it and records the block.
  const blocking = fixtureFetch({}, { 'https://demo.local/headphones': 403 });
  const blocked = await run(['check', '--force'], { fetchImpl: blocking });
  assert.match(blocked.stdout, /blocked/);

  // A normal check now skips it rather than knocking again.
  const skipped = await run(['check'], { fetchImpl: fixtureFetch() });
  assert.match(skipped.stdout, /0 checked/);

  // --force overrides the backoff; the site is readable again, which clears it.
  const forced = await run(['check', '--force'], { fetchImpl: fixtureFetch() });
  assert.match(forced.stdout, /1 checked/);
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.doesNotMatch(list.stdout, /blocked/);
});

test('list shows a blocked watch as backing off, with a retry time', async () => {
  isolate();
  await run(['add', 'https://demo.local/headphones'], { fetchImpl: fixtureFetch() });
  await run(['check', '--force'], { fetchImpl: fixtureFetch({}, { 'https://demo.local/headphones': 403 }) });
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /blocked/);
  assert.match(list.stdout, /retrying/);
});

test('--cookie and --header are sent on every check, and stored on the watch', async () => {
  isolate();
  let seen = null;
  const spy = async (url, init) => {
    seen = init.headers;
    return { ok: true, status: 200, text: async () => PAGES['https://demo.local/headphones']() };
  };
  await run(
    ['add', 'https://demo.local/headphones', '--cookie', 'session=abc123', '--header', 'X-From: me'],
    { fetchImpl: spy }
  );
  assert.equal(seen.Cookie, 'session=abc123');
  assert.equal(seen['X-From'], 'me');
  // And they persist, so the next check sends them too.
  const list = await run(['list', '--json'], { fetchImpl: fixtureFetch() });
  const stored = JSON.parse(list.stdout)[0];
  assert.equal(stored.headers.Cookie, 'session=abc123');
  assert.equal(stored.headers['X-From'], 'me');
});

test('a header with no colon is rejected with a helpful message', () => {
  assert.throws(() => parseArgs(['add', 'url', '--header', 'nope']), /Name: value/);
});

test('watches are found by id, name or fragment', async () => {
  isolate();
  await run(['add', 'https://demo.local/headphones', '--name', 'Cans'], { fetchImpl: fixtureFetch() });
  for (const needle of ['Cans', 'cans', 'headphones']) {
    const { stdout } = await run(['history', needle], { fetchImpl: fixtureFetch() });
    assert.match(stdout, /249\.99/, needle);
  }
  await assert.rejects(() => run(['history', 'nothing'], { fetchImpl: fixtureFetch() }), /nothing matches/);
});

test('pause stops a watch being checked; resume restarts it', async () => {
  isolate();
  await run(['add', 'https://demo.local/kettle'], { fetchImpl: fixtureFetch() });
  await run(['pause', 'kettle'], { fetchImpl: fixtureFetch() });
  const paused = await run(['check'], { fetchImpl: fixtureFetch() });
  assert.match(paused.stdout, /0 checked/);
  await run(['resume', 'kettle'], { fetchImpl: fixtureFetch() });
  const resumed = await run(['check'], { fetchImpl: fixtureFetch() });
  assert.match(resumed.stdout, /1 checked/);
});

test('remove deletes it', async () => {
  isolate();
  await run(['add', 'https://demo.local/kettle'], { fetchImpl: fixtureFetch() });
  const { stdout } = await run(['remove', 'kettle'], { fetchImpl: fixtureFetch() });
  assert.match(stdout, /Removed/);
  const list = await run(['list'], { fetchImpl: fixtureFetch() });
  assert.match(list.stdout, /Nothing watched yet/);
});

test('--every stops a watch being hammered', async () => {
  isolate();
  await run(['add', 'https://demo.local/kettle', '--every', '6h'], { fetchImpl: fixtureFetch() });
  const soon = await run(['check'], { fetchImpl: fixtureFetch() });
  assert.match(soon.stdout, /0 checked/);
  const forced = await run(['check', '--force'], { fetchImpl: fixtureFetch() });
  assert.match(forced.stdout, /1 checked/);
});

test('a duplicate watch is refused with the id to remove', async () => {
  isolate();
  await run(['add', 'https://demo.local/kettle'], { fetchImpl: fixtureFetch() });
  await assert.rejects(
    () => run(['add', 'https://demo.local/kettle'], { fetchImpl: fixtureFetch() }),
    /already watching/
  );
});

test('the same url with a different selector is a different watch', () => {
  assert.notEqual(newId('https://x' + '.a'), newId('https://x' + '.b'));
});

// --- report ------------------------------------------------------------------

test('the report is self-contained and mentions every watch', () => {
  const db = seedDemo();
  const html = renderReport(db, { now: '2026-08-25 09:00' });
  assert.match(html, /<!doctype html>/);
  assert.ok(!/<script/i.test(html), 'the report should ship no javascript');
  assert.ok(!/src="https?:/i.test(html), 'the report must not load anything remote');
  assert.ok(!html.includes('undefined'));
  for (const w of db.watches) assert.ok(html.includes(w.name), `${w.name} missing`);
});

test('the chart is a step chart, because a price is a step function', () => {
  const html = renderReport(seedDemo());
  // A step path only ever moves horizontally then vertically: no diagonal segments,
  // which would draw prices that were never charged.
  const path = /<path d="([^"]+)"/.exec(html)[1];
  const points = [...path.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [+m[1], +m[2]]);
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    assert.ok(x0 === x1 || y0 === y1, `diagonal segment at ${i}`);
  }
});

test('the demo needs no network and is deterministic', async () => {
  isolate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-r-'));
  const out = path.join(dir, 'r.html');
  const explode = async () => {
    throw new Error('the demo must not fetch');
  };
  const { stdout } = await run(['demo', out], { fetchImpl: explode });
  assert.match(stdout, /Aurora Over-Ear Headphones/);
  assert.ok(fs.existsSync(out));
  assert.deepEqual(seedDemo(), seedDemo());
});
