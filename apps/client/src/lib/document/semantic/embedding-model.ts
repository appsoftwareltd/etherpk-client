/**
 * The one seam [[Semantic Search]] has: something that turns text into [[Embedding]]s
 * ([[2026-09-16 Semantic Search]] → The embedder seam). Everything else - passages, the
 * store, the scan, the build loop - is written once and does not know which model or runtime
 * sits behind this interface. The [[Headless Client]] implements it over a native ONNX runtime
 * (`apps/mcp/src/embedder.ts`); the tests implement it with the deterministic fake below.
 *
 * What is embedded is the passage text (breadcrumb line included); what comes back is one
 * unit-length float vector per text. Quantisation to the stored int8 form is here too, so every
 * caller stores exactly the same bytes for the same vector.
 */

export interface EmbeddingModel {
    /**
     * Names the model AND its quantisation, e.g. `all-MiniLM-L6-v2-int8`. Stored on every row:
     * two models' numbers never compare, so a change of model is a fresh set of vectors under
     * a new id rather than a corruption of the old.
     */
    readonly id: string
    readonly dims: number
    /** Unit-length vectors, one per text, in order. Batched because per-call overhead dominates. */
    embed(texts: readonly string[]): Promise<Float32Array[]>
    /** Release the runtime; optional because the fake has nothing to release. */
    dispose?(): Promise<void> | void
}

/**
 * A vector as stored: each component rounded to a byte, with one float scale that puts it
 * back. A unit vector's components are small (a few hundredths), so a fixed ±1 scale would
 * waste the byte; scaling each vector by its own largest component keeps the precision where
 * the vector actually is. The dot product against a float query is then `scale * Σ q[i]·v[i]`.
 */
export interface QuantisedVector {
    vec: Int8Array
    scale: number
}

export function quantise(vector: Float32Array): QuantisedVector {
    let max = 0
    for (let i = 0; i < vector.length; i++) max = Math.max(max, Math.abs(vector[i]))
    const scale = max === 0 ? 1 : max / 127
    const vec = new Int8Array(vector.length)
    for (let i = 0; i < vector.length; i++) vec[i] = Math.round(vector[i] / scale)
    return { vec, scale }
}

/** Scale a vector to unit length in place and return it; a zero vector is left alone. */
export function normalise(vector: Float32Array): Float32Array {
    let sum = 0
    for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i]
    const norm = Math.sqrt(sum)
    if (norm === 0) return vector
    for (let i = 0; i < vector.length; i++) vector[i] /= norm
    return vector
}

export interface FakeEmbeddingOptions {
    dims?: number
    /**
     * Words that embed as another word, so a test can place "loop" beside "storm" and prove
     * that a query finds a passage it shares no words with - the thing a real model does and a
     * bag of words cannot.
     */
    synonyms?: Record<string, string>
    /** Every call's texts, for asserting what was embedded and how often. */
    calls?: string[][]
}

/**
 * A deterministic bag-of-words embedder for tests: each word hashes to a dimension and a sign,
 * so texts sharing words are near and texts sharing none are (near) orthogonal. Fast, needs no
 * model, and its behaviour is exactly predictable, which is what a test wants from it.
 */
export function fakeEmbeddingModel(options: FakeEmbeddingOptions = {}): EmbeddingModel {
    const dims = options.dims ?? 64
    const synonyms = options.synonyms ?? {}
    return {
        id: `fake-${dims}`,
        dims,
        async embed(texts) {
            options.calls?.push([...texts])
            return texts.map((text) => {
                const vector = new Float32Array(dims)
                for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
                    if (raw === '') continue
                    const word = synonyms[raw] ?? raw
                    const h = fnv1a(word)
                    vector[h % dims] += (h & 0x100) === 0 ? 1 : -1
                }
                return normalise(vector)
            })
        },
    }
}

function fnv1a(text: string): number {
    let hash = 0x811c9dc5
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash
}
