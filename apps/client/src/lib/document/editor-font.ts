/**
 * The editor font-size preference — a per-device presentation setting (like [[Layout]], never
 * synced; localStorage, not a cookie, because it is purely client-side and never needed at
 * SSR). It is applied as the `--editor-font-size` CSS custom property on the document root, for
 * everything sized off it, and each open editor takes it as its own font-size theme when told
 * ({@link onEditorFontSizeChange}). Adjusted by the Command Bar zoom buttons and by Ctrl+wheel
 * over an editor.
 */

const STORAGE_KEY = 'etherpk:editor-font-size'
const CSS_VAR = '--editor-font-size'

export const DEFAULT_FONT_SIZE = 16
export const MIN_FONT_SIZE = 11
export const MAX_FONT_SIZE = 28
/** Pixels per zoom step. */
const STEP = 1

/** Clamp to the supported range, rounding to whole px; a non-finite value ⇒ the default. */
export function clampFontSize(px: number): number {
    if (!Number.isFinite(px)) return DEFAULT_FONT_SIZE
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px)))
}

let current = DEFAULT_FONT_SIZE
let initialised = false
const listeners = new Set<() => void>()

function apply(): void {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty(CSS_VAR, `${current}px`)
    for (const listener of listeners) listener()
}

/**
 * Be told each time the size is applied. CodeMirror does not notice a font change on its own: it
 * re-measures when its scroller resizes, which a zoom never does, so its line heights, and
 * everything the augmentations measure off the text, would stay those of the old size. Each editor
 * subscribes and swaps its font-size theme, which CodeMirror does re-measure for (cm-document.ts).
 * Returns the unsubscribe.
 */
export function onEditorFontSizeChange(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

/**
 * Read the stored size and apply it. Idempotent — safe to call from every editor or Command
 * Bar mount, so the preference is live whichever surface appears first.
 */
export function initEditorFont(): void {
    if (initialised || typeof window === 'undefined') return
    initialised = true
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? NaN : Number(raw)
    current = Number.isFinite(parsed) && parsed > 0 ? clampFontSize(parsed) : DEFAULT_FONT_SIZE
    apply()
}

export function getEditorFontSize(): number {
    return current
}

export function setEditorFontSize(px: number): void {
    current = clampFontSize(px)
    apply()
    try {
        localStorage.setItem(STORAGE_KEY, String(current))
    } catch {
        // Private mode / quota exceeded — the in-memory value still applies this session.
    }
}

/** Step the size by `steps` zoom increments (positive = larger). */
export function zoomEditorFont(steps: number): void {
    setEditorFontSize(current + steps * STEP)
}
