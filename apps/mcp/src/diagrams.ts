/**
 * Mermaid for a publish from the Headless Client (ADR 0084): a real Chromium, because a
 * [[Published Site]] carries no Mermaid runtime and Mermaid needs a layout engine to measure
 * text, and never the text fallback, because nobody reads a warning from an unattended publish.
 *
 * Which browser: `ETHERPK_CHROMIUM=<path>` names a system one (NixOS needs this - the managed
 * build fails there on `libgbm`); otherwise the one `etherpk-mcp diagrams setup` downloaded under
 * the cache root with Playwright's own installer, pinned to the `playwright-core` version this
 * package depends on. The shape is `semantic setup`'s: an explicit command once per computer,
 * nothing fetched inside a tool call. The page loads the same `mermaid` package version the
 * Client bundles, so both hosts draw the same SVG, and the post-processing is the Client's
 * (`browser-environment.ts`): the minted id dropped (it collides across pages), `role="img"`.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { cacheRoot } from './persistence'

const require = createRequire(import.meta.url)

/** Where Playwright keeps the browsers this package installs: under our cache, not the user's global one. */
export function browsersDir(env: NodeJS.ProcessEnv): string {
    return join(cacheRoot(env), 'browsers')
}

async function playwright(env: NodeJS.ProcessEnv): Promise<typeof import('playwright-core')> {
    // The registry reads the variable when the module loads, so it is set before the import
    // and only when the person has not pointed it elsewhere themselves.
    if (!env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(env)
    return import('playwright-core')
}

export interface ChromiumStatus {
    /** The executable a publish would launch, or null when there is none. */
    executable: string | null
    /** Where it came from. */
    source: 'env' | 'managed' | 'none'
    /** The command that would provide one. */
    setupCommand: string
}

/** Whether a browser is available, and which. `cmd` is how this CLI is spelled for the user. */
export async function chromiumStatus(env: NodeJS.ProcessEnv, cmd = 'etherpk-mcp'): Promise<ChromiumStatus> {
    const setupCommand = `${cmd} diagrams setup`
    const named = env.ETHERPK_CHROMIUM?.trim()
    if (named) return { executable: existsSync(named) ? named : null, source: 'env', setupCommand }
    try {
        const { chromium } = await playwright(env)
        const path = chromium.executablePath()
        if (path && existsSync(path)) return { executable: path, source: 'managed', setupCommand }
    } catch {
        // No playwright-core, or no registry entry: nothing installed.
    }
    return { executable: null, source: 'none', setupCommand }
}

/**
 * Install the pinned Chromium under the cache root with Playwright's installer, the one that
 * knows the build this `playwright-core` drives. Prints the installer's own lines.
 */
export async function setupDiagrams(env: NodeJS.ProcessEnv, say: (line: string) => void): Promise<ChromiumStatus> {
    const before = await chromiumStatus(env)
    if (before.executable) {
        say(before.source === 'env' ? `Using the Chromium named by ETHERPK_CHROMIUM: ${before.executable}` : `Chromium is already installed: ${before.executable}`)
        return before
    }
    const cli = require.resolve('playwright-core/cli.js')
    const dir = env.PLAYWRIGHT_BROWSERS_PATH?.trim() || browsersDir(env)
    say(`Installing Chromium into ${dir} (about 170 MB, once per computer; a diagram is rendered by a browser, and this is the one etherpk-mcp drives)…`)
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'install', 'chromium'], {
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir },
            stdio: ['ignore', 'pipe', 'pipe'],
        })
        const relay = (chunk: Buffer) => {
            for (const line of chunk.toString().split(/\r?\n/)) if (line.trim() !== '') say(line)
        }
        child.stdout.on('data', relay)
        child.stderr.on('data', relay)
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Playwright's installer exited with code ${code}.`))))
    })
    const after = await chromiumStatus(env)
    if (!after.executable) throw new Error('The installer finished but no Chromium executable was found; set ETHERPK_CHROMIUM to a browser on this machine instead.')
    say(`Chromium is set up: ${after.executable}`)
    return after
}

export interface DiagramRenderer {
    /** A Mermaid source to a standalone `<svg>` string; rejects with Mermaid's own message. */
    render(source: string): Promise<string>
    dispose(): Promise<void>
}

/** The page every render runs in: Mermaid loaded once, configured as the Client configures it. */
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'

/** A headless browser from whichever Chromium is available, or null. The caller closes it. */
export async function launchChromium(env: NodeJS.ProcessEnv): Promise<import('playwright-core').Browser | null> {
    const status = await chromiumStatus(env)
    if (!status.executable) return null
    const { chromium } = await playwright(env)
    return chromium.launch({ executablePath: status.executable, headless: true })
}

/**
 * A renderer over one headless browser, opened for a publish and closed after it. Null when no
 * browser is available; the caller decides what that means (a publish with diagrams refuses).
 */
export async function openDiagramRenderer(env: NodeJS.ProcessEnv): Promise<DiagramRenderer | null> {
    const browser = await launchChromium(env)
    if (!browser) return null
    let pagePromise: Promise<import('playwright-core').Page> | undefined
    const page = () => {
        if (!pagePromise) {
            pagePromise = (async () => {
                const context = await browser.newContext({ javaScriptEnabled: true })
                const p = await context.newPage()
                await p.setContent(PAGE)
                await p.addScriptTag({ path: require.resolve('mermaid/dist/mermaid.min.js') })
                await p.evaluate(() => {
                    const m = (window as unknown as { mermaid: { initialize(config: unknown): void } }).mermaid
                    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
                })
                return p
            })()
        }
        return pagePromise
    }
    let seq = 0
    return {
        async render(source) {
            const p = await page()
            const id = `gk-mermaid-${++seq}`
            return p.evaluate(
                async ([renderId, text]) => {
                    const m = (window as unknown as { mermaid: { render(id: string, text: string): Promise<{ svg: string }> } }).mermaid
                    try {
                        const { svg } = await m.render(renderId, text)
                        const doc = new DOMParser().parseFromString(svg, 'text/html')
                        const el = doc.querySelector('svg')
                        if (!el) throw new Error('Mermaid produced no diagram.')
                        // The id stays: Mermaid scopes its inline <style> to it, and the
                        // publisher renames it per page (diagram-id.ts).
                        el.setAttribute('role', 'img')
                        return el.outerHTML
                    } finally {
                        // Mermaid can leave an orphan error element in <body>; never let it accumulate.
                        document.getElementById(renderId)?.remove()
                        document.getElementById(`d${renderId}`)?.remove()
                    }
                },
                [id, source] as const,
            )
        },
        async dispose() {
            await browser.close().catch(() => {})
        },
    }
}
