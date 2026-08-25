// Everything lives in one JSON file. Back up ./data and you have backed up
// everything -- there is no database to migrate and nothing to lose in a schema
// change, which for a tool you will run on a Pi for three years matters more than
// query speed over a few hundred rows.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function dataDir() {
  return process.env.TRACKANYTHING_DIR || path.join(os.homedir(), '.trackanything');
}

export function dbPath() {
  return path.join(dataDir(), 'watches.json');
}

const EMPTY = { version: 1, watches: [] };

export function load() {
  const file = dbPath();
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && Array.isArray(parsed.watches) ? parsed : structuredClone(EMPTY);
  } catch {
    // A truncated write should not lose every watch. Keep the damaged file so it
    // can be inspected, and carry on from empty rather than crashing on start.
    const backup = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      process.stderr.write(`trackanything: ${file} was unreadable, moved to ${backup}\n`);
    } catch {
      /* nothing further to try */
    }
    return structuredClone(EMPTY);
  }
}

export function save(db) {
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename: a power cut mid-write leaves the old file, not half a new one.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

export function newId(url) {
  return crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
}

export function findWatch(db, needle) {
  const key = String(needle).toLowerCase();
  return (
    db.watches.find((w) => w.id === key) ||
    db.watches.find((w) => w.name?.toLowerCase() === key) ||
    db.watches.find((w) => w.name?.toLowerCase().includes(key)) ||
    db.watches.find((w) => w.url.includes(needle)) ||
    null
  );
}

export function addWatch(db, watch) {
  const id = watch.id || newId(watch.url + (watch.selector || watch.jsonPath || watch.regex || ''));
  if (db.watches.some((w) => w.id === id)) {
    throw new Error(`already watching that (id ${id}). Use \`trackanything remove ${id}\` first.`);
  }
  const record = {
    id,
    name: watch.name || null,
    url: watch.url,
    selector: watch.selector || null,
    attribute: watch.attribute || null,
    regex: watch.regex || null,
    regexFlags: watch.regexFlags || null,
    jsonPath: watch.jsonPath || null,
    currency: watch.currency || null,
    target: watch.target ?? null,
    notifyOn: watch.notifyOn || 'change',
    every: watch.every || null,
    paused: false,
    created: watch.created || new Date().toISOString(),
    history: [],
    lastError: null,
  };
  db.watches.push(record);
  return record;
}

/**
 * Append a reading. Consecutive identical values are collapsed into the existing
 * point by moving its `to` timestamp, so a watch checked hourly for a year holds a
 * handful of points rather than 8,760 copies of the same price.
 */
export function record(watch, reading, now = new Date().toISOString()) {
  const last = watch.history[watch.history.length - 1];
  watch.lastError = reading.error || null;
  if (reading.error) return { changed: false, previous: last?.value ?? null };

  // Normalise before comparing: a reading with no availability field arrives as
  // undefined, and `null === undefined` is false, which made every unchanged check
  // look like a change and grew the history without bound.
  const available = reading.available ?? null;
  if (last && last.value === reading.value && last.available === available) {
    last.to = now;
    last.checks = (last.checks || 1) + 1;
    return { changed: false, previous: last.value };
  }
  watch.history.push({
    value: reading.value,
    currency: reading.currency ?? watch.currency ?? null,
    available,
    from: now,
    to: now,
    checks: 1,
  });
  return { changed: Boolean(last), previous: last?.value ?? null, first: !last };
}

export function currentValue(watch) {
  const last = watch.history[watch.history.length - 1];
  return last ? last.value : null;
}

export function stats(watch) {
  const values = watch.history.map((h) => h.value).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  const current = values[values.length - 1];
  const low = Math.min(...values);
  const high = Math.max(...values);
  return {
    current,
    low,
    high,
    first: values[0],
    changes: values.length - 1,
    isLow: current === low && values.length > 1,
    offHigh: high > 0 ? (high - current) / high : 0,
  };
}
