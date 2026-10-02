/**
 * The Chromium the publish and theme tests draw with, and a warm-up that keeps its first launch out
 * of any test's time. Test support only: nothing in the package imports it.
 */

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

import { openDiagramRenderer } from './diagrams'

/**
 * A Chromium on this machine: the one `ETHERPK_CHROMIUM` or `PLAYWRIGHT_CHROMIUM_EXECUTABLE` names,
 * else the first `chromium`, `chromium-browser` or `google-chrome` on the path, or null.
 */
export function chromiumOnThisMachine(): string | null {
    const named = process.env.ETHERPK_CHROMIUM?.trim() || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim()
    if (named && existsSync(named)) return named
    try {
        const found = execSync('command -v chromium || command -v chromium-browser || command -v google-chrome', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return found && existsSync(found) ? found : null
    } catch {
        return null
    }
}

/** How long the warm-up may take: a first launch on a busy machine, not a render. */
export const WARM_UP_TIMEOUT = 180_000

/**
 * Launch the browser once and draw one diagram, for a `beforeAll` with {@link WARM_UP_TIMEOUT}.
 *
 * A browser's first launch on a machine reads its binary and libraries from a cold disk, and the
 * first Mermaid bundle it loads is parsed cold too. On a CI runner whose cores other test suites
 * share, that first launch has taken from 12 seconds to past the 60 a test allows, where every
 * launch after it takes about two. Done here, a slow first launch is not read as a hung render,
 * and a test that does hang still fails on its own time.
 */
export async function warmChromium(chromium: string | null): Promise<void> {
    if (!chromium) return
    const renderer = await openDiagramRenderer({ ...process.env, ETHERPK_CHROMIUM: chromium })
    if (!renderer) return
    try {
        await renderer.render('flowchart LR\n  A --> B')
    } finally {
        await renderer.dispose()
    }
}
