/**
 * Test helper: construct a minimal Anthropic.Message for the AI-call tests, so
 * they can mock responses without hitting the network. Not a test module
 * itself; imported by *.test.ts files.
 */
import type Anthropic from '@anthropic-ai/sdk';

export function makeTextMessage(
  text: string,
  stopReason: Anthropic.Message['stop_reason'] = 'end_turn',
  overrides: { model?: string; usage?: Partial<Anthropic.Usage> } = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: overrides.model ?? 'test',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...overrides.usage,
    },
  } as unknown as Anthropic.Message;
}
