import { fileURLToPath } from 'node:url';

/** The answer set lives only here, outside anything the example agent can read. */
export const ANSWER_DIR = fileURLToPath(new URL('../answer', import.meta.url));
