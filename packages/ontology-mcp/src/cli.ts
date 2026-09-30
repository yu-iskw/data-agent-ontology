import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttpServer } from './http.js';
import { openLocalOntology } from './open.js';
import { startStdioServer } from './stdio.js';

export type TransportName = 'stdio' | 'http';

interface CommonConfig {
  file: string;
  port: number;
  host: string;
}

export type CliConfig = CommonConfig &
  ({ transport: 'stdio'; token?: string } | { transport: 'http'; token: string });

const USAGE =
  'Usage: ontology-mcp --transport stdio|http (--file <path.lbdb> | ONTOLOGY_FILE) [--token <secret> | ONTOLOGY_TOKEN] [--port <n>] [--host <host>]';

interface Draft {
  transport?: TransportName;
  file?: string;
  token?: string;
  port: number;
  host: string;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const next = index + 1;
  if (next >= argv.length) {
    throw new Error(`${flag} requires a value`);
  }
  // CLI cursor, not an object key.
  // eslint-disable-next-line security/detect-object-injection
  const value = argv[next];
  if (value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseTransport(value: string): TransportName {
  switch (value) {
    case 'stdio':
    case 'http':
      return value;
    default:
      throw new Error('--transport must be stdio or http');
  }
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  const port = Number(value);
  if (port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535');
  }
  return port;
}

function requireFile(file: string | undefined): string {
  if (file === undefined || file.length === 0) {
    throw new Error('Set --file or ONTOLOGY_FILE to a .lbdb path');
  }
  if (!file.endsWith('.lbdb')) {
    throw new Error('--file must be a .lbdb path');
  }
  return file;
}

function finish(draft: Draft): CliConfig {
  if (draft.transport === undefined) {
    throw new Error(`--transport is required. ${USAGE}`);
  }
  const file = requireFile(draft.file);
  const common = { file, port: draft.port, host: draft.host };
  switch (draft.transport) {
    case 'stdio':
      return { ...common, transport: 'stdio', token: draft.token };
    case 'http':
      if (draft.token === undefined || draft.token.length === 0) {
        throw new Error('HTTP transport requires --token or ONTOLOGY_TOKEN');
      }
      return { ...common, transport: 'http', token: draft.token };
    default: {
      const unexpected: never = draft.transport;
      throw new Error(`Unexpected transport ${String(unexpected)}`);
    }
  }
}

function applyFlag(draft: Draft, argv: readonly string[], index: number): number {
  // CLI cursor, not an object key.
  // eslint-disable-next-line security/detect-object-injection
  const flag = argv[index] ?? '';
  switch (flag) {
    case '--transport':
      draft.transport = parseTransport(takeValue(argv, index, flag));
      return index + 2;
    case '--file':
      draft.file = takeValue(argv, index, flag);
      return index + 2;
    case '--token':
      draft.token = takeValue(argv, index, flag);
      return index + 2;
    case '--port':
      draft.port = parsePort(takeValue(argv, index, flag));
      return index + 2;
    case '--host':
      draft.host = takeValue(argv, index, flag);
      return index + 2;
    default:
      throw new Error(`Unknown argument ${flag}. ${USAGE}`);
  }
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  const draft: Draft = {
    file: env.ONTOLOGY_FILE,
    token: env.ONTOLOGY_TOKEN,
    port: DEFAULT_HTTP_PORT,
    host: env.HOST === undefined || env.HOST.length === 0 ? DEFAULT_HTTP_HOST : env.HOST,
  };
  for (let index = 0; index < argv.length;) {
    index = applyFlag(draft, argv, index);
  }
  return finish(draft);
}

interface Running {
  close(): Promise<void>;
}

function untilSignal(running: Running, closeStore: () => void): void {
  const stop = (): void => {
    void running.close().finally(() => {
      closeStore();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

/** Opens the Ladybug file and serves it until the process is signaled to stop. */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseArgs(argv, env);
  const opened = openLocalOntology(config.file);
  try {
    switch (config.transport) {
      case 'stdio': {
        const running = await startStdioServer(opened.client, {
          onClose: () => {
            opened.close();
            process.exit(0);
          },
        });
        console.error(`ontology mcp stdio, database ${config.file}`);
        untilSignal(running, () => {
          opened.close();
        });
        return;
      }
      case 'http': {
        const running = await startHttpServer({
          client: opened.client,
          token: config.token,
          port: config.port,
          host: config.host,
        });
        console.log(`ontology mcp on ${running.url}, database ${config.file}`);
        untilSignal(running, () => {
          opened.close();
        });
        return;
      }
      default: {
        const unexpected: never = config;
        throw new Error(`Unexpected transport ${JSON.stringify(unexpected)}`);
      }
    }
  } catch (error) {
    opened.close();
    throw error;
  }
}
