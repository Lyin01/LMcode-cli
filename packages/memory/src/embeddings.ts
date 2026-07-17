import type { MemoryMemo } from './models.js';

/**
 * Text used to generate embeddings for a memo.
 * Combines the most semantically meaningful fields.
 */
export function buildEmbeddingText(memo: MemoryMemo): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatWorked}`;
}

export interface EmbeddingEngine {
  /** Whether the engine loaded successfully. */
  readonly available: boolean;

  /**
   * Model identifier persisted alongside each stored vector. Vector search
   * filters on it so embeddings from a previous model are never compared
   * against (cosine across models yields meaningless scores).
   */
  readonly model?: string;

  /**
   * Generate embeddings for a batch of texts.
   * Returns null if the engine failed to load or the model is unavailable.
   */
  embedBatch(texts: string[]): Promise<Float32Array[] | null>;

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number;
}

/** Minimal interface for the fastembed model — avoids importing fastembed at module level. */
interface FastembedModel {
  embed(
    textStrings: string[],
    batchSize?: number,
  ): AsyncGenerator<number[][], void, unknown>;
}

/**
 * After a load failure the engine stays unavailable for this long, then one
 * retry is allowed. A permanent disable would silently turn off vector recall
 * for the rest of the process on any transient failure (download hiccup,
 * OOM during first load).
 */
const LOAD_FAILURE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Create an embedding engine backed by fastembed.
 * Lazily loads the model on first use so startup is not blocked.
 */
export function createFastEmbedEngine(): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;
  let loadFailedAt: number | undefined;

  const markLoadFailed = (): void => {
    loadFailedAt = Date.now();
    // Drop the resolved-null init promise so the next retry after the
    // cooldown actually re-runs loadEmbedder instead of re-awaiting the
    // previous failure.
    initPromise = null;
  };

  return {
    model: 'bge-small-zh-v1.5',

    get available(): boolean {
      return (
        loadFailedAt === undefined ||
        Date.now() - loadFailedAt >= LOAD_FAILURE_RETRY_COOLDOWN_MS
      );
    },

    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (!this.available) return null;
      if (texts.length === 0) return [];

      try {
        if (embedder === null) {
          if (initPromise === null) {
            initPromise = loadEmbedder();
          }
          embedder = await initPromise;
          if (embedder === null) {
            markLoadFailed();
            return null;
          }
        }

        const generator = embedder.embed(texts);

        const vectors: Float32Array[] = [];
        for await (const batch of generator) {
          for (const vec of batch) {
            vectors.push(new Float32Array(vec));
          }
        }
        if (vectors.length === 0) {
          markLoadFailed();
          return null;
        }
        loadFailedAt = undefined;
        return vectors;
      } catch {
        markLoadFailed();
        return null;
      }
    },

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    },
  };
}

async function loadEmbedder(): Promise<FastembedModel | null> {
  try {
    const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
    return await FlagEmbedding.init({ model: EmbeddingModel.BGESmallZH });
  } catch {
    return null;
  }
}
