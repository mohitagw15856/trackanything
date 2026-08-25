#!/usr/bin/env node
import { run } from "../src/cli.mjs";
try {
  const { stdout, code } = await run(process.argv.slice(2));
  process.stdout.write(stdout);
  if (code) process.exit(code);
} catch (e) {
  process.stderr.write("trackanything: " + e.message + "\n");
  process.exit(1);
}
