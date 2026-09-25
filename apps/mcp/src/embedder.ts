/**
 * The [[Headless Client]]'s `EmbeddingModel`: a MiniLM-class sentence encoder run by the
 * native ONNX runtime, with the runtime AND the model fetched on demand into the cache
 * directory ([[2026-09-16 Semantic Search]] → Phase A; ADR 0076).
 *
 * Neither is a dependency of the published package, deliberately. `onnxruntime-node` unpacks
 * to some 300 MB and the model is another 23 MB; a text-only agent running through `npx` must
 * not pay for that, and most will never ask for meaning. So `semantic setup` installs the
 * runtime with the user's own npm into `~/.cache/etherpk/mcp/runtime/` and downloads the model
 * files beside it, each pinned by sha256; `serve` finds them there or says how to get them.
 * The tokeniser (`@huggingface/tokenizers`, 360 KB, pure JS) IS a dependency: it is the same
 * code a browser would run, and too small to be worth a second step.
 *
 * Model: `Xenova/all-MiniLM-L6-v2`, int8 ONNX export, 384 dimensions, pinned to one commit.
 * Measured on an 8-core i7 (Performance.md → Embedding throughput): int8 scores the STS pairs
 * as fp32 does and runs half again as fast, so the 23 MB file is the one shipped.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import { Tokenizer } from '@huggingface/tokenizers'

import { type EmbeddingModel, normalise } from '$lib/document/semantic/embedding-model'

import { cacheRoot } from './persistence'

const HF = 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9'

export interface ModelFile {
    name: string
    url: string
    sha256: string
    bytes: number
}

/** The one model this version knows. Its id is on every stored vector (embedding-db.ts). */
export const MODEL = {
    id: 'all-MiniLM-L6-v2-int8',
    dims: 384,
    /** The encoder reads 256 tokens; longer passages are cut, keeping the final [SEP]. */
    maxTokens: 256,
    files: [
        { name: 'model.onnx', url: `${HF}/onnx/model_int8.onnx`, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1', bytes: 22_972_370 },
        { name: 'tokenizer.json', url: `${HF}/tokenizer.json`, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0', bytes: 711_661 },
        { name: 'tokenizer_config.json', url: `${HF}/tokenizer_config.json`, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3', bytes: 366 },
    ] as readonly ModelFile[],
} as const

/** The native runtime, pinned: its ABI is what the model file was tested against. */
export const RUNTIME = { name: 'onnxruntime-node', version: '1.30.0' } as const

export interface SemanticPaths {
    /** Where the runtime is npm-installed: `<cache root>/runtime/node_modules/onnxruntime-node`. */
    runtimeDir: string
    /** `<cache root>/models/<model id>/`. */
    modelDir: string
}

export function semanticPaths(env: NodeJS.ProcessEnv): SemanticPaths {
    const root = cacheRoot(env)
    return { runtimeDir: join(root, 'runtime'), modelDir: join(root, 'models', MODEL.id) }
}

export interface SemanticSetupStatus extends SemanticPaths {
    runtime: boolean
    model: boolean
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

async function sha256Of(path: string): Promise<string | null> {
    try {
        return createHash('sha256').update(await readFile(path)).digest('hex')
    } catch {
        return null
    }
}

/**
 * Whether both halves appear to be there, by presence alone - no hashing - so a running
 * `serve` can ask every half minute for next to nothing. Setup writes each model file by
 * rename, so a file that exists is a whole one; the hashes are still checked when the model is
 * actually loaded.
 */
export async function semanticSetupPresent(env: NodeJS.ProcessEnv, files: readonly ModelFile[] = MODEL.files): Promise<boolean> {
    const paths = semanticPaths(env)
    if (!(await exists(join(paths.runtimeDir, 'node_modules', RUNTIME.name, 'package.json')))) return false
    for (const file of files) if (!(await exists(join(paths.modelDir, file.name)))) return false
    return true
}

/**
 * Call `onReady` once, when setup appears on this machine - for a `serve` started before the
 * user ran it, so the store starts building without a restart and without waiting for the
 * agent to ask by meaning. Returns a stop function; the timer never keeps the process alive.
 */
export function whenSemanticSetUp(env: NodeJS.ProcessEnv, onReady: () => void, intervalMs = 30_000, files: readonly ModelFile[] = MODEL.files): () => void {
    const timer = setInterval(() => {
        void semanticSetupPresent(env, files).then((present) => {
            if (!present) return
            clearInterval(timer)
            onReady()
        })
    }, intervalMs)
    timer.unref()
    return () => clearInterval(timer)
}

/** Whether both halves are present; the model's files are checked by hash, not by name. */
export async function semanticSetupStatus(env: NodeJS.ProcessEnv, files: readonly ModelFile[] = MODEL.files): Promise<SemanticSetupStatus> {
    const paths = semanticPaths(env)
    const runtime = await exists(join(paths.runtimeDir, 'node_modules', RUNTIME.name, 'package.json'))
    let model = true
    for (const file of files) {
        if ((await sha256Of(join(paths.modelDir, file.name))) !== file.sha256) model = false
    }
    return { ...paths, runtime, model }
}

export interface SemanticSetupIo {
    env: NodeJS.ProcessEnv
    say(line: string): void
    /** Swap points for tests: no network, no npm, and files whose hashes a test can satisfy. */
    fetch?: typeof fetch
    npmInstall?: (args: string[], cwd: string, say: (line: string) => void) => Promise<void>
    files?: readonly ModelFile[]
}

/**
 * Install what `serve` needs for semantic mode, skipping whatever is already there and right.
 * Idempotent, so it is also the repair: a runtime half-installed or a model file that fails
 * its hash is simply done again.
 */
export async function setupSemantic(io: SemanticSetupIo): Promise<SemanticSetupStatus> {
    const files = io.files ?? MODEL.files
    const status = await semanticSetupStatus(io.env, files)
    if (!status.runtime) {
        io.say(`Installing ${RUNTIME.name} ${RUNTIME.version} into ${status.runtimeDir} (about 300 MB; native, so it is not part of the etherpk-mcp package)…`)
        await mkdir(status.runtimeDir, { recursive: true, mode: 0o700 })
        const manifest = join(status.runtimeDir, 'package.json')
        if (!(await exists(manifest))) await writeFile(manifest, JSON.stringify({ name: 'etherpk-mcp-runtime', private: true }, null, 2))
        // --ignore-scripts: the runtime's postinstall fetches GPU builds this never uses.
        const args = ['install', '--no-audit', '--no-fund', '--no-package-lock', '--omit=dev', '--ignore-scripts', `${RUNTIME.name}@${RUNTIME.version}`]
        await (io.npmInstall ?? npmInstall)(args, status.runtimeDir, io.say)
    } else {
        io.say(`Runtime present: ${status.runtimeDir}`)
    }
    await mkdir(status.modelDir, { recursive: true, mode: 0o700 })
    for (const file of files) {
        const path = join(status.modelDir, file.name)
        if ((await sha256Of(path)) === file.sha256) {
            io.say(`Model file present: ${file.name}`)
            continue
        }
        io.say(`Downloading ${file.name} (${Math.max(1, Math.round(file.bytes / 1e6))} MB) from ${new URL(file.url).host}…`)
        await download(io.fetch ?? fetch, file, path)
    }
    io.say(`Semantic search is set up. Model: ${MODEL.id} (${MODEL.dims} dimensions) in ${status.modelDir}.`)
    return semanticSetupStatus(io.env, files)
}

async function npmInstall(args: string[], cwd: string, say: (line: string) => void): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const windows = process.platform === 'win32'
        const child = spawn(windows ? 'npm.cmd' : 'npm', args, { cwd, shell: windows, stdio: ['ignore', 'pipe', 'pipe'] })
        const relay = (chunk: Buffer) => {
            for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) say(`  npm: ${line.trimEnd()}`)
        }
        child.stdout.on('data', relay)
        child.stderr.on('data', relay)
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with ${code}`))))
    })
}

/** Stream to a temp file, verify the hash, then rename: a half-download never masquerades. */
async function download(fetchFn: typeof fetch, file: ModelFile, path: string): Promise<void> {
    const response = await fetchFn(file.url)
    if (!response.ok || !response.body) throw new Error(`${file.url}: HTTP ${response.status}`)
    const temp = `${path}.${process.pid}.tmp`
    const hash = createHash('sha256')
    await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
        async function* (source) {
            for await (const chunk of source) {
                hash.update(chunk as Uint8Array)
                yield chunk
            }
        },
        createWriteStream(temp, { mode: 0o600 }),
    )
    const digest = hash.digest('hex')
    if (digest !== file.sha256) {
        await rm(temp, { force: true })
        throw new Error(`${file.name} downloaded with sha256 ${digest}, expected ${file.sha256}; not kept.`)
    }
    await rename(temp, path)
}

/** Delete the runtime and the model; `logout --all` removes them with the rest of the cache. */
export async function removeSemantic(env: NodeJS.ProcessEnv): Promise<void> {
    const paths = semanticPaths(env)
    await rm(paths.runtimeDir, { recursive: true, force: true })
    await rm(join(cacheRoot(env), 'models'), { recursive: true, force: true })
}

/** Thrown by `loadEmbeddingModel` when setup has not been done here; the message says what to run. */
export class SemanticUnavailable extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'SemanticUnavailable'
    }
}

export const SETUP_HINT = 'run `npx @appsoftwareltd/etherpk-mcp semantic setup` on this computer once (it installs a ~300 MB runtime and a 23 MB model into the cache directory); the next semantic search will use it, no restart needed.'

// The runtime's surface, typed as narrowly as this module uses it: the package is loaded from
// a path outside the bundle, so its own types are not on hand.
interface OrtTensor {
    dims: number[]
    data: Float32Array
}
interface OrtSession {
    run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
    release(): Promise<void>
}
interface OrtRuntime {
    InferenceSession: { create(path: string, options: Record<string, unknown>): Promise<OrtSession> }
    Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown
}

export interface LoadOptions {
    /**
     * Intra-op threads. Default: a quarter of the cores, at most four - a background build on a
     * laptop must not be the hottest thing on it - overridable with `ETHERPK_MCP_SEMANTIC_THREADS`.
     */
    threads?: number
}

/** The thread count `serve` uses: the option, else the environment, else the conservative default. */
export function semanticThreads(env: NodeJS.ProcessEnv, requested?: number): number {
    if (requested !== undefined) return Math.max(1, Math.floor(requested))
    const fromEnv = Number(env.ETHERPK_MCP_SEMANTIC_THREADS)
    if (Number.isInteger(fromEnv) && fromEnv >= 1) return fromEnv
    return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 4)))
}

/**
 * Load the runtime from the cache directory and open the model. Resident memory is a few
 * hundred megabytes, so `serve` calls this only when semantic mode is set up on the machine.
 */
export async function loadEmbeddingModel(env: NodeJS.ProcessEnv, options: LoadOptions = {}): Promise<EmbeddingModel> {
    const status = await semanticSetupStatus(env)
    if (!status.runtime || !status.model) {
        throw new SemanticUnavailable(`Semantic search is not set up on this computer: ${SETUP_HINT}`)
    }
    const require = createRequire(join(status.runtimeDir, 'package.json'))
    let ort: OrtRuntime
    try {
        const loaded = (await import(pathToFileURL(require.resolve(RUNTIME.name)).href)) as { default?: OrtRuntime } & OrtRuntime
        ort = loaded.default?.InferenceSession ? loaded.default : loaded
    } catch (error) {
        throw new SemanticUnavailable(`The embedding runtime in ${status.runtimeDir} failed to load (${error instanceof Error ? error.message : String(error)}); ${SETUP_HINT}`)
    }
    const tokenizer = new Tokenizer(
        JSON.parse(await readFile(join(status.modelDir, 'tokenizer.json'), 'utf8')),
        JSON.parse(await readFile(join(status.modelDir, 'tokenizer_config.json'), 'utf8')),
    )
    const threads = semanticThreads(env, options.threads)
    const session = await ort.InferenceSession.create(join(status.modelDir, 'model.onnx'), {
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
    })

    const encode = (text: string): number[] => {
        const ids = tokenizer.encode(text).ids
        return ids.length > MODEL.maxTokens ? [...ids.slice(0, MODEL.maxTokens - 1), ids[ids.length - 1]] : ids
    }

    return {
        id: MODEL.id,
        dims: MODEL.dims,
        async embed(texts) {
            if (texts.length === 0) return []
            const encoded = texts.map(encode)
            const width = Math.max(...encoded.map((ids) => ids.length))
            const batch = texts.length
            const inputIds = new BigInt64Array(batch * width)
            const mask = new BigInt64Array(batch * width)
            const types = new BigInt64Array(batch * width)
            encoded.forEach((ids, row) => {
                for (let i = 0; i < ids.length; i++) {
                    inputIds[row * width + i] = BigInt(ids[i])
                    mask[row * width + i] = 1n
                }
            })
            const output = await session.run({
                input_ids: new ort.Tensor('int64', inputIds, [batch, width]),
                attention_mask: new ort.Tensor('int64', mask, [batch, width]),
                token_type_ids: new ort.Tensor('int64', types, [batch, width]),
            })
            const hidden = output.last_hidden_state
            const dims = hidden.dims[2]
            // Mean pooling over the real tokens, then unit length: the sentence-transformers
            // recipe this model was trained under.
            return encoded.map((ids, row) => {
                const vector = new Float32Array(dims)
                for (let i = 0; i < ids.length; i++) {
                    const at = (row * width + i) * dims
                    for (let d = 0; d < dims; d++) vector[d] += hidden.data[at + d]
                }
                for (let d = 0; d < dims; d++) vector[d] /= ids.length
                return normalise(vector)
            })
        },
        dispose: () => session.release(),
    }
}
