import { run } from './src/cli.ts';
await run(['--transport', 'stdio', '--file', process.argv[2]], {});
console.error('RUN_RETURNED');
