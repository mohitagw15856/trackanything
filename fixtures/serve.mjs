// Serves the fixture pages over HTTP on 8787.
//
// Exists so the README GIF can show a real `add` against a real URL -- including
// the line that is the whole pitch, "No selector needed" -- without depending on
// somebody else's shop being up, unblocked and unchanged on the day of recording.
//
//   node fixtures/serve.mjs &
//   trackanything add http://127.0.0.1:8787/headphones

import http from 'node:http';
import { PAGES } from './pages.mjs';

const PORT = Number(process.env.PORT || 8787);

const routes = new Map(
  Object.entries(PAGES).map(([url, render]) => [new URL(url).pathname, render])
);

http
  .createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    const render = routes.get(path);
    if (!render) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`not a fixture. Try: ${[...routes.keys()].join(', ')}`);
      return;
    }
    const body = render({});
    const json = path.startsWith('/api/');
    res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8' });
    res.end(body);
  })
  .listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`fixtures on http://127.0.0.1:${PORT}\n`);
  });
