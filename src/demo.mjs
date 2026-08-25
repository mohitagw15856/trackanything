// A seeded demo database: six months of invented price history for an invented
// shop. Deterministic, so the README GIF and the screenshot are reproducible and
// nobody's real watchlist ends up in a recording.

const DAY = 86400000;
const START = Date.UTC(2026, 2, 1);

// Reset per call: a module-level cursor made the second seedDemo() of a process
// produce different history from the first, which is exactly what a "deterministic
// demo" must not do.
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const ITEMS = [
  { id: 'a1b2c3d4', name: 'Aurora Over-Ear Headphones', url: 'https://demo.local/headphones',
    currency: 'GBP', start: 279.99, target: 199, moves: [-30, 0, -20, 30, -55, -25] },
  { id: 'b2c3d4e5', name: 'Cascade Pour-Over Kettle', url: 'https://demo.local/kettle',
    currency: 'GBP', start: 64.0, target: null, moves: [0, 5, 0, -9, 0, 0] },
  { id: 'c3d4e5f6', name: 'Larkin Standing Desk', url: 'https://demo.local/desk',
    currency: 'GBP', start: 449.0, selector: '#product .now', target: 350, moves: [-30, 0, -30, 0, 0, 40] },
  { id: 'd4e5f6a7', name: 'Meridian 35mm f/1.4 Lens', url: 'https://demo.local/api/lens',
    currency: 'GBP', start: 1229.0, jsonPath: 'data.product.pricing.current', target: null,
    moves: [0, -50, 0, 0, -80, 0] },
  { id: 'e5f6a7b8', name: 'Fernweg Gravel Bike', url: 'https://demo.local/bike',
    currency: 'EUR', start: 1499.0, target: 1100, moves: [-100, 0, -50, 0, -100, 0] },
];

export function seedDemo() {
  seed = 7;
  const watches = ITEMS.map((item) => {
    const history = [];
    let value = item.start;
    let t = START;
    history.push({ value, currency: item.currency, available: true, from: iso(t), to: iso(t), checks: 1 });

    for (const move of item.moves) {
      // Each step covers roughly a month, with the price holding for most of it.
      const held = 20 + Math.floor(rand() * 16);
      history[history.length - 1].to = iso(t + held * DAY);
      history[history.length - 1].checks = held * 4;
      t += held * DAY;
      if (move === 0) continue;
      value = Math.round((value + move) * 100) / 100;
      history.push({ value, currency: item.currency, available: true, from: iso(t), to: iso(t), checks: 1 });
    }
    history[history.length - 1].to = iso(Date.UTC(2026, 7, 25));
    history[history.length - 1].checks = 40;

    return {
      id: item.id,
      name: item.name,
      url: item.url,
      selector: item.selector || null,
      attribute: null,
      regex: null,
      regexFlags: null,
      jsonPath: item.jsonPath || null,
      currency: item.currency,
      target: item.target,
      notifyOn: item.target != null ? 'target' : 'drop',
      every: 21600,
      paused: false,
      created: iso(START),
      history,
      lastError: null,
    };
  });
  return { version: 1, watches };
}

const iso = (ms) => new Date(ms).toISOString();
