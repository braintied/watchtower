import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

/**
 * Analyze text with Claude Haiku 4.5.
 *
 * Uses Anthropic prompt caching on the system prompt for ~90% input token
 * cost reduction on repeated calls with the same system prompt (which is
 * the common pattern for classification, summarization, and extraction).
 */
export async function analyzeWithHaiku(systemPrompt: string, userPrompt: string): Promise<string> {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (textBlock === undefined || textBlock.type !== 'text') {
    throw new Error('No text block in Anthropic response');
  }
  return textBlock.text;
}
