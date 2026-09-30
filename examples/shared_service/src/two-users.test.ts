import { describe, expect, it } from 'vitest';

import { startSharedOntology } from './host.js';
import { clientsFor, disjointEdits, overlappingEdits } from './two-users.js';

const TOKEN = 'example-token';

describe('two users, one ontology service', () => {
  it('merges edits that touch different terms', async () => {
    const host = await startSharedOntology(TOKEN);
    try {
      const { alice, bob } = clientsFor(host.url, host.token);
      const { definitions } = await disjointEdits(alice, bob);
      expect(definitions).toEqual(
        expect.arrayContaining(['Alice: one purchase, gross', 'Bob: a person who buys']),
      );
    } finally {
      await host.close();
    }
  });

  it('rejects an overlapping edit and keeps the first definition', async () => {
    const host = await startSharedOntology(TOKEN);
    try {
      const { alice, bob } = clientsFor(host.url, host.token);
      const conflict = await overlappingEdits(alice, bob);
      expect(conflict.conflicts.map((row) => row.id)).toContain('order');
      const order = (await alice.snapshot()).terms.find((term) => term.termId === 'order');
      expect(order?.definition).toBe('Alice: gross');
    } finally {
      await host.close();
    }
  });

  it('refuses a client that does not have the token', async () => {
    const host = await startSharedOntology(TOKEN);
    try {
      const { alice } = clientsFor(host.url, 'wrong-token');
      await expect(alice.snapshot()).rejects.toMatchObject({ status: 401 });
    } finally {
      await host.close();
    }
  });
});
