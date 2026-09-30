import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { InputProcessor } from '@mastra/core/processors';

type ProcessInput = NonNullable<InputProcessor['processInput']>;
type InputArgs = Parameters<ProcessInput>[0];
type Message = InputArgs['messages'][number];

function textOf(message: Message): string {
  const parts = message.content.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  return parts || message.content.content || '';
}

/** The text of the most recent user message, which is the question the ontology should answer. */
function latestQuestion(messages: Message[]): string {
  const user = messages.findLast((message) => message.role === 'user');
  return user ? textOf(user) : '';
}

/**
 * Before the model runs, looks up the user's question and injects the resolved slice, stamped
 * with its version id, as a system message. When nothing matches it changes nothing.
 */
export function createContextProcessor(client: OntologyClient): InputProcessor {
  return {
    id: 'ontology-context',
    name: 'Ontology context',
    processInput: async ({ messages, systemMessages }) => {
      const question = latestQuestion(messages);
      if (question === '') {
        return { messages, systemMessages };
      }
      const context = await client.contextFor(question);
      if (context.text === '') {
        return { messages, systemMessages };
      }
      return {
        messages,
        systemMessages: [...systemMessages, { role: 'system', content: context.text }],
      };
    },
  };
}
