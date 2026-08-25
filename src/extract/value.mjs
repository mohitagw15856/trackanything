// Getting a value out of a page.
//
// The order matters and it is the whole design: structured data first, meta tags
// second, a selector only if you had to write one. Most shops already publish the
// price in schema.org JSON-LD because Google asks them to, which means the common
// case needs no configuration at all — and a selector written against a class name
// breaks the next time the shop ships CSS, while the structured data does not.

import { attr, jsonLd, metaTags, select, textOf } from './html.mjs';

/** Currency symbols and codes we recognise when nothing declares one. */
const SYMBOLS = { '£': 'GBP', $: 'USD', '€': 'EUR', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', R$: 'BRL' };

/**
 * Parse a human-written amount into a number.
 *
 * The awkward part is that "1.234,56" and "1,234.56" are the same amount written
 * by different countries, and "1,234" is ambiguous on its own. The rule used here:
 * whichever separator appears last is the decimal point, unless it is followed by
 * exactly three digits and appears only once, in which case it is a thousands mark.
 */
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  if (text == null) return null;
  const raw = String(text);
  const match = /-?\d[\d.,   ]*\d|-?\d/.exec(raw.replace(/−/g, '-'));
  if (!match) return null;

  let body = match[0].replace(/[   ]/g, '');
  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  if (lastComma === -1 && lastDot === -1) return Number(body);

  const decimalAt = Math.max(lastComma, lastDot);
  const decimalChar = body[decimalAt];
  const after = body.length - decimalAt - 1;
  const occurrences = body.split(decimalChar).length - 1;

  const isThousands = after === 3 && (occurrences > 1 || decimalAt === body.length - 4);
  if (isThousands) {
    body = body.split(decimalChar).join('');
    const other = decimalChar === ',' ? '.' : ',';
    const otherAt = body.lastIndexOf(other);
    if (otherAt !== -1) body = body.slice(0, otherAt) + '.' + body.slice(otherAt + 1).replace(/[.,]/g, '');
    return Number(body);
  }

  const cleaned =
    body.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + body.slice(decimalAt + 1).replace(/[.,]/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function detectCurrency(text) {
  const s = String(text ?? '');
  const code = /\b(GBP|USD|EUR|JPY|AUD|CAD|CHF|SEK|NOK|DKK|PLN|INR|BRL|MXN|NZD|ZAR|SGD)\b/i.exec(s);
  if (code) return code[1].toUpperCase();
  for (const [symbol, iso] of Object.entries(SYMBOLS)) if (s.includes(symbol)) return iso;
  return null;
}

const AVAILABLE = /InStock|BackOrder|PreOrder|LimitedAvailability/i;
const UNAVAILABLE = /OutOfStock|SoldOut|Discontinued/i;

/**
 * Walk parsed JSON-LD for something priced. Returns the first offer found, which
 * for a variant listing is the lowest price the page advertises — the same number
 * the shop shows in its "from £x" line.
 */
export function fromStructuredData(html) {
  const nodes = jsonLd(html);
  const candidates = [];

  for (const node of nodes) {
    const offers = [].concat(node.offers ?? node.Offers ?? []);
    for (const offer of offers) {
      if (!offer || typeof offer !== 'object') continue;
      const price = offer.price ?? offer.lowPrice ?? offer.highPrice;
      if (price == null) continue;
      candidates.push({
        value: parseAmount(price),
        currency: offer.priceCurrency ?? node.priceCurrency ?? null,
        available: availability(offer.availability ?? offer.itemCondition),
        name: node.name ?? null,
        source: 'json-ld',
      });
    }
    // A bare Offer or AggregateOffer, not nested under a Product.
    const type = String(node['@type'] ?? '');
    if (/Offer/i.test(type) && (node.price ?? node.lowPrice) != null) {
      candidates.push({
        value: parseAmount(node.price ?? node.lowPrice),
        currency: node.priceCurrency ?? null,
        available: availability(node.availability),
        name: node.name ?? null,
        source: 'json-ld',
      });
    }
  }

  const usable = candidates.filter((c) => c.value != null);
  if (!usable.length) return null;
  // Lowest wins: a variant list should report the price the page leads with.
  return usable.reduce((a, b) => (b.value < a.value ? b : a));
}

function availability(value) {
  if (value == null) return null;
  const s = String(value);
  if (UNAVAILABLE.test(s)) return false;
  if (AVAILABLE.test(s)) return true;
  return null;
}

/** OpenGraph and microdata meta tags, the second-most-common machine-readable form. */
export function fromMeta(html) {
  const tags = metaTags(html);
  const priceKeys = [
    'product:price:amount',
    'og:price:amount',
    'twitter:data1',
    'price',
    'product:sale_price:amount',
  ];
  for (const key of priceKeys) {
    const value = parseAmount(tags[key]);
    if (value != null) {
      return {
        value,
        currency:
          tags['product:price:currency'] ?? tags['og:price:currency'] ?? detectCurrency(tags[key]),
        available: tags['product:availability']
          ? availability(tags['product:availability'])
          : null,
        name: tags['og:title'] ?? null,
        source: 'meta',
      };
    }
  }
  return null;
}

/** A CSS selector the user wrote, for pages with nothing structured on them. */
export function fromSelector(html, selector, { attribute = null } = {}) {
  const hits = select(html, selector);
  if (!hits.length) return null;
  const first = hits[0];
  // The attribute is on the element's own tag; the text is inside it.
  const raw = attribute ? (attr(first.tag, attribute) ?? '') : textOf(first.inner);
  const value = parseAmount(raw);
  return {
    value,
    text: raw.trim().slice(0, 120),
    currency: detectCurrency(raw),
    available: null,
    source: 'selector',
    matches: hits.length,
  };
}

/** A regular expression, for the pages that defeat everything else. */
export function fromRegex(html, pattern, { flags = 'i' } = {}) {
  const re = new RegExp(pattern, flags);
  const m = re.exec(textOf(html)) || re.exec(String(html));
  if (!m) return null;
  const captured = m[1] ?? m[0];
  return {
    value: parseAmount(captured),
    text: String(captured).trim().slice(0, 120),
    currency: detectCurrency(captured),
    available: null,
    source: 'regex',
  };
}

/** A path into a JSON response, for APIs: `data.product.price` or `items.0.price`. */
export function fromJsonPath(body, path) {
  let node;
  try {
    node = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  for (const key of String(path).split('.')) {
    if (node == null) return null;
    node = Array.isArray(node) && /^\d+$/.test(key) ? node[Number(key)] : node[key];
  }
  if (node == null) return null;
  return { value: parseAmount(node), text: String(node).slice(0, 120), currency: detectCurrency(node), source: 'json' };
}

/**
 * The whole extraction, in preference order. `watch.selector`, `watch.regex` and
 * `watch.jsonPath` override the automatic path when a page needs it.
 */
export function extract(body, watch = {}) {
  if (watch.jsonPath) return fromJsonPath(body, watch.jsonPath);
  if (watch.regex) return fromRegex(body, watch.regex, { flags: watch.regexFlags });
  if (watch.selector) return fromSelector(body, watch.selector, { attribute: watch.attribute });
  return fromStructuredData(body) || fromMeta(body) || null;
}

/** What the page calls the thing, for a watch added without a --name. */
export function titleOf(html) {
  const structured = fromStructuredData(html);
  if (structured?.name) return String(structured.name).trim().slice(0, 90);
  const tags = metaTags(html);
  if (tags['og:title']) return tags['og:title'].trim().slice(0, 90);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html));
  return title ? textOf(title[1]).slice(0, 90) : null;
}
