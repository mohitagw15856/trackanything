import fs from 'node:fs';
import path from 'node:path';
import { load, save, addWatch, findWatch, stats, currentValue, dbPath } from './store.mjs';
import { checkAll, checkOne } from './check.mjs';
import { notify, parseChannel, headline } from './notify/index.mjs';
import { renderReport } from './report.mjs';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const green = c('32');
const red = c('31');
const yellow = c('33');
const cyan = c('36');
const mag = c('35');

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - plain(s).length));
const padL = (s, n) => ' '.repeat(Math.max(0, n - plain(s).length)) + String(s);

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', INR: '₹' };
export const money = (v, cur) =>
  v == null ? '—' : `${SYMBOLS[cur] || (cur ? cur + ' ' : '')}${Number(v).toFixed(2)}`;

const HELP = `
trackanything -- watch a price on any page, without paying for the privilege.

  trackanything add <url> [--name "Thing"]     start watching
  trackanything check                          check everything now
  trackanything list                           what you are watching
  trackanything history <id|name>              every price it has been
  trackanything report [out.html]              a page of charts
  trackanything remove <id|name>
  trackanything pause|resume <id|name>
  trackanything test <url>                     try extraction without saving
  trackanything demo                           seed fake watches and open a report

Add options
  --name <text>            what to call it (default: the page's own title)
  --selector <css>         for pages with no structured data
  --attribute <name>       read an attribute instead of the text
  --regex <pattern>        last resort; first capture group is the value
  --json-path <a.b.0.c>    for JSON APIs
  --target <number>        the price you would actually buy at
  --on <change|drop|target|stock|never>   when to notify (default: change)
  --every <duration>       minimum gap between checks, e.g. 6h, 30m, 1d

Check options
  --notify <type:target>   repeatable. ntfy:topic, discord:URL, slack:URL,
                           webhook:URL, command:"notify-send", stdout
  --only <id|name>         one watch
  --force                  ignore --every and paused
  --quiet                  only print things that changed

Everything is stored in ~/.trackanything/watches.json. Nothing is uploaded, and
there is no account to make.
`;

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/i;
export function parseDuration(spec) {
  const m = DURATION.exec(String(spec).trim());
  if (!m) throw new Error(`durations look like 30m, 6h, 2d (got "${spec}")`);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
  return Math.round(Number(m[1]) * mult);
}

export function parseArgs(argv) {
  const o = { cmd: null, args: [], notify: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-h' || a === '--help') o.cmd = 'help';
    else if (a === '--name') o.name = next();
    else if (a === '--selector') o.selector = next();
    else if (a === '--attribute') o.attribute = next();
    else if (a === '--regex') o.regex = next();
    else if (a === '--json-path') o.jsonPath = next();
    else if (a === '--target') o.target = Number(next());
    else if (a === '--on') o.notifyOn = next();
    else if (a === '--every') o.every = parseDuration(next());
    else if (a === '--notify') o.notify.push(parseChannel(next()));
    else if (a === '--only') o.only = next();
    else if (a === '--force') o.force = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else if (!o.cmd) o.cmd = a;
    else o.args.push(a);
  }
  return o;
}

const VALID_ON = ['change', 'drop', 'target', 'stock', 'never'];

export async function run(argv, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const o = parseArgs(argv);
  if (!o.cmd || o.cmd === 'help') return { stdout: HELP };
  const db = load();

  const resolve = (needle) => {
    const w = findWatch(db, needle);
    if (!w) throw new Error(`nothing matches "${needle}". Try \`trackanything list\`.`);
    return w;
  };

  switch (o.cmd) {
    case 'add': {
      const url = o.args[0];
      if (!url) throw new Error('a URL, please: trackanything add https://…');
      if (o.notifyOn && !VALID_ON.includes(o.notifyOn)) {
        throw new Error(`--on must be one of: ${VALID_ON.join(', ')}`);
      }
      const watch = addWatch(db, { ...o, url });
      // Check once immediately: adding a watch that silently cannot read the page
      // is worse than an error, because you find out weeks later.
      const reading = await checkOne(watch, { fetchImpl });
      if (reading.error) {
        db.watches.pop();
        let msg = `could not read a value from that page: ${reading.error}`;
        if (!o.selector && !o.regex && !o.jsonPath) {
          msg +=
            '\n\nTry: trackanything test <url> --selector ".price"\n' +
            'to find a selector that works before adding it.';
        }
        throw new Error(msg);
      }
      if (reading.title && !watch.name) watch.name = reading.title;
      watch.history.push({
        value: reading.value,
        currency: reading.currency,
        available: reading.available,
        from: now().toISOString(),
        to: now().toISOString(),
        checks: 1,
      });
      save(db);
      let out = `\n  ${green('Watching')} ${bold(watch.name || url)}\n`;
      out += `  ${dim(`id ${watch.id} · ${money(reading.value, reading.currency)} · read from ${reading.source}`)}\n`;
      if (reading.source === 'json-ld' || reading.source === 'meta') {
        out += dim('  No selector needed: the page publishes its price in structured data.\n');
      }
      if (watch.target != null) out += dim(`  You will hear when it reaches ${money(watch.target, reading.currency)}.\n`);
      return { stdout: out + '\n' };
    }

    case 'test': {
      const url = o.args[0];
      if (!url) throw new Error('a URL, please: trackanything test https://…');
      const reading = await checkOne({ url, ...o }, { fetchImpl });
      if (o.json) return { stdout: JSON.stringify(reading, null, 2) + '\n' };
      if (reading.error) {
        return { stdout: `\n  ${red('No value found')}\n  ${dim(reading.error)}\n\n`, code: 1 };
      }
      let out = `\n  ${green(money(reading.value, reading.currency))}`;
      out += dim(`  via ${reading.source}`);
      if (reading.available != null) out += dim(reading.available ? ' · in stock' : ' · out of stock');
      out += `\n  ${dim(reading.title || url)}\n\n`;
      out += dim('  Nothing was saved. `trackanything add` with the same options to keep it.\n\n');
      return { stdout: out };
    }

    case 'check': {
      const only = o.only ? resolve(o.only) : null;
      const result = await checkAll(db, { only, force: o.force, fetchImpl, now });
      save(db);

      let out = '';
      let notified = 0;
      const failures = [];
      for (const r of result.results) {
        if (r.notify && o.notify.length) {
          const { failed } = await notify(r, o.notify, { fetchImpl });
          notified += 1;
          failures.push(...failed);
        }
        if (o.quiet && !r.changed && !r.reading.error) continue;
        if (r.reading.error) {
          out += `  ${red('!')} ${pad(r.watch.name || r.watch.url, 40)} ${dim(r.reading.error)}\n`;
        } else if (r.changed) {
          const down = r.previous != null && r.reading.value < r.previous;
          out += `  ${down ? green('↓') : yellow('↑')} ${pad(r.watch.name || r.watch.url, 40)} `;
          out += `${padL(down ? green(money(r.reading.value, r.reading.currency)) : money(r.reading.value, r.reading.currency), 12)}`;
          out += dim(`  was ${money(r.previous, r.reading.currency)}`);
          if (r.stats?.isLow) out += green('  lowest yet');
          out += '\n';
        } else {
          out += `  ${dim('·')} ${pad(dim(r.watch.name || r.watch.url), 40)} ${padL(dim(money(r.reading.value, r.reading.currency)), 12)}\n`;
        }
      }

      const changed = result.results.filter((r) => r.changed).length;
      const errors = result.results.filter((r) => r.reading.error).length;
      let summary = `\n  ${bold(mag('trackanything'))}  ${dim(`${result.checked} checked · ${changed} changed`)}`;
      if (errors) summary += dim(` · ${errors} failed`);
      if (result.skipped) summary += dim(` · ${result.skipped} not due`);
      if (notified) summary += dim(` · ${notified} notified`);
      summary += '\n\n';

      for (const f of failures) {
        out += `  ${red('!')} ${dim(`notify ${f.type} failed: ${f.error}`)}\n`;
      }
      return { stdout: summary + out + '\n', code: errors && !changed ? 1 : 0 };
    }

    case 'list': {
      if (o.json) return { stdout: JSON.stringify(db.watches, null, 2) + '\n' };
      if (!db.watches.length) {
        return { stdout: `\n  ${dim('Nothing watched yet.')}\n  ${dim('trackanything add https://…')}\n\n` };
      }
      let out = `\n  ${bold(mag('trackanything'))}  ${dim(`${db.watches.length} watches · ${dbPath()}`)}\n\n`;
      for (const w of db.watches) {
        const s = stats(w);
        const cur = money(currentValue(w), w.history[w.history.length - 1]?.currency);
        out += `  ${dim(w.id)}  ${pad(w.paused ? dim(w.name || w.url) : bold(w.name || w.url), 42)}`;
        out += padL(s?.isLow ? green(cur) : cur, 12);
        if (s && s.changes > 0) out += dim(`  low ${money(s.low)} · high ${money(s.high)}`);
        if (w.target != null) out += dim(`  target ${money(w.target)}`);
        if (w.paused) out += dim('  paused');
        if (w.lastError) out += red(`  ${w.lastError}`);
        out += '\n';
      }
      return { stdout: out + '\n' };
    }

    case 'history': {
      const w = resolve(o.args[0]);
      if (o.json) return { stdout: JSON.stringify(w, null, 2) + '\n' };
      let out = `\n  ${bold(w.name || w.url)}\n  ${dim(w.url)}\n\n`;
      for (const point of w.history) {
        out += `  ${dim(point.from.slice(0, 16).replace('T', ' '))}  ${padL(money(point.value, point.currency), 12)}`;
        if (point.checks > 1) out += dim(`  held for ${point.checks} checks`);
        if (point.available === false) out += dim('  out of stock');
        out += '\n';
      }
      const s = stats(w);
      if (s) out += `\n  ${dim(`low ${money(s.low)} · high ${money(s.high)} · ${s.changes} changes`)}\n`;
      return { stdout: out + '\n' };
    }

    case 'remove': {
      const w = resolve(o.args[0]);
      db.watches = db.watches.filter((x) => x.id !== w.id);
      save(db);
      return { stdout: `\n  Removed ${bold(w.name || w.url)} ${dim(`(${w.history.length} readings discarded)`)}\n\n` };
    }

    case 'pause':
    case 'resume': {
      const w = resolve(o.args[0]);
      w.paused = o.cmd === 'pause';
      save(db);
      return { stdout: `\n  ${w.paused ? 'Paused' : 'Resumed'} ${bold(w.name || w.url)}\n\n` };
    }

    case 'report': {
      const out = path.resolve(o.args[0] || 'trackanything.html');
      fs.writeFileSync(out, renderReport(db));
      return { stdout: `\n  Report written to ${out}  ${dim(`(${db.watches.length} watches)`)}\n\n` };
    }

    case 'demo': {
      const { seedDemo } = await import('./demo.mjs');
      const out = path.resolve(o.args[0] || 'trackanything-demo.html');
      const seeded = seedDemo();
      fs.writeFileSync(out, renderReport(seeded, { now: '2026-08-25 09:00' }));
      let stdout = `\n  ${bold(mag('trackanything'))} ${dim('demo')}\n\n`;
      for (const w of seeded.watches) {
        const s = stats(w);
        stdout += `  ${pad(w.name, 34)}${padL(s?.isLow ? green(money(s.current, w.history[0].currency)) : money(s.current, w.history[0].currency), 12)}`;
        stdout += dim(`  low ${money(s.low)} · high ${money(s.high)} · ${s.changes} changes`);
        if (s.isLow) stdout += green('  lowest yet');
        stdout += '\n';
      }
      stdout += `\n  Report written to ${out}\n`;
      stdout += dim('  Invented data, invented shop. Nothing was fetched.\n\n');
      return { stdout };
    }

    default:
      throw new Error(`unknown command "${o.cmd}". Try --help.`);
  }
}

export { headline };
