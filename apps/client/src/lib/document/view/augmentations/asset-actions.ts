/**
 * The **action cluster** an [[Asset Reference]] carries **inside the editor**: trailing icons
 * after a link (`asset-link.ts`) and a hover overlay on a rendered image (`image-embed.ts`).
 *
 * Which actions those are is not decided here — `asset-affordances.ts` owns the list, because the
 * references [[View]] shows the same set with no CodeMirror anywhere near it — and neither is how
 * a cluster is drawn (`inline-actions.ts`, shared with the [[File Link]] cluster). What is here is
 * the part that genuinely needs an asset: turning an element into the reference it belongs to.
 *
 * That target is resolved **live from the DOM at click time** (`posAtDOM`), never from a position
 * baked in when the element was built: CodeMirror reuses widget and mark DOM across edits, so a
 * stored offset goes stale the moment text above it changes, and acting on it would delete the
 * wrong thing. Everything in the cluster is derived from where the element *is now*.
 */

import type { EditorView } from '@codemirror/view'

import { displayNameForRef } from '$lib/storage/fs/asset-store'
import { type AssetContextMenuTarget, openContextMenu } from '$lib/surface'

import { type AssetActionOptions, assetActions, runAssetCommand } from '../../asset-affordances'
import { allAssetReferences } from '../../asset-reference'
import { buildActionCluster } from './inline-actions'

/** How long a touch must be held, and how far it may drift, to raise the Context Menu. */
const LONG_PRESS_MS = 500
const LONG_PRESS_SLOP_PX = 10


/**
 * Where an element's reference sits right now: the line it occupies, and which occurrence of the
 * reference on that line it belongs to. `anchor` says how the element relates to its reference —
 * an image widget REPLACES the span and so starts where it starts, while the trailing icon
 * cluster sits immediately after it — which is the only way to tell two references on one line
 * apart.
 */
export function assetTargetAt(
    view: EditorView,
    el: HTMLElement,
    ref: string,
    anchor: 'start' | 'end',
): AssetContextMenuTarget | null {
    let pos: number
    try {
        pos = view.posAtDOM(el)
    } catch {
        return null
    }
    const line = view.state.doc.lineAt(pos)
    const spans = allAssetReferences(line.text, ref)
    if (spans.length === 0) return null
    const offset = Math.max(0, pos - line.from)
    const edge = (span: { from: number; to: number }) => (anchor === 'start' ? span.from : span.to)
    const exact = spans.findIndex((span) => edge(span) === offset)
    // An exact hit is the normal case. Otherwise take the nearest reference at or before the
    // element, which keeps a single-reference line right even if the offset drifts by a character.
    const occurrence =
        exact !== -1 ? exact : spans.reduce((best, span, i) => (edge(span) <= offset ? i : best), 0)
    return { kind: 'asset', ref, line: line.number, occurrence }
}

export interface AssetActionsOptions extends AssetActionOptions {
    /** Extra class on the container, for the surface's own styling. */
    className: string
    /** Icon size in px. */
    size?: number
}

/**
 * Build the cluster. `resolveTarget` is called per click so the target is always current; a
 * click that cannot resolve one does nothing rather than acting on a guess.
 *
 * The editor is focused first. `asset.delete` edits whichever editor is ACTIVE, and with two
 * documents open in split panes a click in the unfocused one would otherwise be applied to the
 * other — where the reference is almost certainly not on that line, so it would silently do
 * nothing. Focusing makes the editor you clicked in the one that is edited.
 */
export function buildAssetActions(
    view: EditorView,
    ref: string,
    resolveTarget: () => AssetContextMenuTarget | null,
    options: AssetActionsOptions,
): HTMLElement {
    const wrap = buildActionCluster(view, {
        className: options.className,
        buttonClass: 'cm-asset-action',
        actionAttr: 'data-asset-action',
        name: displayNameForRef(ref),
        actions: assetActions(ref, options),
        size: options.size ?? 14,
        resolveTarget,
        run: runAssetCommand,
    })
    wrap.setAttribute('data-asset-actions', ref)
    return wrap
}


/**
 * Raise the [[Context Menu]] on an asset: right-click anywhere, or a long press on touch, where
 * hover does not exist and the overlay never appears. Mirrors `attachContextMenu`, which cannot
 * be used directly here because the element it would bind to is rebuilt by CodeMirror on every
 * decoration change.
 */
export function attachAssetContextMenu(
    view: EditorView,
    el: HTMLElement,
    resolveTarget: () => AssetContextMenuTarget | null,
): void {
    const raise = (x: number, y: number) => {
        const target = resolveTarget()
        if (!target) return
        // Same reason as the buttons: the menu's Commands act on the ACTIVE editor.
        view.focus()
        openContextMenu(target, x, y)
    }

    el.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        raise(event.clientX, event.clientY)
    })

    let timer: ReturnType<typeof setTimeout> | undefined
    let start: { x: number; y: number } | null = null
    const clear = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        start = null
    }
    el.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'touch') return
        start = { x: event.clientX, y: event.clientY }
        timer = setTimeout(() => raise(start?.x ?? 0, start?.y ?? 0), LONG_PRESS_MS)
    })
    el.addEventListener('pointermove', (event) => {
        if (!start) return
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) clear()
    })
    el.addEventListener('pointerup', clear)
    el.addEventListener('pointercancel', clear)
}
