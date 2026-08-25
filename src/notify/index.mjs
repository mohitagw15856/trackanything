// Notifications.
//
// Every channel here is one you already run or one that needs no account: a
// webhook you own, an ntfy topic, a Discord or Slack webhook, or a command on your
// own machine. There is no hosted relay, because a price tracker that has to phone
// a company to tell you a price dropped has given away the thing you were avoiding.

import { spawn } from 'node:child_process';

export const CHANNELS = ['webhook', 'ntfy', 'discord', 'slack', 'command', 'stdout'];

function money(value, currency) {
  if (value == null) return '—';
  const symbols = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', INR: '₹' };
  const symbol = symbols[currency] || (currency ? `${currency} ` : '');
  return `${symbol}${Number(value).toFixed(2)}`;
}

/** One human-readable line, used as the title everywhere. */
export function headline(result) {
  const { watch, reading, previous, stats: s } = result;
  const name = watch.name || watch.url;
  const now = money(reading.value, reading.currency);

  if (reading.available === true && result.previousAvailable === false) {
    return `${name} is back in stock at ${now}`;
  }
  if (previous == null) return `${name} is ${now}`;
  if (reading.value < previous) {
    const pct = Math.round(((previous - reading.value) / previous) * 100);
    const low = s?.isLow ? ', the lowest it has been' : '';
    return `${name} dropped ${pct}% to ${now}${low} (was ${money(previous, reading.currency)})`;
  }
  if (reading.value > previous) {
    const pct = Math.round(((reading.value - previous) / previous) * 100);
    return `${name} went up ${pct}% to ${now} (was ${money(previous, reading.currency)})`;
  }
  return `${name} is ${now}`;
}

export function body(result) {
  const { watch, reading, stats: s } = result;
  const lines = [watch.url];
  if (s) {
    lines.push(
      `now ${money(s.current, reading.currency)} · low ${money(s.low, reading.currency)} · high ${money(s.high, reading.currency)}`
    );
  }
  if (watch.target != null) lines.push(`your target: ${money(watch.target, reading.currency)}`);
  return lines.join('\n');
}

async function post(url, payload, { fetchImpl = fetch, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${url.split('/')[2]} returned ${res.status}`);
  return true;
}

const SENDERS = {
  async webhook(target, result, opts) {
    return post(
      target,
      {
        id: result.watch.id,
        name: result.watch.name,
        url: result.watch.url,
        value: result.reading.value,
        previous: result.previous,
        currency: result.reading.currency,
        available: result.reading.available,
        headline: headline(result),
        stats: result.stats,
      },
      opts
    );
  },

  async ntfy(target, result, opts) {
    // ntfy takes the message as a plain body with metadata in headers, which is
    // why this one does not send JSON.
    const url = target.startsWith('http') ? target : `https://ntfy.sh/${target}`;
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Title: headline(result),
        Click: result.watch.url,
        Tags: result.reading.value < (result.previous ?? Infinity) ? 'chart_with_downwards_trend' : 'bell',
        Priority: result.reading.value < (result.previous ?? Infinity) ? 'high' : 'default',
      },
      body: body(result),
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status}`);
    return true;
  },

  async discord(target, result, opts) {
    const dropped = result.previous != null && result.reading.value < result.previous;
    return post(
      target,
      {
        embeds: [
          {
            title: headline(result),
            url: result.watch.url,
            description: body(result),
            color: dropped ? 0x4ade80 : 0x9a9a9a,
          },
        ],
      },
      opts
    );
  },

  async slack(target, result, opts) {
    return post(target, { text: `*${headline(result)}*\n${body(result)}` }, opts);
  },

  async command(target, result) {
    // The command is run without a shell, so a watch name containing a quote or a
    // semicolon cannot turn into an injection.
    const [bin, ...args] = target.split(' ');
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          ...process.env,
          TRACK_NAME: result.watch.name || '',
          TRACK_URL: result.watch.url,
          TRACK_VALUE: String(result.reading.value ?? ''),
          TRACK_PREVIOUS: String(result.previous ?? ''),
          TRACK_HEADLINE: headline(result),
        },
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(true) : reject(new Error(`exit ${code}`))));
      child.stdin.end(`${headline(result)}\n${body(result)}\n`);
    });
  },

  async stdout(_target, result) {
    process.stdout.write(`${headline(result)}\n`);
    return true;
  },
};

/**
 * Send one result to every configured channel. Failures are collected rather than
 * thrown: a Discord outage must not stop the ntfy message, or lose the reading.
 */
export async function notify(result, channels = [], opts = {}) {
  const sent = [];
  const failed = [];
  for (const channel of channels) {
    const send = SENDERS[channel.type];
    if (!send) {
      failed.push({ ...channel, error: `unknown channel type "${channel.type}"` });
      continue;
    }
    try {
      await send(channel.target, result, opts);
      sent.push(channel.type);
    } catch (err) {
      failed.push({ ...channel, error: err.message });
    }
  }
  return { sent, failed };
}

/** `--notify ntfy:my-topic --notify discord:https://...` */
export function parseChannel(spec) {
  const at = String(spec).indexOf(':');
  if (at === -1) {
    if (spec === 'stdout') return { type: 'stdout', target: '' };
    throw new Error(`notify channels look like type:target, e.g. ntfy:my-topic (got "${spec}")`);
  }
  const type = spec.slice(0, at);
  const target = spec.slice(at + 1);
  if (!CHANNELS.includes(type)) {
    throw new Error(`unknown channel "${type}". One of: ${CHANNELS.join(', ')}`);
  }
  return { type, target };
}
