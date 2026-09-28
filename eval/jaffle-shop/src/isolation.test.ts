import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ANSWER_DIR } from './answer-dir.js';
import { readBytes, writeText } from './files.js';
import { answerHashes, findIsolationViolations } from './isolation.js';

const EXAMPLE_DIR = fileURLToPath(new URL('../../../examples/mastra_basic', import.meta.url));

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe('examples/mastra_basic isolation from the answer', () => {
  it('contains no answer file, answer path, or eval import', async () => {
    const violations = await findIsolationViolations(EXAMPLE_DIR, await answerHashes(ANSWER_DIR));
    expect(violations).toEqual([]);
  });

  it('catches each kind of leak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'isolation-'));
    scratch = root;
    const plant = async (name: string, text: string): Promise<void> => {
      await writeText(join(root, name), text);
    };
    const answerText = async (name: string): Promise<string> =>
      (await readBytes(join(ANSWER_DIR, name))).toString('utf8');
    await plant('jaffle_shop.json', await answerText('jaffle_shop.json'));
    await plant('notes.md', await answerText('README.md'));
    await plant(join('src', 'a.ts'), "const p = '../../ontology/answer';\n");
    await plant(join('src', 'b.ts'), "import '@data-agent-ontology/eval-jaffle-shop';\n");
    await plant(join('src', 'c.ts'), "import '../../eval/jaffle-shop/src/compare.js';\n");
    const violations = await findIsolationViolations(root, await answerHashes(ANSWER_DIR));
    expect(violations).toEqual(
      expect.arrayContaining([
        { file: 'jaffle_shop.json', reason: 'is named jaffle_shop.json' },
        { file: 'jaffle_shop.json', reason: 'is a byte copy of an answer file' },
        { file: 'notes.md', reason: 'is a byte copy of an answer file' },
        { file: join('src', 'a.ts'), reason: 'mentions the answer path ontology/answer' },
        { file: join('src', 'b.ts'), reason: 'imports the eval package' },
        { file: join('src', 'c.ts'), reason: 'reaches into eval/' },
      ]),
    );
  });
});
