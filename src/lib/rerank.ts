/**
 * Voyage AI Reranker
 *
 * Second-stage reranking using Voyage rerank-2.5 cross-encoder.
 * Call after initial vector search to improve precision by 15-40%.
 *
 * API: https://api.voyageai.com/v1/rerank
 */

import { z } from 'zod';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;

const RerankResponseSchema = z.object({
  data: z.array(z.object({
    index: z.number(),
    relevance_score: z.number(),
  })),
});

interface RerankResult<T> {
  item: T;
  relevanceScore: number;
  originalIndex: number;
}

/**
 * Rerank items against a query using Voyage rerank-2.5.
 *
 * @param query - The search query
 * @param documents - Document strings to rerank (one per item)
 * @param items - Original items corresponding to each document
 * @param topK - Number of top results to return (default: all)
 */
export async function rerankWithVoyage<T>(
  query: string,
  documents: string[],
  items: T[],
  topK?: number,
): Promise<RerankResult<T>[]> {
  if (VOYAGE_API_KEY === undefined || VOYAGE_API_KEY === '') {
    throw new Error('VOYAGE_API_KEY not configured');
  }

  if (documents.length === 0) {
    return [];
  }

  const maxDocs = Math.min(documents.length, 1000);
  const truncatedDocs = documents.slice(0, maxDocs);
  const truncatedItems = items.slice(0, maxDocs);

  const response = await fetch('https://api.voyageai.com/v1/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'rerank-2.5',
      query,
      documents: truncatedDocs,
      top_k: topK !== undefined ? topK : truncatedDocs.length,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'unknown error');
    throw new Error(`Voyage rerank API error: ${response.status} ${errText}`);
  }

  const data = RerankResponseSchema.parse(await response.json());

  const results: RerankResult<T>[] = [];
  for (const entry of data.data) {
    const item = truncatedItems[entry.index];
    if (item !== undefined) {
      results.push({
        item,
        relevanceScore: entry.relevance_score,
        originalIndex: entry.index,
      });
    }
  }

  return results;
}
