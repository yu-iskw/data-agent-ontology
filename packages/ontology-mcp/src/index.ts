export { parseArgs, run } from './cli.js';
export { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, MCP_PATH, startHttpServer } from './http.js';
export { openLocalOntology } from './open.js';
export { createOntologyMcpServer } from './server.js';
export { startStdioServer } from './stdio.js';
export { PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE } from './tools.js';

export type { CliConfig, TransportName } from './cli.js';
export type { HttpListenOptions, RunningMcpHttp } from './http.js';
export type { OpenedOntology } from './open.js';
export type { RunningStdio, StdioOptions } from './stdio.js';
