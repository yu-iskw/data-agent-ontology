import type { Finding, Report } from './compare.js';

function section(title: string, findings: Finding[]): string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    '',
    `${title} (${findings.length}):`,
    ...findings.map((f) => `  [${f.area}] ${f.key}: ${f.detail}`),
  ];
}

export function formatReport(report: Report, artifact: string, answerDir: string): string {
  return [
    'Jaffle Shop ontology evaluation',
    `artifact: ${artifact}`,
    `answer:   ${answerDir}`,
    '',
    ...report.scores.map(
      (s) => `${s.area.padEnd(12)} ${String(s.matched).padStart(4)} / ${s.expected} matched`,
    ),
    ...section('Differences that break the answer rules', report.hard),
    ...section('Allowed differences', report.soft),
    '',
    report.match ? 'RESULT: MATCH' : `RESULT: MISMATCH (${report.hard.length} differences)`,
  ].join('\n');
}
