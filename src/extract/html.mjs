// Just enough HTML to find a number on a page.
//
// A full DOM would be the obvious thing, and it is 2 MB of dependency to do one
// job: pull a value out of a page a shop already publishes in a machine-readable
// form. So this does the machine-readable form first, and falls back to a small
// selector engine only when a page has nothing structured on it.

/** Strip script/style/comments, then tags, then collapse entities and whitespace. */
export function textOf(html) {
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n')
    .trim();
}

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£',
  euro: '€', yen: '¥', cent: '¢', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', times: '×',
};

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Every <script type="application/ld+json"> block, parsed and flattened. */
export function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of String(html).matchAll(re)) {
    let parsed;
    try {
      // Some sites wrap the block in a CDATA guard, and a few emit trailing commas.
      parsed = JSON.parse(m[1].replace(/^\s*\/\/<!\[CDATA\[|\]\]>\s*$/g, '').trim());
    } catch {
      continue;
    }
    flatten(parsed, out);
  }
  return out;
}

function flatten(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  out.push(node);
  // @graph is how most CMS plugins emit several entities in one block.
  for (const key of ['@graph', 'mainEntity', 'itemListElement', 'hasVariant', 'offers']) {
    if (node[key]) flatten(node[key], out, depth + 1);
  }
}

/** <meta property="og:..."> and friends, which is where the rest of the price lives. */
export function metaTags(html) {
  const tags = {};
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = attr(tag, 'property') || attr(tag, 'name') || attr(tag, 'itemprop');
    const value = attr(tag, 'content');
    if (key && value != null) tags[key.toLowerCase()] = decodeEntities(value);
  }
  return tags;
}

export function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// --- a small selector engine ------------------------------------------------
//
// Supports the subset people actually put in a config: `.class`, `#id`, `tag`,
// `[attr=value]`, and descendant combinators between them. Not a browser; enough
// to reach the one element that holds the price on a page with no structured data.

function parseSelector(selector) {
  return selector
    .trim()
    .split(/\s+/)
    .map((part) => {
      const step = { tag: null, classes: [], id: null, attrs: [] };
      const body = part.replace(/\[([^\]]+)\]/g, (_, inner) => {
        const m = /^([\w-]+)\s*(?:([~^$*|]?=)\s*["']?([^"']*)["']?)?$/.exec(inner);
        if (m) step.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? null });
        return '';
      });
      const tagMatch = /^[a-zA-Z][\w-]*/.exec(body);
      if (tagMatch) step.tag = tagMatch[0].toLowerCase();
      for (const m of body.matchAll(/\.([\w-]+)/g)) step.classes.push(m[1]);
      const idMatch = /#([\w-]+)/.exec(body);
      if (idMatch) step.id = idMatch[1];
      return step;
    });
}

function matches(tag, step) {
  if (step.tag) {
    const name = /^<\s*([a-zA-Z][\w-]*)/.exec(tag)?.[1]?.toLowerCase();
    if (name !== step.tag) return false;
  }
  if (step.id && attr(tag, 'id') !== step.id) return false;
  if (step.classes.length) {
    const classes = (attr(tag, 'class') || '').split(/\s+/);
    if (!step.classes.every((c) => classes.includes(c))) return false;
  }
  for (const a of step.attrs) {
    const value = attr(tag, a.name);
    if (value == null) return false;
    if (!a.op) continue;
    if (a.op === '=' && value !== a.value) return false;
    if (a.op === '*=' && !value.includes(a.value)) return false;
    if (a.op === '^=' && !value.startsWith(a.value)) return false;
    if (a.op === '$=' && !value.endsWith(a.value)) return false;
    if (a.op === '~=' && !value.split(/\s+/).includes(a.value)) return false;
  }
  return true;
}

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Returns `{ tag, inner }` for every element matching `selector` -- the opening tag
 * as well as the contents, because an attribute lives on the tag and the text lives
 * inside it, and callers need both.
 *
 * Walks the tag stream keeping a stack of open elements, which is enough for a
 * descendant combinator without building a tree. Malformed markup degrades to
 * missing a match rather than throwing.
 */
export function select(html, selector) {
  const steps = parseSelector(selector);
  if (!steps.length) return [];
  const source = String(html);
  const stack = [];
  const open = []; // {frame, start, tag}
  const found = [];

  const tagRe = /<\/?([a-zA-Z][\w-]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(source))) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    const closing = tag.startsWith('</');
    const selfClosing = VOID.has(name) || /\/>\s*$/.test(tag);

    if (closing) {
      while (stack.length) {
        const top = stack.pop();
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i].frame === top) {
            found.push({ tag: open[i].tag, inner: source.slice(open[i].start, m.index) });
            open.splice(i, 1);
          }
        }
        if (top.name === name) break;
      }
      continue;
    }

    const parentMatched = stack.length ? stack[stack.length - 1].matchedTo : 0;
    let matchedTo = parentMatched;
    if (matchedTo < steps.length && matches(tag, steps[matchedTo])) matchedTo += 1;

    if (selfClosing) {
      if (matchedTo === steps.length) found.push({ tag, inner: '' });
      continue;
    }

    const frame = { name, matchedTo };
    stack.push(frame);
    if (matchedTo === steps.length) {
      open.push({ frame, tag, start: m.index + tag.length });
      // A nested match inside an already-matched element is the same value again.
      frame.matchedTo = steps.length;
    }
  }
  // Unclosed elements still yield whatever followed them.
  for (const o of open) found.push({ tag: o.tag, inner: source.slice(o.start) });
  return found;
}
