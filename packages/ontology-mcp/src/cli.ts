import { parseArgs as parseNodeArgs } from 'node:util';

import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, startHttpServer } from './http.js';
import { openLocalOntology } from './open.js';
import { startStdioServer } from './stdio.js';

type TransportName = 'stdio' | 'http';

export type CliConfig =
  | { transport: 'stdio'; file: string }
  | { transport: 'http'; file: string; token: string; port: number; host: string };

const USAGE =
  'Usage: ontology-mcp --transport stdio|http (--file <path.lbdb> | ONTOLOGY_FILE) [--token <secret> | ONTOLOGY_TOKEN] [--port <n>] [--host <host>]';

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

function hostFrom(flag: string | undefined, env: NodeJS.ProcessEnv): string {
  if (flag !== undefined && flag.length > 0) {
    return flag;
  }
  if (env.HOST !== undefined && env.HOST.length > 0) {
    return env.HOST;
  }
  return DEFAULT_HTTP_HOST;
}

export function parseArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      transport: { type: 'string' },
      file: { type: 'string' },
      token: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
    },
  });
  if (values.transport === undefined) {
    throw new Error(`--transport is required. ${USAGE}`);
  }
  const transport = parseTransport(values.transport);
  const file = requireFile(values.file ?? env.ONTOLOGY_FILE);
  switch (transport) {
    case 'stdio':
      return { transport, file };
    case 'http': {
      const token = values.token ?? env.ONTOLOGY_TOKEN;
      if (token === undefined || token.length === 0) {
        throw new Error('HTTP transport requires --token or ONTOLOGY_TOKEN');
      }
      const port = values.port === undefined ? DEFAULT_HTTP_PORT : parsePort(values.port);
      return { transport, file, token, port, host: hostFrom(values.host, env) };
    }
    default: {
      const unexpected: never = transport;
      throw new Error(`Unexpected transport ${String(unexpected)}`);
    }
  }
}

interface Running {
  close(): Promise<void>;
}

function hold(running: Running, closeStore: () => void): () => void {
  let stopping = false;
  const finish = (): void => {
    closeStore();
    process.exit(0);
  };
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void running.close().finally(finish);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    if (stopping) {
      return;
    }
    stopping = true;
    finish();
  };
}

/** Opens the Ladybug file and serves it until the process is signaled to stop. */
export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = parseArgs(argv, env);
  const opened = openLocalOntology(config.file);
  const closeStore = (): void => {
    opened.close();
  };
  try {
    switch (config.transport) {
      case 'stdio': {
        let disconnect = (): void => {};
        const running = await startStdioServer(opened.client, {
          onClose: () => {
            disconnect();
          },
        });
        disconnect = hold(running, closeStore);
        console.error(`ontology mcp stdio, database ${config.file}`);
        return;
      }
      case 'http': {
        const running = await startHttpServer({
          client: opened.client,
          token: config.token,
          port: config.port,
          host: config.host,
        });
        hold(running, closeStore);
        console.log(`ontology mcp on ${running.url}, database ${config.file}`);
        return;
      }
      default: {
        const unexpected: never = config;
        throw new Error(`Unexpected transport ${JSON.stringify(unexpected)}`);
      }
    }
  } catch (error) {
    closeStore();
    throw error;
  }
}
