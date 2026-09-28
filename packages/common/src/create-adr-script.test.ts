import { describe, expect, it } from 'vitest';

declare function require(name: string): unknown;
declare const process: { cwd: () => string };

interface ExecFileSync {
  (file: string, args: readonly string[], options: { encoding: 'utf8' }): string;
}

function findHarness(): string {
  const { existsSync } = require('fs') as { existsSync: (p: string) => boolean };
  const { resolve } = require('path') as {
    resolve: (...parts: string[]) => string;
  };

  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, '.claude/skills/manage-adr/scripts/test-create-adr.sh');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error('test-create-adr.sh not found from ' + process.cwd());
}

describe('create-adr.sh', () => {
  it('passes the portable bash regression harness', () => {
    const harness = findHarness();
    // Trusted local harness; argv is fixed (no user input).
    // eslint-disable-next-line security/detect-child-process -- test runs repo bash harness
    const { execFileSync } = require('child_process') as {
      execFileSync: ExecFileSync;
    };
    const stdout = execFileSync('/bin/bash', [harness], { encoding: 'utf8' });
    expect(stdout).toContain('ALL PASSED');
  });
});
