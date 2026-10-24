#!/usr/bin/env node
import { main } from '../src/cli.mjs';

// A closed pipe (e.g. piping into `more` or `Select-Object -First`) is not an error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0);
  });
}

process.exitCode = main(process.argv.slice(2));
