<script lang="ts">
    /**
     * The [[Backlink]]s beneath a document's text (ADR 0135): what links to the journal entry,
     * page or [[Draft]] in front of you, read only, without opening the Backlinks panel. Opening a
     * name that other notes link to shows those notes under its empty first line, so a Draft reads
     * as "what you know about this so far" rather than a blank page.
     *
     * The list is `BacklinksList` and the loading is `backlinks-loader.ts`, both shared with the
     * panel, so the two show the same references. Nothing is drawn until the first answer, and
     * nothing when there are none (the editor then looks exactly as it did before), so
     * `ondrawnchange` tells DocumentView when to make room for it. A failure is one line with
     * **Try again**.
     *
     * **Collapsed** is one setting for every document, per graph on this device
     * (`backlinks-preferences.ts`): a person who wants a clean editor sets it once. Collapsed, the
     * header line stays, with the count, so the references are still known to be there.
     *
     * DocumentView mounts this inside the editor's scroller, after its content, so it scrolls with
     * the text without being part of it: not in the editable text box, not in the height map.
     */
    import { onDestroy, onMount, untrack } from "svelte";

    import type { ViewVisibility } from "$lib/layout";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { type BacklinksState, createBacklinksLoader, getActiveGraphIndex, linksToConcept } from "../backlinks";
    import type { BacklinksPreferences } from "../backlinks-preferences";
    import BacklinksList from "./BacklinksList.svelte";
    import { CONTENT_PAD_X } from "./cm-document";
    import HighlightReferenceSwitch from "./HighlightReferenceSwitch.svelte";

    let {
        concept,
        visibility: visibilityProp,
        sourcePanelId,
        ondrawnchange,
    }: {
        /** The document's concept: whose backlinks these are. */
        concept: string;
        /** Whether the document's View is on screen; behind another tab nothing is fetched. */
        visibility?: ViewVisibility;
        /** The document's panel, so a reference opens in its Pane. */
        sourcePanelId?: string;
        /** Told when the section starts or stops being drawn. */
        ondrawnchange?: (drawn: boolean) => void;
    } = $props();

    /** Fixed for the View's life: a presenter hands a View one visibility object. */
    const visibility = untrack(() => visibilityProp);
    // Absent outside a graph workspace (the /dev harnesses), where both settings simply default.
    const preferences = workspaceService("backlinksPreferences");
    let highlight = $state(preferences?.get().highlight ?? false);
    let collapsed = $state(preferences?.get().collapsedBelowDocuments ?? false);

    const index = getActiveGraphIndex();
    /** Whether the section is drawn now, as last told to DocumentView. */
    let drawn = false;
    const loader = createBacklinksLoader({
        index,
        onScreen: visibility?.onScreen ?? true,
        onChange(next) {
            backlinks = next;
            const nowDrawn = (next.status === "ready" && next.count > 0) || next.status === "failed";
            if (nowDrawn === drawn) return;
            drawn = nowDrawn;
            ondrawnchange?.(nowDrawn);
        },
    });
    let backlinks = $state.raw<BacklinksState>(loader.state());
    /** A link to this document, by its name or an alias: emphasised while highlighting. */
    const matches = $derived(linksToConcept(concept, index?.candidate));
    const listId = $props.id();

    $effect(() => loader.show(concept));
    // On screen and off: the loader asks for what it missed when the tab comes back to the front.
    $effect(() => visibility?.subscribe((onScreen) => loader.setOnScreen(onScreen)));

    /** The store's state, whoever wrote it: this header, the panel's switch, or a Command. */
    function apply(next: BacklinksPreferences) {
        highlight = next.highlight;
        collapsed = next.collapsedBelowDocuments;
    }

    /** Through the store where there is one, which answers through the subscription; else directly (a harness). */
    function setPreferences(next: Partial<BacklinksPreferences>) {
        if (preferences) preferences.set(next);
        else apply({ highlight, collapsedBelowDocuments: collapsed, pinned: null, shown: null, ...next });
    }

    let unsubPreferences: (() => void) | undefined;
    onMount(() => {
        unsubPreferences = preferences?.subscribe(apply);
    });
    onDestroy(() => {
        unsubPreferences?.();
        loader.destroy();
    });
</script>

{#if backlinks.status === "failed"}
    <section
        class="document-backlinks"
        style:--content-pad-x={CONTENT_PAD_X}
        aria-label="Backlinks"
        data-testid="document-backlinks"
        data-document-backlinks
    >
        <p class="error" data-testid="document-backlinks-error">
            Could not load the backlinks: the graph's index did not answer.
            <button type="button" class="retry" onclick={() => loader.retry()}>Try again</button>
        </p>
    </section>
{:else if backlinks.status === "ready" && backlinks.count > 0}
    <section
        class="document-backlinks"
        style:--content-pad-x={CONTENT_PAD_X}
        aria-label="Backlinks"
        data-testid="document-backlinks"
        data-collapsed={collapsed}
        data-document-backlinks
    >
        <div class="header">
            <h2 class="title">
                <!-- The sidebar's disclosure: a chevron that turns when the list is open. -->
                <button
                    type="button"
                    class="toggle"
                    aria-expanded={!collapsed}
                    aria-controls={collapsed ? undefined : listId}
                    title={collapsed ? "Show the backlinks below every document" : "Hide the backlinks below every document"}
                    data-testid="document-backlinks-toggle"
                    data-document-backlinks-toggle
                    onclick={() => setPreferences({ collapsedBelowDocuments: !collapsed })}
                >
                    <span class="chevron" class:chevron--open={!collapsed} aria-hidden="true">›</span>
                    Backlinks
                    <span class="count" data-testid="document-backlinks-count">{backlinks.count}</span>
                </button>
            </h2>
            {#if !collapsed}
                <HighlightReferenceSwitch on={highlight} onchange={(on) => setPreferences({ highlight: on })} />
            {/if}
        </div>
        {#if !collapsed}
            <div id={listId} class="list">
                <BacklinksList groups={backlinks.groups} {highlight} {matches} {sourcePanelId} />
            </div>
        {/if}
    </section>
{/if}

<style>
    /* A row of its own in the editor's scroller, which CodeMirror lays out as a flex row and
       DocumentView wraps while this is drawn. In the text's column: the rule and everything under
       it line up with the text above (CONTENT_PAD_X), and the pointer is an arrow again. */
    .document-backlinks {
        flex: 0 0 calc(100% - 2 * var(--content-pad-x));
        min-width: 0;
        box-sizing: border-box;
        margin: 0 var(--content-pad-x);
        padding: 0.75rem 0 1.5rem;
        border-top: 1px solid var(--gk-border-soft);
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--gk-text-default);
        cursor: default;
    }
    .header {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }
    .title {
        margin: 0;
        font: inherit;
    }
    /* Muted and in capitals, as the panel's and the sidebar's section headings are: chrome, not
       document text. */
    .toggle {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.15rem 0;
        border: 0;
        background: transparent;
        color: var(--gk-text-muted);
        font: inherit;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        cursor: pointer;
    }
    @media (hover: hover) {
        .toggle:hover {
            color: var(--gk-text-default);
        }
    }
    .toggle:focus-visible,
    .retry:focus-visible {
        outline: 2px solid var(--gk-accent, #2563eb);
        outline-offset: 2px;
    }
    /* A finger needs a 44 CSS px target. */
    @media (pointer: coarse) {
        .toggle {
            min-height: 2.75rem;
        }
    }
    .chevron {
        display: inline-block;
        width: 0.75em;
        text-align: center;
        transition: transform 150ms ease-out;
    }
    .chevron--open {
        transform: rotate(90deg);
    }
    @media (prefers-reduced-motion: reduce) {
        .chevron {
            transition: none;
        }
    }
    .count {
        min-width: 1.4rem;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background: var(--gk-surface-2, rgba(127, 127, 127, 0.15));
        color: var(--gk-text-default);
        letter-spacing: normal;
        text-align: center;
    }
    .list {
        margin-top: 0.75rem;
    }
    .error {
        margin: 0;
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
</style>
