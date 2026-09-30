import { MAX_RESOLVE_TERMS } from '@data-agent-ontology/ontology-core';

import { formatContext } from './format.js';

import type { OntologyContext } from './client.js';
import type { BrowseResult, ResolveResult } from '@data-agent-ontology/ontology-core';

/** The browse and resolve calls `contextFor` needs. Local and remote clients both qualify. */
interface ContextSource {
  browse(question: string): Promise<BrowseResult>;
  resolve(termIds: string[]): Promise<ResolveResult>;
}

/** Browse, keep term hits within the resolve cap, then format what resolved. */
export async function contextFor(
  source: ContextSource,
  question: string,
): Promise<OntologyContext> {
  const { versionId, hits } = await source.browse(question);
  const termIds = hits
    .filter((hit) => hit.kind === 'term')
    .slice(0, MAX_RESOLVE_TERMS)
    .map((hit) => hit.id);
  if (termIds.length === 0) {
    return { versionId, text: '', termIds };
  }
  const resolved = await source.resolve(termIds);
  return { versionId: resolved.versionId, text: formatContext(resolved), termIds };
}
