# Jaffle Shop ontology evaluator

Grades an ontology artifact against [`answer/jaffle_shop.json`](answer/jaffle_shop.json) under the rules in [`answer/README.md`](answer/README.md). It runs as its own process and reads only the artifact and the answer files.

```bash
pnpm --filter @data-agent-ontology/eval-jaffle-shop evaluate --artifact ../../examples/mastra_basic/out/ontology.json
pnpm --filter @data-agent-ontology/eval-jaffle-shop evaluate --artifact <path> --json <report.json>
```

Relative paths resolve from `eval/jaffle-shop`. The exit code is 0 on a match, 1 on a mismatch, and 2 on a usage or input error.

## What it checks

Records are matched by natural keys, so generated ids never matter.

| Area        | Key                                     | Must match                                          | Reported but allowed |
| ----------- | --------------------------------------- | --------------------------------------------------- | -------------------- |
| domains     | domain id                               | parent domain                                       | name                 |
| tables      | engine and path                         | kind, domain membership                             |                      |
| columns     | table path and column name              | data type                                           | ordinal position     |
| terms       | term name                               | domain                                              |                      |
| mappings    | term name and column                    | role                                                |                      |
| relations   | the two joined columns                  | name, direction, calendar-date join for `occurs_on` | join text            |
| constraints | answer constraint id                    | the facts listed in `src/constraint-rules.ts`       | wording, term        |
| lifecycle   | every record                            | `active: true`, `drifted: false`                    |                      |
| evidence    | terms, mappings, relations, constraints | evidence with `source: "revise"`                    |                      |

Missing and unexpected records are differences in every area.

## Isolation test

`src/isolation.test.ts` fails if `examples/mastra_basic` contains a file named like the answer file, a byte copy of any answer file, the answer path, an import of this package, or a relative path into `eval/`. A second case plants each leak in a scratch directory to prove the scan catches it.
