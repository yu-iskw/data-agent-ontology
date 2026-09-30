import { run } from './cli.js';

run(process.argv.slice(2), process.env).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
