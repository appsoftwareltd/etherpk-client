import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { MODEL, RUNTIME, SemanticUnavailable, loadEmbeddingModel, removeSemantic, semanticPaths, semanticSetupPresent, semanticSetupStatus, setupSemantic, whenSemanticSetUp, type ModelFile } from './embedder'

/**
 * `semantic setup` without a network or an npm: the runtime install is a fake that writes the
 * package's manifest where npm would, and the model files come from a fake fetch whose bytes
 * hash to what the test's own file list pins. What is protected: both halves are fetched into
 * the cache directory, each file is verified by hash and a bad one is never kept, a second
 * run does nothing, and `serve` refuses in words when nothing is set up.
 */

const dirs: string[] = []
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function cacheRoot(): Promise<{ env: NodeJS.ProcessEnv; root: string }> {
    const root = await mkdtemp(join(tmpdir(), 'etherpk-mcp-semantic-'))
    dirs.push(root)
    return { env: { ETHERPK_MCP_CACHE_DIR: root } as NodeJS.ProcessEnv, root }
}

function pinned(name: string, content: string): ModelFile & { content: string } {
    return { name, url: `https://models.example/${name}`, sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length, content }
}

function fakes(files: Array<ModelFile & { content: string }>, tamper?: string) {
    const fetched: string[] = []
    const installs: string[][] = []
    const fetch = async (url: string | URL | Request) => {
        const wanted = files.find((f) => f.url === String(url))
        fetched.push(String(url))
        if (!wanted) return new Response(null, { status: 404 })
        return new Response(wanted.name === tamper ? `${wanted.content}!` : wanted.content, { status: 200 })
    }
    const npmInstall = async (args: string[], cwd: string) => {
        installs.push(args)
        const dir = join(cwd, 'node_modules', RUNTIME.name)
        await writeFile(join(dir, 'package.json'), '{}').catch(async () => {
            const { mkdir } = await import('node:fs/promises')
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, 'package.json'), '{}')
        })
    }
    return { fetched, installs, fetch: fetch as typeof globalThis.fetch, npmInstall }
}

describe('semantic setup', () => {
    it('keeps the runtime and the model under the cache root', async () => {
        const paths = semanticPaths({ ETHERPK_MCP_CACHE_DIR: '/x' } as NodeJS.ProcessEnv)
        expect(paths.runtimeDir).toBe('/x/runtime')
        expect(paths.modelDir).toBe(`/x/models/${MODEL.id}`)
    })

    it('installs the runtime and downloads each file once, verified by hash', async () => {
        const { env } = await cacheRoot()
        const files = [pinned('model.onnx', 'onnx-bytes'), pinned('tokenizer.json', '{"t":1}'), pinned('tokenizer_config.json', '{}')]
        const io = fakes(files)
        const said: string[] = []
        expect(await semanticSetupStatus(env, files)).toMatchObject({ runtime: false, model: false })

        const status = await setupSemantic({ env, say: (line) => said.push(line), files, ...io })
        expect(status).toMatchObject({ runtime: true, model: true })
        expect(io.installs).toHaveLength(1)
        expect(io.installs[0]).toContain(`${RUNTIME.name}@${RUNTIME.version}`)
        expect(io.installs[0]).toContain('--ignore-scripts')
        expect(io.fetched).toHaveLength(3)
        expect(await readFile(join(status.modelDir, 'model.onnx'), 'utf8')).toBe('onnx-bytes')
        expect(await readdir(status.modelDir)).not.toContainEqual(expect.stringMatching(/\.tmp$/))

        // Idempotent: nothing is fetched or installed again, and the report says so.
        await setupSemantic({ env, say: (line) => said.push(line), files, ...io })
        expect(io.installs).toHaveLength(1)
        expect(io.fetched).toHaveLength(3)
        expect(said.filter((line) => line.startsWith('Model file present'))).toHaveLength(3)

        await removeSemantic(env)
        expect(await semanticSetupStatus(env, files)).toMatchObject({ runtime: false, model: false })
    })

    it('refuses a file whose bytes do not hash as pinned, keeping nothing of it', async () => {
        const { env } = await cacheRoot()
        const files = [pinned('model.onnx', 'onnx-bytes'), pinned('tokenizer.json', '{}'), pinned('tokenizer_config.json', '{}')]
        const io = fakes(files, 'model.onnx')
        await expect(setupSemantic({ env, say: () => {}, files, ...io })).rejects.toThrow(/sha256/)
        const status = await semanticSetupStatus(env, files)
        expect(status.model).toBe(false)
        expect(await readdir(status.modelDir).catch(() => [])).toEqual([])
    })

    it('notices setup appearing under a running serve, once, and never keeps the process alive', async () => {
        const { env } = await cacheRoot()
        const files = [pinned('model.onnx', 'onnx-bytes'), pinned('tokenizer.json', '{}'), pinned('tokenizer_config.json', '{}')]
        const io = fakes(files)
        let readied = 0
        const stop = whenSemanticSetUp(env, () => readied++, 15, files)
        await new Promise((r) => setTimeout(r, 60))
        expect(readied).toBe(0)
        expect(await semanticSetupPresent(env, files)).toBe(false)
        await setupSemantic({ env, say: () => {}, files, ...io })
        expect(await semanticSetupPresent(env, files)).toBe(true)
        await new Promise((r) => setTimeout(r, 120))
        expect(readied).toBe(1)
        stop()
    })

    it('tells serve, in words that name the command, when nothing is set up here', async () => {
        const { env } = await cacheRoot()
        await expect(loadEmbeddingModel(env)).rejects.toBeInstanceOf(SemanticUnavailable)
        await expect(loadEmbeddingModel(env)).rejects.toThrow(/semantic setup/)
    })
})
