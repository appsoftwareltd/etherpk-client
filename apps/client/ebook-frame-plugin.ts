/**
 * Vite plugin: the page an EBook reads in (ADR 0181), as `virtual:etherpk-ebook-frame`, which its route
 * answers with. A host page holding a `data:` document, whose one script is foliate-js and the bridge.
 * Inline, because a document with an opaque origin can load nothing from this server and none of its
 * requests reach the service worker. The policy names that script by its hash, so nothing else can run.
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

import { ebookHostPolicy, ebookReaderPolicy } from './src/lib/document/ebook/ebook-frame-policy.ts'

const VIRTUAL_ID = 'virtual:etherpk-ebook-frame'
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const ENTRY = fileURLToPath(new URL('./src/lib/document/view/viewers/ebook/frame/main.ts', import.meta.url))

// The formats and features not in this build. foliate only imports each when asked to open one, and
// the first release opens EPUB through its own zip reader, so these stay out of the bundle.
const LEFT_OUT = /^\.\/(?:vendor\/.*|pdf\.js|mobi\.js|fb2\.js|comic-book\.js)$/

const LICENCES = '/*! foliate-js, MIT License, Copyright (c) 2022 John Factotum. fflate, MIT License, Copyright (c) 2023 Arjun Barrett. */'

async function bundle(): Promise<{ code: string; inputs: string[] }> {
    const result = await build({
        entryPoints: [ENTRY],
        bundle: true,
        format: 'iife',
        target: 'es2022',
        minify: true,
        write: false,
        metafile: true,
        legalComments: 'none',
        banner: { js: LICENCES },
        logLevel: 'silent',
        plugins: [
            {
                name: 'ebook-frame-left-out',
                setup(context) {
                    context.onResolve({ filter: LEFT_OUT }, (args) => ({ path: args.path, external: true }))
                },
            },
        ],
    })
    return { code: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) }
}

/** The page around the EBook, and the dialog for a footnote or a picture, which sit over it. */
const READER_STYLES = [
    'html,body{margin:0;height:100%;overflow:hidden}',
    'foliate-view{display:block;width:100%;height:100%}',
    'dialog{box-sizing:border-box;width:min(36rem,calc(100vw - 2rem));max-height:calc(100vh - 2rem);padding:.5rem;border:1px solid currentColor;border-radius:.75rem;background:var(--page,#fff);color:var(--text,#171717);font:16px system-ui,sans-serif}',
    'dialog::backdrop{background:rgba(0,0,0,.4)}',
    'dialog>button{display:block;margin:0 0 .5rem auto;padding:.5rem .75rem;border:1px solid currentColor;border-radius:.5rem;background:transparent;color:inherit;font:inherit}',
    'dialog>foliate-view{height:min(50vh,24rem)}',
    'dialog>img{display:block;max-width:100%;max-height:calc(100vh - 7rem);margin:0 auto}',
].join('')

/** The whole page and its policy, from the bundle. */
export function ebookFramePage(code: string): { html: string; contentSecurityPolicy: string } {
    const script = code.replace(/<\/script/gi, '<\\/script')
    const hash = createHash('sha256').update(script).digest('base64')
    const reader = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ebookReaderPolicy(hash).replaceAll('"', '&quot;')}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EBook</title><style>${READER_STYLES}</style></head><body><script>${script}</script></body></html>`
    const readerUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(reader, 'utf8').toString('base64')}`
    return {
        contentSecurityPolicy: ebookHostPolicy(hash),
        html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EBook</title><style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="EBook" src="${readerUrl}"></iframe></body></html>`,
    }
}

export function ebookFramePlugin(): Plugin {
    return {
        name: 'etherpk-ebook-frame',
        resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
        async load(id) {
            if (id !== RESOLVED_ID) return undefined
            const { code, inputs } = await bundle()
            for (const input of inputs) this.addWatchFile(input)
            const page = ebookFramePage(code)
            return `export const html = ${JSON.stringify(page.html)}\nexport const contentSecurityPolicy = ${JSON.stringify(page.contentSecurityPolicy)}\n`
        },
    }
}
