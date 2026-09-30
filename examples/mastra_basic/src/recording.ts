import { readFile, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { proposalSchema } from './proposal.js';

export const RECORDING_FORMAT = 'data-agent-ontology/extraction-recording@1';

const recordingSchema = z.object({
  format: z.literal(RECORDING_FORMAT),
  model: z.string(),
  /** Every statement the agent ran, in order, with the database error if it failed. */
  sql: z.array(z.object({ sql: z.string(), error: z.string().optional() })),
  /** The proposal the ontology accepted. */
  proposal: proposalSchema,
});

export type Recording = z.infer<typeof recordingSchema>;

/* eslint-disable security/detect-non-literal-fs-filename -- the paths come from --record and --replay */
export async function writeRecording(path: string, recording: Recording): Promise<void> {
  await writeFile(path, `${JSON.stringify(recordingSchema.parse(recording), null, 2)}\n`);
}

/** Reads a recording made by a live run, so an extraction can be replayed without a model. */
export async function readRecording(path: string): Promise<Recording> {
  return recordingSchema.parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
}
/* eslint-enable security/detect-non-literal-fs-filename */
