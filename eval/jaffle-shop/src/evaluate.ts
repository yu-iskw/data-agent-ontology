import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ANSWER_DIR } from './answer-dir.js';
import { compareOntologies } from './compare.js';
import { loadDocument } from './document.js';
import { readText, writeText } from './files.js';
import { formatReport } from './format.js';

const USAGE =
  'Usage: pnpm evaluate --artifact <ontology.json> [--answer-dir <dir>] [--json <report.json>]';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      artifact: { type: 'string' },
      'answer-dir': { type: 'string' },
      json: { type: 'string' },
    },
  });
  if (!values.artifact) {
    console.error(USAGE);
    return 2;
  }
  const artifact = resolve(values.artifact);
  const answerDir = resolve(values['answer-dir'] ?? ANSWER_DIR);
  const rules = await readText(join(answerDir, 'README.md'));
  if (!rules.includes('## What must match')) {
    throw new Error(`${answerDir}/README.md does not state the answer rules`);
  }
  const answer = await loadDocument(join(answerDir, 'jaffle_shop.json'));
  const report = compareOntologies(answer, await loadDocument(artifact));
  console.log(formatReport(report, artifact, answerDir));
  if (values.json) {
    await writeText(resolve(values.json), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report.match ? 0 : 1;
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
