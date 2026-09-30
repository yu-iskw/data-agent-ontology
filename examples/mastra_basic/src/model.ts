import { createVertex } from '@ai-sdk/google-vertex';

import type { Agent } from '@mastra/core/agent';

/** Vertex publisher model `gemini-3.8-flash` on project ubie-yu-sandbox, location global. */
export const DEFAULT_MODEL = 'google-vertex/gemini-3.8-flash';

const VERTEX_PREFIX = 'google-vertex/';

/** Opens the model id on Vertex with Application Default Credentials. */
function vertexModel(modelId: string): Agent['model'] {
  delete process.env.GOOGLE_VERTEX_API_KEY;
  return createVertex({ project: 'ubie-yu-sandbox', location: 'global' })(modelId);
}

export function resolveModel(model: string): Agent['model'] {
  if (!model.startsWith(VERTEX_PREFIX)) {
    return model;
  }
  return vertexModel(model.slice(VERTEX_PREFIX.length));
}
