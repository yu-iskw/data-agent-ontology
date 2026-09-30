import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ontology } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { applyProposal, EXTRACTION_ACTOR } from './apply.js';
import { toRevisePatch } from './proposal.js';
import { RECORDING_FORMAT, readRecording, writeRecording } from './recording.js';

import type { Proposal } from './proposal.js';

function ontologyWithWidgets(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope({
    scope: [{ engine: 'duckdb', path: 'mart', completeness: 'full' }],
    tables: [
      { engine: 'duckdb', path: 'mart.widgets', kind: 'table' },
      { engine: 'duckdb', path: 'mart.makers', kind: 'table' },
    ],
    columns: [
      {
        engine: 'duckdb',
        tablePath: 'mart.widgets',
        name: 'widget_id',
        dataType: 'VARCHAR',
        ordinalPosition: 1,
      },
      {
        engine: 'duckdb',
        tablePath: 'mart.widgets',
        name: 'maker_id',
        dataType: 'VARCHAR',
        ordinalPosition: 2,
      },
      {
        engine: 'duckdb',
        tablePath: 'mart.widgets',
        name: 'price',
        dataType: 'DOUBLE',
        ordinalPosition: 3,
      },
      {
        engine: 'duckdb',
        tablePath: 'mart.makers',
        name: 'maker_id',
        dataType: 'VARCHAR',
        ordinalPosition: 1,
      },
    ],
  });
  return ontology;
}

const PROPOSAL: Proposal = {
  domains: [
    { domainId: 'factory', name: 'Factory', parentDomainId: null, tables: [] },
    { domainId: 'goods', name: 'Goods', parentDomainId: 'factory', tables: ['mart.widgets'] },
    { domainId: 'makers', name: 'Makers', parentDomainId: 'factory', tables: ['mart.makers'] },
  ],
  terms: [
    {
      termId: 'widget',
      domainId: 'goods',
      table: 'mart.widgets',
      definition: 'One widget.',
      primaryKey: ['widget_id'],
      foreignKeys: ['maker_id'],
      evidence: 'widget_id is unique.',
    },
    {
      termId: 'maker',
      domainId: 'makers',
      table: 'mart.makers',
      definition: 'One maker.',
      primaryKey: ['maker_id'],
      foreignKeys: [],
      evidence: 'maker_id is unique.',
    },
  ],
  relations: [
    {
      name: 'makes',
      fromTermId: 'maker',
      toTermId: 'widget',
      fromColumn: 'mart.makers.maker_id',
      toColumn: 'mart.widgets.maker_id',
      join: 'mart.makers.maker_id = mart.widgets.maker_id',
      evidence: 'Every widget maker exists.',
    },
  ],
  constraints: [{ termId: 'widget', text: 'price is in dollars.', evidence: 'Checked.' }],
  analysisLayer: {
    termId: 'widget',
    text: 'Analyze from mart. mart.widgets.price = source price in cents / 100.',
    evidence: 'Checked with SQL.',
  },
};

describe('toRevisePatch', () => {
  it('maps every column of each grain table with the proposed key roles', () => {
    const ontology = ontologyWithWidgets();
    const { patch, problems } = toRevisePatch(PROPOSAL, ontology.snapshot());
    expect(problems).toEqual([]);
    ontology.revise(patch);
    const roles = ontology
      .snapshot()
      .mappings.map((m) => [m.mappingId, m.role])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));
    expect(roles).toEqual([
      ['maker.maker_id', 'primary_key'],
      ['widget.maker_id', 'foreign_key'],
      ['widget.price', 'attribute'],
      ['widget.widget_id', 'primary_key'],
    ]);
    expect(ontology.snapshot().tables.map((t) => [t.path, t.domainIds])).toEqual([
      ['mart.makers', ['makers']],
      ['mart.widgets', ['goods']],
    ]);
    expect(ontology.snapshot().constraints.map((c) => c.text)).toEqual(
      expect.arrayContaining([PROPOSAL.constraints[0]?.text, PROPOSAL.analysisLayer.text]),
    );
  });

  it('rejects a plural table name reused as the term id', () => {
    const plural: Proposal = {
      ...PROPOSAL,
      terms: [{ ...PROPOSAL.terms[0], termId: 'widgets' }],
      relations: [],
      constraints: [],
    };
    const { problems } = toRevisePatch(plural, ontologyWithWidgets().snapshot());
    expect(problems).toEqual([
      'Term widgets reuses the plural table name; use the singular noun for one row',
    ]);
  });

  it('rejects a term id that equals a domain id', () => {
    const clash: Proposal = {
      ...PROPOSAL,
      terms: [{ ...PROPOSAL.terms[1], termId: 'makers' }],
      relations: [],
      constraints: [],
    };
    const { problems } = toRevisePatch(clash, ontologyWithWidgets().snapshot());
    expect(problems).toEqual([
      'Term makers has the same id as a domain; term and domain ids must differ',
      'Term makers reuses the plural table name; use the singular noun for one row',
    ]);
  });

  it('reports unknown tables and key columns as problems', () => {
    const broken: Proposal = {
      ...PROPOSAL,
      terms: [{ ...PROPOSAL.terms[0], table: 'mart.gadgets', primaryKey: ['gadget_id'] }],
    };
    const { problems } = toRevisePatch(broken, ontologyWithWidgets().snapshot());
    expect(problems).toEqual([
      'Term widget names table mart.gadgets, which has no observed columns',
      'Term widget key column gadget_id is not a column of mart.gadgets',
      'Term widget key column maker_id is not a column of mart.gadgets',
    ]);
  });
});

describe('replaying a recorded run', () => {
  async function scratch(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'recording-')), 'run.json');
  }

  it('applies a recording to the same ontology as applying the proposal directly', async () => {
    const path = await scratch();
    await writeRecording(path, {
      format: RECORDING_FORMAT,
      model: 'fixture-model',
      sql: [{ sql: 'SELECT 1' }, { sql: 'SELEC 1', error: 'Parser Error' }],
      proposal: PROPOSAL,
    });
    const recording = await readRecording(path);
    expect(recording).toMatchObject({
      model: 'fixture-model',
      sql: [{ sql: 'SELECT 1' }, { error: 'Parser Error' }],
    });

    const direct = ontologyWithWidgets();
    const replayed = ontologyWithWidgets();
    expect(applyProposal(direct, PROPOSAL)).toEqual([]);
    expect(applyProposal(replayed, recording.proposal)).toEqual([]);
    expect(replayed.snapshot()).toEqual({
      ...direct.snapshot(),
      version: replayed.snapshot().version,
    });
    expect(replayed.store.activeVersion?.actor).toEqual(EXTRACTION_ACTOR);
  });

  it('reports problems instead of applying a recording that no longer fits the catalog', () => {
    const other = new Ontology();
    other.submitScope({
      scope: [{ engine: 'duckdb', path: 'other', completeness: 'full' }],
      tables: [{ engine: 'duckdb', path: 'other.things', kind: 'table' }],
      columns: [
        {
          engine: 'duckdb',
          tablePath: 'other.things',
          name: 'id',
          dataType: 'INTEGER',
          ordinalPosition: 1,
        },
      ],
    });
    expect(applyProposal(other, PROPOSAL).length).toBeGreaterThan(0);
    expect(other.snapshot().terms).toEqual([]);
  });

  it('rejects a file that is not a recording', async () => {
    const path = await scratch();
    await writeFile(path, JSON.stringify({ format: 'something-else' }));
    await expect(readRecording(path)).rejects.toThrow();
  });
});
