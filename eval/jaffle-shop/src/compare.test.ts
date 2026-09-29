import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { ANSWER_DIR } from './answer-dir.js';
import { compareOntologies } from './compare.js';
import { CONSTRAINT_RULES } from './constraint-rules.js';
import { loadDocument } from './document.js';
import { formatReport } from './format.js';

import type { OntologyDocument } from './document.js';

let answer: OntologyDocument;

beforeAll(async () => {
  answer = await loadDocument(join(ANSWER_DIR, 'jaffle_shop.json'));
});

function copy(): OntologyDocument {
  return structuredClone(answer);
}

describe('compareOntologies', () => {
  it('has a rule for every answer constraint', () => {
    expect([...CONSTRAINT_RULES.keys()].sort()).toEqual(
      answer.constraints.map((c) => c.constraintId).sort(),
    );
  });

  it('matches the answer against itself', () => {
    const report = compareOntologies(answer, copy());
    expect(report.hard).toEqual([]);
    expect(report.match).toBe(true);
    expect(formatReport(report, 'a', 'b')).toContain('RESULT: MATCH');
  });

  it('ignores generated ids, definitions, and constraint wording', () => {
    const doc = copy();
    for (const mapping of doc.mappings) {
      mapping.mappingId = `m-${mapping.mappingId}`;
    }
    for (const evidence of doc.evidence) {
      evidence.targetId = evidence.targetId.startsWith('customer')
        ? `m-${evidence.targetId}`
        : evidence.targetId;
    }
    doc.terms[0].definition = 'Someone who bought something.';
    doc.constraints = doc.constraints.map((c) => ({ ...c, text: `Rule: ${c.text.toUpperCase()}` }));
    const report = compareOntologies(answer, doc);
    expect(report.hard.filter((f) => f.area !== 'evidence')).toEqual([]);
  });

  it('reports each README miss', () => {
    const doc = copy();
    doc.columns = doc.columns.filter((c) => c.columnId !== 'duckdb:main.orders.order_cost');
    doc.mappings = doc.mappings.filter((m) => m.mappingId !== 'order.order_cost');
    doc.mappings.push({
      mappingId: 'order.raw_id',
      termId: 'order',
      columnId: 'duckdb:raw.raw_orders.id',
      role: 'attribute',
      active: true,
      drifted: false,
    });
    doc.tables = doc.tables.filter((t) => t.path !== 'main.stg_orders');
    doc.relations = doc.relations.filter((r) => r.name !== 'used_by');
    doc.constraints = doc.constraints.filter(
      (c) => c.constraintId !== 'supply_cost_no_double_count',
    );
    const keys = compareOntologies(answer, doc).hard.map((f) => `${f.area} ${f.key} ${f.detail}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        'tables duckdb:main.stg_orders missing',
        'columns main.orders.order_cost missing',
        'mappings order -> main.orders.order_cost missing',
        'mappings order -> raw.raw_orders.id unexpected',
        'relations main.products.product_id = main.supplies.product_id missing',
        expect.stringContaining('constraints supply_cost_no_double_count missing') as string,
      ]),
    );
  });

  it('reports a second relation on the same columns as unexpected', () => {
    const doc = copy();
    const places = doc.relations.find((r) => r.name === 'places');
    if (!places) {
      throw new Error('answer is missing the customer relation');
    }
    doc.relations.push({ ...places, relationId: `${places.relationId}_extra`, name: 'also_links' });
    const report = compareOntologies(answer, doc);
    expect(report.hard.filter((f) => f.area === 'relations')).toEqual([
      expect.objectContaining({
        detail: 'unexpected',
        key: expect.stringContaining('#2') as string,
      }),
    ]);
    expect(report.match).toBe(false);
  });

  it('does not file a failed calendar-date join as an allowed difference', () => {
    const doc = copy();
    const occurs = doc.relations.find((r) => r.relationId === 'order_occurs_on_calendar_day');
    if (!occurs) {
      throw new Error('answer is missing the calendar relation');
    }
    occurs.join = 'main.orders.ordered_at = main.metricflow_time_spine.date_day';
    const report = compareOntologies(answer, doc);
    expect(report.hard.map((f) => f.detail)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('join must use the calendar date') as string,
      ]),
    );
    expect(report.soft).toEqual([]);
    expect(report.match).toBe(false);
  });

  it('allows CAST versus cast when the relation name stays the same', () => {
    const doc = copy();
    const occurs = doc.relations.find((r) => r.relationId === 'order_occurs_on_calendar_day');
    if (!occurs) {
      throw new Error('answer is missing the calendar relation');
    }
    occurs.join = 'cast(main.orders.ordered_at as date) = main.metricflow_time_spine.date_day';
    const report = compareOntologies(answer, doc);
    expect(report.hard).toEqual([]);
    expect(report.match).toBe(true);
    expect(report.soft.map((f) => f.detail)).toEqual([expect.stringContaining('join:') as string]);
    expect(formatReport(report, 'a', 'b')).toContain('RESULT: MATCH');
  });

  it('requires relation names, directions, and a calendar-date join', () => {
    const doc = copy();
    const occurs = doc.relations.find((r) => r.relationId === 'order_occurs_on_calendar_day')!;
    occurs.join = 'main.orders.ordered_at = main.metricflow_time_spine.date_day';
    const places = doc.relations.find((r) => r.name === 'places')!;
    Object.assign(places, { name: 'placed_by', fromTermId: 'order', toTermId: 'customer' });
    const details = compareOntologies(answer, doc).hard.map((f) => f.detail);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringContaining('join must use the calendar date') as string,
        'name: expected "places", got "placed_by"',
        'direction: expected "customer -> order", got "order -> customer"',
      ]),
    );
  });
});
