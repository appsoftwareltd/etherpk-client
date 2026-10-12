/**
 * The interactive fence contract: a [[Contribution Point]] for a widget that LIVES in the
 * document over one kind of fenced block, takes input of its own, and changes the text behind
 * it. The [[Map Block]] is the first (ADR 0118).
 *
 * The Augmentation renderer contract (`renderers/contract.ts`, ADR 0022) cannot carry one: a
 * renderer turns source into inert DOM that the host clones. An interactive fence's widget is live:
 * it stays mounted across edits, takes clicks and keys of its own, and its edits go through the
 * editor as ordinary undoable changes. Like a rendered fence, it shows its text while the caret
 * touches it. Everything that knows the editor stays in the host (`interactive-fence.ts`): where
 * the fence is, its indentation, the guards, undo. The contributed widget only sees the body's
 * lines and asks for line changes.
 *
 * Registered under the `interactive-fence` contribution kind with the fence's info word as its
 * id. With nothing registered for a word, the fence is an ordinary fenced block.
 */

import type { FencePresentation, PublishedFence, PublishFenceRequest } from '@appsoftwareltd/etherpk-extension-api'
import { StateEffect } from '@codemirror/state'

import { type ContributionRegistry, tryGetActiveContributionRegistry } from '$lib/surface'

import type { FenceBodyEdit } from '../../fence-body'

export const INTERACTIVE_FENCE_KIND = 'interactive-fence'

// Whether an info word names an [[Extension Fence]] (ADR 0138), which the editor draws whether or
// not its extension runs: decided in one framework-free place that every reader shares.
export { isExtensionFenceInfo } from '../../extension-fence'

/** What a widget is told about its fence. */
export interface InteractiveFenceInfo {
    /** The fence's info word, the one it was registered for. */
    readonly info: string
    /** The fence's body: its lines between the fences, less the indentation up to its column. */
    readonly body: readonly string[]
    /** The document the fence is in (its concept), or null in an editor outside a workspace. */
    readonly document: string | null
    /**
     * How many fences with this info word come before this one in the document. It changes when
     * one is added or removed above it, so it keys only what lasts a moment, such as which new
     * widget takes the keyboard. Nothing is written into the document to name a fence.
     */
    readonly ordinal: number
}

/** What a mounted widget can see and ask of the editor. */
export interface InteractiveFenceContext extends InteractiveFenceInfo {
    /** Whether the document accepts changes from the widget now (not read-only, not locked). */
    readonly writable: boolean
    /** The app theme the widget should draw in. */
    readonly dark: boolean
    /**
     * Whether anyone can see the editor: false while its tab is behind another, its Pane is
     * collapsed or the browser tab is hidden (editor-on-screen.ts). A widget holding something
     * costly while drawn, such as a map's WebGL context, lets it go while this is false. A widget
     * scrolled out of the editor's sight is still on screen by this: it watches that itself.
     * It changes while the widget is mounted (an `update`), and on the desktop an editor starts
     * off screen until its pane is first measured, so a widget reads it at each update, never once.
     */
    readonly onScreen: boolean
    /** Where the widget is drawn: in the document, or by the Client in a tab or over the window. */
    readonly presentation: FencePresentation
    /**
     * Change the body, as one undoable editor change: one line, or several lines applied in order
     * together, in this widget's own fence even when asked after the widget was taken down. False when
     * it was refused, and then nothing changed: the document cannot be written, the fence is gone, a
     * line no longer says what a change expects (the widget is told the current body in an `update`
     * soon after), or a guard kept the text as it was.
     */
    edit(change: FenceBodyEdit | readonly FenceBodyEdit[]): boolean
    /** Show the fence's text in the editor, with the caret on its first body line. */
    editAsText(): void
    /**
     * Delete the fence, as one undoable change the editor's own undo brings back: its lines with the
     * line break after them, or for a fence opened on a bullet's line the fence alone, leaving the
     * bullet empty. The caret goes where the fence was, or beside the fence that slides into its place,
     * which a caret there would show as text. False when the document cannot be written or a guard
     * kept the text as it was, and then nothing was deleted.
     */
    remove(): boolean
    /** The widget's height changed (it folded or unfolded): the editor measures it again. */
    resized(): void
    /** True once, for the widget of a fence put in to take the keyboard (`insertBlock` with `focus`). */
    takeFocus(): boolean
    /** Open the fence in a tab of its own (`fence-hosting.ts`), where its registration can `identify` it. */
    openInTab(): void
    /** Draw the widget again over the whole window, where its registration can `identify` the fence. */
    openWindow(): void
    /** Close the window this widget fills; nothing for a widget drawn elsewhere. */
    closeWindow(): void
}

/** A mounted widget, as the host drives it. */
export interface InteractiveFenceView {
    /** The fence's body, the theme or whether it can be written changed: show the new state. */
    update(context: InteractiveFenceContext): void
    /** The widget leaves the document (scrolled far away, the fence deleted, the editor closed). */
    destroy(): void
}

/** What an extension registers for one info word. */
export interface InteractiveFence {
    /**
     * The widget's height in CSS pixels, before and after it mounts. The host reserves it so the
     * lines below never move while the widget loads, and measures again on `resized`.
     */
    height(info: InteractiveFenceInfo): number
    /** Build the widget inside `host`, which the editor owns and positions. */
    mount(host: HTMLElement, context: InteractiveFenceContext): InteractiveFenceView
    /** What the fence holds, such as "Drawing": a tab's title and a window's heading start with it. */
    readonly title?: string
    /** Mod+Z and Mod+Y pressed inside the widget are its own, not the editor's undo and redo. */
    readonly keepsHistory?: boolean
    /** The fence's own id, read from its body, so a tab or a window can find it again after any change. */
    identify?(body: readonly string[]): string | null
    /**
     * What plain text pasted on an empty line or bullet becomes: this kind of fence's body lines, or
     * null (`paste-to-fence.ts`). The first [[Hook]]: its answer changes what a paste writes.
     */
    fromPaste?(text: string): readonly string[] | null
    /** How a published site shows the fence, asked only in a publish run in the browser. */
    publish?(fence: PublishFenceRequest): PublishedFence | null | Promise<PublishedFence | null>
}

/**
 * Dispatched to an open editor when a widget for an info word is registered or withdrawn, as an
 * extension that draws one starts or stops (ADR 0121): which fences are drawn as a widget changed
 * without an edit, so everything that read them reads them again (interactive-fence.ts).
 */
export const fenceRegistrationsChanged = StateEffect.define<null>()

export function registerInteractiveFence(registry: ContributionRegistry, info: string, fence: InteractiveFence): () => void {
    return registry.register(INTERACTIVE_FENCE_KIND, info, fence)
}

/** The widget registered for an info word, or undefined, including when no registry is active. */
export function lookupInteractiveFence(info: string): InteractiveFence | undefined {
    const registry = tryGetActiveContributionRegistry()
    if (!registry || !info) return undefined
    return (registry.get(INTERACTIVE_FENCE_KIND, info) as InteractiveFence | undefined) ?? undefined
}
