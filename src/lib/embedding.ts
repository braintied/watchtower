import { z } from 'zod';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

const VoyageResponseSchema = z.object({
  data: z.array(z.object({
    embedding: z.array(z.number()),
  })),
});

export async function embedTexts(
  texts: string[],
  inputType: 'query' | 'document' = 'document',
): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new Error('VOYAGE_API_KEY not configured');
  }

  const response = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'voyage-4-large',
      input: texts,
      input_type: inputType,
    }),
  });

  if (!response.ok) {
    throw new Error(`Voyage API error: ${response.status}`);
  }

  const data = VoyageResponseSchema.parse(await response.json());
  return data.data.map((d) => d.embedding);
}

export async function embedText(
  text: string,
  inputType: 'query' | 'document' = 'document',
): Promise<number[]> {
  const results = await embedTexts([text], inputType);
  const embedding = results[0];
  if (embedding === undefined) {
    throw new Error('Voyage returned empty embedding results');
  }
  return embedding;
}
