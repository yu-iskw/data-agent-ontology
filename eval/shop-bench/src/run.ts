import { runBench } from './arms.js';
import { passed } from './score.js';

async function main(): Promise<number> {
  const report = await runBench();
  console.log(JSON.stringify(report, null, 2));
  return passed(report) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  },
);
