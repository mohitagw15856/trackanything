// Fixture pages, shaped like the four kinds of product page you meet in the wild.
// Used by the test suite and by `trackanything demo`, so both exercise the same
// extraction paths that a real shop would.

export const PAGES = {
  // The common case: schema.org JSON-LD, because Google asks shops for it.
  'https://demo.local/headphones': ({ price = 249.99, stock = true } = {}) => `<!doctype html>
<html><head><title>Aurora Over-Ear Headphones | Demo Shop</title>
<meta property="og:title" content="Aurora Over-Ear Headphones">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Aurora Over-Ear Headphones",
 "brand":{"@type":"Brand","name":"Aurora"},
 "offers":{"@type":"Offer","price":"${price.toFixed(2)}","priceCurrency":"GBP",
 "availability":"https://schema.org/${stock ? 'InStock' : 'OutOfStock'}"}}
</script></head>
<body><h1>Aurora Over-Ear Headphones</h1><span class="price">£${price.toFixed(2)}</span></body></html>`,

  // OpenGraph product tags, no JSON-LD. Shopify's older themes look like this.
  'https://demo.local/kettle': ({ price = 64.0 } = {}) => `<!doctype html>
<html><head><title>Cascade Pour-Over Kettle</title>
<meta property="og:title" content="Cascade Pour-Over Kettle">
<meta property="product:price:amount" content="${price.toFixed(2)}">
<meta property="product:price:currency" content="GBP">
<meta property="product:availability" content="instock">
</head><body><div class="price-box"><b>£${price.toFixed(2)}</b></div></body></html>`,

  // Nothing structured at all. This is the page that needs a --selector.
  'https://demo.local/desk': ({ price = 389.0 } = {}) => `<!doctype html>
<html><head><title>Larkin Standing Desk</title></head>
<body>
  <div class="breadcrumb"><span class="price">not this one</span></div>
  <div id="product">
    <h1>Larkin Standing Desk</h1>
    <div class="pricing">
      <span class="was">£449.00</span>
      <span class="now" data-price="${price.toFixed(2)}">£${price.toFixed(2)}</span>
    </div>
  </div>
</body></html>`,

  // A JSON API, which is what a lot of "modern" storefronts actually serve.
  'https://demo.local/api/lens': ({ price = 1099.0, stock = true } = {}) =>
    JSON.stringify({
      data: {
        product: {
          title: 'Meridian 35mm f/1.4 Lens',
          pricing: { current: price, currency: 'GBP' },
          inventory: { available: stock },
        },
      },
    }),

  // European number formatting, to keep the parser honest.
  'https://demo.local/bike': ({ price = 1249.5 } = {}) => `<!doctype html>
<html><head><title>Fernweg Gravel Bike</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Product","name":"Fernweg Gravel Bike",
 "offers":{"@type":"AggregateOffer","lowPrice":"${price.toFixed(2)}","priceCurrency":"EUR",
 "availability":"https://schema.org/InStock"}}
</script></head>
<body><span class="preis">${price.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €</span></body></html>`,

  // A page that returns 200 with no price on it -- the failure people actually hit.
  'https://demo.local/blocked': () => `<!doctype html>
<html><head><title>Just a moment…</title></head>
<body><h1>Checking your browser</h1><p>Please enable JavaScript.</p></body></html>`,
};

/**
 * A `fetch` that serves the fixtures above. Never touches the network.
 * `statuses` maps a URL to a status code, so a test can make a known page come
 * back as a 403 to exercise block handling.
 */
export function fixtureFetch(overrides = {}, statuses = {}) {
  return async (url) => {
    const key = String(url).split('?')[0];
    const page = PAGES[key];
    if (!page) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    const status = statuses[key] ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => page(overrides[key] || {}) };
  };
}
