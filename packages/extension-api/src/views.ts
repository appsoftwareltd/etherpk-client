/**
 * The contract an extension's View follows (ADR 0121): a function that draws into an element the
 * Client gives it, tied to no framework, so no Svelte or React version is ever part of the API.
 */

/**
 * Which View: its kind and what it is about. A View with no subject has an empty target.
 *
 * @beta
 */
export interface ViewRef {
    /** The View kind, `<extension id>.<name>` for an extension's. */
    kind: string
    /** What the View is about: a concept's name for a board or a map, empty for a View with none. */
    target: string
}

/**
 * Whether a View can be seen: its tab in front, its Pane given room, and the browser tab showing.
 * The desktop keeps every tab mounted, so a View that does work while shown (drawing, reading the
 * index) stops it while this is false.
 *
 * @beta
 */
export interface ViewVisibility {
    /** True while the View can be seen. */
    readonly onScreen: boolean
    /** Called with each new value of `onScreen`, never with a repeat. Returns the unsubscribe. */
    subscribe(listener: (onScreen: boolean) => void): () => void
}

/**
 * What a View is mounted with.
 *
 * @beta
 */
export interface ViewMountProps {
    /** The View being mounted. */
    view: ViewRef
    /**
     * The id of the panel the View is open in, on a desktop: what a Layout call names to open
     * something in the same Pane or beside it. A phone passes none.
     */
    panelId?: string
    /** Whether the View can be seen right now, and when that changes. */
    visibility: ViewVisibility
}

/**
 * A View the extension has drawn, as the Client drives it.
 *
 * @beta
 */
export interface MountedView {
    /** The same View with new props: a rename re-keyed its target, or it moved to another Pane. */
    update?(props: ViewMountProps): void
    /** The tab closed, the graph closed, or the extension was switched off. */
    destroy(): void
}

/**
 * What an extension registers for a View kind its manifest declares.
 *
 * @beta
 */
export interface ViewContribution {
    /**
     * Draw the View into `element`, which is empty and is the extension's alone. For a loaded
     * extension it sits inside a shadow root that holds the extension's own stylesheets, so its CSS
     * reaches nothing outside, and nothing of the Client's reaches in but the `--gk-*` tokens and
     * inherited text styles.
     */
    mount(element: HTMLElement, props: ViewMountProps): MountedView
}
