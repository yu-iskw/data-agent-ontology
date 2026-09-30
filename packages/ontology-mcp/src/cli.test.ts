import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT } from './http.js';

describe('parseArgs', () => {
  it('reads stdio from flags and ignores the need for a token', () => {
    expect(parseArgs(['--transport', 'stdio', '--file', 'ontology.lbdb'], {})).toEqual({
      transport: 'stdio',
      file: 'ontology.lbdb',
      token: undefined,
      port: DEFAULT_HTTP_PORT,
      host: DEFAULT_HTTP_HOST,
    });
  });

  it('reads the file and token from the environment and defaults the http port to 8788', () => {
    expect(
      parseArgs(['--transport', 'http'], {
        ONTOLOGY_FILE: 'warehouse.lbdb',
        ONTOLOGY_TOKEN: 'secret',
      }),
    ).toEqual({
      transport: 'http',
      file: 'warehouse.lbdb',
      token: 'secret',
      port: 8788,
      host: DEFAULT_HTTP_HOST,
    });
  });

  it('rejects http without a token, a non-lbdb path, and a missing transport', () => {
    expect(() => parseArgs(['--transport', 'http', '--file', 'ontology.lbdb'], {})).toThrow(
      /ONTOLOGY_TOKEN/,
    );
    expect(() => parseArgs(['--transport', 'stdio', '--file', 'ontology.json'], {})).toThrow(
      /\.lbdb/,
    );
    expect(() =>
      parseArgs(['--file', 'ontology.lbdb'], { ONTOLOGY_FILE: 'ontology.lbdb' }),
    ).toThrow(/--transport/);
  });
});
