import { describe, expect, it } from 'vitest';

import { RemoteOntologyClient } from './remote.js';

describe('RemoteOntologyClient errors', () => {
  it('revives an unknown version from details', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: 'unknown_version', message: 'nope', details: { versionId: 'v9' } },
          }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        ),
      );
    const client = new RemoteOntologyClient({
      url: 'http://ontology.test',
      token: 't',
      fetch: fetchImpl,
    });
    await expect(client.rollback('ignored')).rejects.toMatchObject({
      name: 'UnknownVersionError',
      versionId: 'v9',
    });
  });
});
