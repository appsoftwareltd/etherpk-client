<script lang="ts" module>
    /**
     * The label the tab's title opens with, ahead of the document it shows. Registered as the
     * kind's `titlePrefix` too, so the tab's width cap grows by it and the document's name keeps
     * a document tab's room.
     */
    export const BACKLINKS_TITLE_PREFIX = "Backlinks: ";
</script>

<script lang="ts">
    /**
     * The `backlinks` View: **Backlinks** (Logseq's Linked References) for the document the
     * user is currently in. Follows the active document (active-document.ts) rather
     * than its own ViewRef target. The list itself is `BacklinksList`, and what it knows and when
     * it asks the index again is `backlinks-loader.ts`, both shared with the section beneath every
     * document (`DocumentBacklinks`, ADR 0135). What this View adds is choosing the concept: it
     * follows the editor, or holds the pin, or shows what Show Backlinks asked for. Mounted
     * through the dockview adapter, so it reads the active store/controller/index via their
     * module accessors (not Svelte context).
     *
     * Two controls in the header, both per graph (`backlinks-preferences.ts`):
     *
     * - **Highlight reference** dims everything in a quoted line except the link to this
     *   document. Off by default, because a reference reads best in the document's own colours;
     *   on, it is the quickest way to spot the link in a long block. Remembered, and shared with
     *   the section beneath every document.
     * - **Pin** holds the panel on the document it is showing now, so the editor can move on —
     *   to the documents this one is referenced from, typically — while the references stay put.
     *   Held for the graph session and survives the mobile drawer unmounting this View; a fresh
     *   session follows the editor again. A pinned document that is renamed stays pinned under
     *   its old name until it is unpinned, which is the honest thing to show rather than a guess.
     *
     * **Show Backlinks** on a wikilink or a tab (`commands/document-commands.ts`, ADR 0088) changes
     * what the panel shows and leaves the pin as it is: pinned, the pin moves; following, the
     * concept asked for stands in for the editor's document until the editor moves on, captioned
     * "Showing X" meanwhile. The store holds that policy and is subscribed to rather than read
     * once at mount, because it changes from outside this View.
     */
    import { onDestroy, onMount, untrack } from "svelte";

    import { viewKey, type ViewRef, type ViewVisibility } from "$lib/layout";
    import { tryGetActiveEventBus } from "$lib/surface";
    import { iconSvg } from "$lib/surface/icons";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { getActiveDocument } from "../active-document";
    import { type BacklinksState, createBacklinksLoader, getActiveGraphIndex, linksToConcept } from "../backlinks";
    import type { BacklinksPreferences, ShownConcept } from "../backlinks-preferences";
    import BacklinksList from "./BacklinksList.svelte";
    import HighlightReferenceSwitch from "./HighlightReferenceSwitch.svelte";

    // The ViewRef's target is ignored — the panel follows the active document, not a fixed
    // one. `panelId` is supplied by the dockview presenter; the mobile presenter has no tabs to
    // retitle and passes none, so the view key stands in and the retitle is a no-op there.
    // `visibility` says whether the panel is on screen: behind the Tasks tab or in a collapsed
    // Sidebar it asks the index nothing (backlinks-loader.ts).
    let { view, panelId, visibility: visibilityProp }: { view: ViewRef; panelId?: string; visibility?: ViewVisibility } = $props();

    /** Fixed for the View's life: a presenter hands a View one visibility object. */
    const visibility = untrack(() => visibilityProp);

    // Absent outside a graph workspace (the /dev harnesses), where both controls simply default.
    const preferences = workspaceService("backlinksPreferences");

    // The document in front of the main region. The bus has no replay, so it is read now (this
    // View may be created after the front tab was named), followed from onMount on, and read
    // again there (see onMount for the gap between the two).
    let active = $state<string | null>(getActiveDocument());
    /** The document the panel is held on, or null while it follows the editor. */
    let pinned = $state<string | null>(preferences?.get().pinned ?? null);
    /** What Show Backlinks asked for while following; stands in for `active` until the editor moves on. */
    let shown = $state<ShownConcept | null>(preferences?.get().shown ?? null);
    /** Whose references are shown. */
    const concept = $derived(pinned ?? shown?.concept ?? active);
    let highlight = $state(preferences?.get().highlight ?? false);

    const index = getActiveGraphIndex();
    const loader = createBacklinksLoader({
        index,
        onScreen: visibility?.onScreen ?? true,
        onChange: (next) => (backlinks = next),
    });
    let backlinks = $state.raw<BacklinksState>(loader.state());
    /** A link to the concept being viewed, by its name or an alias: emphasised while highlighting. */
    const matches = $derived(concept === null ? () => false : linksToConcept(concept, index?.candidate));

    // Asked again whenever what is shown changes, whichever way it changed: the pin, what Show
    // Backlinks asked for, or the editor moving on. An index update is the loader's to hear.
    $effect(() => loader.show(concept));
    // On screen and off: the loader asks for what it missed when the panel comes back.
    $effect(() => visibility?.subscribe((onScreen) => loader.setOnScreen(onScreen)));

    /** The store's state, whoever wrote it: this View's controls, or Show Backlinks from outside. */
    function apply(next: BacklinksPreferences) {
        highlight = next.highlight;
        pinned = next.pinned;
        shown = next.shown;
    }

    /** Through the store where there is one, which answers through the subscription; else directly (a harness). */
    function setPreferences(next: Partial<BacklinksPreferences>) {
        if (preferences) preferences.set(next);
        else apply({ highlight, collapsedBelowDocuments: false, pinned, shown, ...next });
    }

    function setHighlight(on: boolean) {
        setPreferences({ highlight: on });
    }

    /** Pin what is showing now; unpinning snaps back to whatever the editor is on. */
    function togglePin() {
        if (pinned !== null) setPreferences({ pinned: null, shown: null });
        else if (concept !== null) setPreferences({ pinned: concept, shown: null });
    }

    // The tab is titled by what the panel SHOWS, which is not always the active document: pinned,
    // it stays on the pinned one. So the View owns its title (as the asset View does) rather than
    // the workspace retitling it on every active-document change. Runs on mount too, which covers
    // a layout restored with a document already active before this panel existed.
    $effect(() => {
        const title = concept ? `${BACKLINKS_TITLE_PREFIX}${concept}` : "Backlinks";
        workspaceService("retitleView")?.(panelId ?? viewKey(view), title);
    });

    let unsubActive: (() => void) | undefined;
    let unsubPreferences: (() => void) | undefined;
    onMount(() => {
        // Only `active` is kept here. Whether the editor moving on drops what Show Backlinks
        // asked for is the store's call (the workspace tells it), so a phone's closed drawer,
        // with this View unmounted, reaches the same answer.
        unsubActive = tryGetActiveEventBus()?.on("document:active-changed", ({ documentId }) => {
            active = documentId;
        });
        // Read again now that the subscription is live. Svelte runs onMount after the component
        // is created, not during it, and a restored layout (a reload) announces its document tab
        // in between: dockview creates this panel, then activates the tab. The bus has no replay,
        // so that announcement reached nobody, and the panel sat idle beside an open document.
        active = getActiveDocument();
        // The store replays its state on subscribe; that first call repeats the seeds above.
        unsubPreferences = preferences?.subscribe(apply);
    });
    onDestroy(() => {
        unsubActive?.();
        unsubPreferences?.();
        loader.destroy();
    });
</script>

<div
    class="backlinks"
    aria-busy={backlinks.status === "loading"}
    data-testid="backlinks-view"
    data-highlight={highlight}
    data-pinned={pinned ?? undefined}
>
    <header>
        <h3>Backlinks</h3>
        {#if backlinks.status === "ready"}<span class="count" data-testid="backlinks-count">{backlinks.count}</span>{/if}
        <div class="controls">
            <HighlightReferenceSwitch on={highlight} onchange={setHighlight} />
            <!-- Disabled only while there is nothing to pin; the idle hint below says why. -->
            <button
                type="button"
                class="pin"
                class:pin--on={pinned !== null}
                aria-pressed={pinned !== null}
                aria-label={pinned !== null ? `Unpin from ${pinned}` : concept ? `Pin to ${concept}` : "Pin"}
                title={pinned !== null
                    ? `Pinned to ${pinned} - click to follow the editor again`
                    : "Keep showing this document's backlinks while you open others"}
                data-testid="backlinks-pin"
                disabled={concept === null}
                onclick={togglePin}
            >
                <!-- In-repo constant markup from the icon table, never document content. -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                {@html iconSvg("pin", { size: 18 })}
            </button>
        </div>
    </header>
    {#if pinned !== null}
        <p class="caption" data-testid="backlinks-pinned">Pinned to <strong>{pinned}</strong></p>
    {:else if shown !== null}
        <!-- Not the editor's document, and not held either: what Show Backlinks asked for, until the
             editor moves on. Said here because a phone's drawer tab is not retitled. -->
        <p class="caption" data-testid="backlinks-shown">Showing <strong>{shown.concept}</strong></p>
    {/if}

    {#if !concept}
        <p class="hint" data-testid="backlinks-idle">Open a document to see what links to it.</p>
    {:else if backlinks.status === "loading"}
        <!-- Shown a moment after the fetch starts, so an answer that comes straight back never
             flashes it (the style below delays it). -->
        <p class="loading" data-testid="backlinks-loading">
            <span class="loading__spinner" aria-hidden="true"></span>
            Loading backlinks to <strong>{concept}</strong>…
        </p>
    {:else if backlinks.status === "failed"}
        <p class="hint hint--error" data-testid="backlinks-error">
            Could not load the backlinks to <strong>{concept}</strong>: the graph's index did not answer.
            <button type="button" class="retry" onclick={() => loader.retry()}>Try again</button>
        </p>
    {:else if backlinks.status === "ready" && backlinks.groups.length === 0}
        <p class="hint" data-testid="backlinks-empty">
            No backlinks to <strong>{concept}</strong> yet.
        </p>
    {:else if backlinks.status === "ready"}
        <BacklinksList groups={backlinks.groups} {highlight} {matches} />
    {/if}
</div>

<style>
    .backlinks {
        height: 100%;
        overflow: auto;
        padding: 0.6rem 0.75rem;
        /* Both desktop columns and mobile drawers mount this same View, so the
           root-level editor preference keeps their primary text in step. */
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: var(--editor-font-size, 1rem);
        line-height: 1.5;
        color: var(--gk-text-default);
    }
    header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.5rem;
    }
    /* 0.875rem (text-sm) is the floor for anything read, and the size the Tasks header uses. */
    h3 {
        margin: 0;
        font-size: 0.875rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--gk-text-muted);
    }
    .count {
        min-width: 1.4rem;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.15));
        font-size: 0.875rem;
        font-weight: 600;
        text-align: center;
    }
    /* The two controls, right-aligned; on a narrow drawer they wrap under the title as a row. */
    .controls {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-left: auto;
    }
    .pin {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--gk-text-muted, currentColor);
        cursor: pointer;
        line-height: 0;
    }
    /* Hover styling only where hover exists: a tapped button on a touch screen keeps `:hover`
       until the next tap elsewhere, and a hover colour that outranked the pinned state left the
       icon grey until the drawer was reopened. */
    @media (hover: hover) {
        .pin:hover:not(:disabled) {
            background: rgba(127, 127, 127, 0.22);
            color: var(--gk-text-default, currentColor);
        }
    }
    .pin:disabled {
        opacity: 0.4;
        cursor: default;
    }
    /* A finger needs a 44 CSS px target: on a touch screen the pin grows to it. */
    @media (pointer: coarse) {
        .pin {
            min-width: 2.75rem;
            min-height: 2.75rem;
        }
    }
    /* Pinned: the accent, and a tint that stays without hover, so the state is legible at rest.
       Declared after the hover rule and repeated with it, so the state wins under the pointer too. */
    .pin--on,
    .pin--on:hover {
        color: var(--gk-accent, #2563eb);
        background: color-mix(in srgb, var(--gk-accent, #2563eb) 14%, transparent);
    }
    .pin:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* "Pinned to X" / "Showing X", under the header. */
    .caption {
        margin: -0.2rem 0 0.5rem;
        font-size: 0.875rem;
        color: var(--gk-text-muted);
    }
    .hint {
        margin: 0;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
    }
    /* Not dimmed like the other hints: this one asks for something. */
    .hint--error {
        opacity: 1;
        color: var(--gk-text-muted);
    }
    .retry {
        margin-left: 0.25rem;
        padding: 0;
        border: 0;
        background: transparent;
        color: var(--gk-accent, #2563eb);
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
    }
    .retry:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 1px;
    }
    /* Loading: a quiet ring and a line of text, faded in only once the wait is worth explaining
       (the reference image's placeholder waits the same way, AssetImage.svelte). */
    .loading {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        opacity: 0;
        animation: backlinks-appear 150ms ease-out 200ms forwards;
    }
    .loading__spinner {
        flex: none;
        width: 1em;
        height: 1em;
        box-sizing: border-box;
        border: 2px solid rgba(127, 127, 127, 0.25);
        border-top-color: rgba(127, 127, 127, 0.8);
        border-radius: 50%;
        animation: backlinks-spin 0.9s linear infinite;
    }
    @keyframes backlinks-appear {
        to {
            opacity: 1;
        }
    }
    @keyframes backlinks-spin {
        to {
            transform: rotate(360deg);
        }
    }
    /* Rotation is the motion the preference suppresses; a slow pulse still says "busy". */
    @media (prefers-reduced-motion: reduce) {
        .loading__spinner {
            animation: backlinks-pulse 1.6s ease-in-out infinite;
        }
    }
    @keyframes backlinks-pulse {
        50% {
            opacity: 0.3;
        }
    }
</style>
