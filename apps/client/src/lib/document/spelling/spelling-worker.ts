/**
 * The spelling worker: Hunspell (WebAssembly) for each loaded language, answering the spell
 * service's requests (`spelling-worker-client.ts`).
 *
 * The Emscripten glue is imported directly and handed the `.wasm` URL through `locateFile`.
 * Left to itself it finds the file with `new URL('hunspell.wasm', import.meta.url)`, which
 * Vite's dependency pre-bundling breaks (the package is also excluded from it in
 * vite.config.ts); the `?url` import makes the file a hashed asset of the Client build, served
 * from the Client's own origin like the SQLite build.
 */

import { Hunspell } from 'hunspell-wasm'
import createHunspellModule from 'hunspell-wasm/wasm/hunspell.js'
import wasmUrl from 'hunspell-wasm/wasm/hunspell.wasm?url'

import { SpellEngine } from './engine'
import type { SpellingRequest, SpellingResponse } from './spelling-worker-client'

let module: Promise<unknown> | null = null
const loadModule = () =>
    (module ??= (createHunspellModule as unknown as (options: { locateFile: () => string }) => Promise<unknown>)({
        locateFile: () => wasmUrl,
    }))

const engine = new SpellEngine(async (aff, dic) => new Hunspell(await loadModule(), aff, dic))

const reply = (message: SpellingResponse) => (self as unknown as Worker).postMessage(message)

self.onmessage = async (event: MessageEvent<SpellingRequest>) => {
    const message = event.data
    switch (message.type) {
        case 'unload':
            engine.unload(message.tag)
            return
        case 'words':
            engine.setWords(message.words)
            return
    }
    try {
        switch (message.type) {
            case 'load':
                await engine.load(message.tag, message.aff, message.dic)
                reply({ id: message.id, ok: true })
                return
            case 'check':
                reply({ id: message.id, ok: true, result: engine.check(message.words) })
                return
            case 'suggest':
                reply({ id: message.id, ok: true, result: engine.suggest(message.word, message.limit) })
                return
        }
    } catch (err) {
        reply({ id: message.id, ok: false, error: (err as Error).message ?? String(err) })
    }
}
