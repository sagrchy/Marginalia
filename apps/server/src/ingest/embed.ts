import os from "node:os";
import path from "node:path";

/**
 * Meaning search: a small sentence-embedding model (bge-small, 384 dims, ~34 MB) that runs on this
 * computer. Downloaded once into the data folder; nothing about the books leaves the machine.
 */
export const EMBED_MODEL = "Xenova/bge-small-en-v1.5";
export const EMBED_DIMS = 384;
/** bge models retrieve better when short queries carry this instruction (passages don't). */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export const embeddingsEnabled = () => process.env.MARGINALIA_EMBEDDINGS !== "off";

type Extractor = (texts: string[], opts: { pooling: "cls"; normalize: true }) => Promise<{ data: Float32Array; dims: number[] }>;

let loading: Promise<Extractor> | null = null;

export function loadEmbedder(dataDir: string): Promise<Extractor> {
  loading ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(dataDir, "models");
    env.allowLocalModels = true;
    // Background work: leave most of the computer's cores to everything else.
    const threads = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 4)));
    const fe = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } as never);
    return fe as unknown as Extractor;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Vectors for passages, in order. */
export async function embedPassages(dataDir: string, texts: string[]): Promise<Float32Array[]> {
  const fe = await loadEmbedder(dataDir);
  const out = await fe(texts, { pooling: "cls", normalize: true });
  return texts.map((_, i) => out.data.slice(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
}

export async function embedQuery(dataDir: string, query: string): Promise<Float32Array> {
  const [v] = await embedPassages(dataDir, [QUERY_PREFIX + query]);
  return v;
}

export const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const fromBlob = (b: Buffer) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

export function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
