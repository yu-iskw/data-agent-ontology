import { createHash } from 'node:crypto';
import { basename, relative } from 'node:path';

import { listFiles, readBytes } from './files.js';

interface Violation {
  file: string;
  reason: string;
}

const ANSWER_FILENAME = 'jaffle_shop.json';

/** Strings that must never appear anywhere in the example, including its data and config. */
const FORBIDDEN: readonly { reason: string; pattern: RegExp }[] = [
  { reason: 'mentions the answer path ontology/answer', pattern: /ontology\/answer/ },
  { reason: `mentions the answer file ${ANSWER_FILENAME}`, pattern: /jaffle_shop\.json/ },
  { reason: 'imports the eval package', pattern: /@data-agent-ontology\/eval-jaffle-shop/ },
  { reason: 'reaches into eval/', pattern: /['"`](?:\.\.\/)+eval\/|\beval\/jaffle-shop\b/ },
];

const SKIPPED_DIRECTORIES = new Set(['node_modules']);

async function scannedFiles(root: string): Promise<string[]> {
  const files = await listFiles(root);
  return files.filter(
    (file) =>
      !relative(root, file)
        .split(/[\\/]/)
        .some((part) => SKIPPED_DIRECTORIES.has(part)),
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hashes of the answer files, so renamed copies are caught too. */
export async function answerHashes(answerDir: string): Promise<Set<string>> {
  const files = await listFiles(answerDir);
  return new Set(await Promise.all(files.map(async (file) => sha256(await readBytes(file)))));
}

/**
 * Finds anything in `exampleDir` that could let the agent see the answer: the answer file by
 * name or content, the answer path, or an import of the evaluator package.
 */
export async function findIsolationViolations(
  exampleDir: string,
  forbiddenHashes: Set<string>,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await scannedFiles(exampleDir)) {
    const name = relative(exampleDir, file);
    if (basename(file) === ANSWER_FILENAME) {
      violations.push({ file: name, reason: `is named ${ANSWER_FILENAME}` });
    }
    const bytes = await readBytes(file);
    if (forbiddenHashes.has(sha256(bytes))) {
      violations.push({ file: name, reason: 'is a byte copy of an answer file' });
    }
    const text = bytes.toString('latin1');
    for (const { reason, pattern } of FORBIDDEN) {
      if (pattern.test(text)) {
        violations.push({ file: name, reason });
      }
    }
  }
  return violations;
}
