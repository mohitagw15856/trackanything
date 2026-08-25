# Launch plan

There are a hundred price trackers. The one thing none of them lead with is the
thing that actually removes the friction.

## The hook

Not "self-hosted price tracker."

**"Every price tracker starts by asking you to inspect element and paste a CSS
selector. You almost never need one — shops already publish the price in
structured data because Google asks them to. So this reads that first, and the
selector is the fallback."**

That is a small technical observation that saves the reader a real chore, which
is the kind of thing that gets upvoted by people who have tried the alternatives.

The second hook, for a different crowd: **Keepa charges $20/month to remember what
things cost. This remembers, for anything, on your own machine.**

## Order of operations

1. `vhs demo.tape`. The GIF must show `add` printing *"No selector needed"* — that
   line is the pitch.
2. Screenshot the HTML report into `assets/report.png`; the README links it.
3. Publish to npm and GHCR.
4. Run it against twenty real shops for a week first. Every "it does not work on
   X" comment is answerable only if you already tried X.
5. Post one place per day.

## Where

| Day | Where | Angle |
|---|---|---|
| 1 | r/selfhosted | no account, no relay, one JSON file, ntfy support |
| 2 | Hacker News, `Show HN` | the structured-data observation, framed as the design decision |
| 3 | r/homelab | the cron/compose setup and the step charts |
| 4 | r/buildapcsales, r/frugal | the money angle only; no self-hosting talk at all |
| 5 | r/webdev | the 200-line selector engine and why not a headless browser |

## Titles

- You do not need a CSS selector to track a price. Shops already publish it.
- Keepa for anything, on your own machine
- I wrote a price tracker that tells you when it cannot read the page

## Before posting

- [ ] `assets/demo.gif` and `assets/report.png`
- [ ] Tested against 20 real shops; know the hit rate for structured data and say
      it honestly in the post ("about N of 20 needed no selector")
- [ ] An answer for "what about Amazon" — they serve bot checks; say so plainly
      rather than claiming it works
- [ ] An answer for "is this scraping" — it reads a page as a browser would, at
      most four times a day, with no proxy rotation and no CAPTCHA solving
- [ ] An answer for "why not changedetection.io" — that watches for *any* change;
      this understands prices, history and stock

## What not to do

- Do not add proxy rotation, headless browsers or CAPTCHA solving. The moment this
  becomes an evasion tool it stops being something you can post about, and the
  README's honesty is doing real work.
- Do not add a hosted version. The pitch is that there is nothing in the middle.
- Do not overstate the hit rate. If structured data covers 70% of shops, say 70%.
  Someone will test it on the other 30% within the hour.
