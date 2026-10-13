<script lang="ts">
    /**
     * The [[Journal Panel]]s beneath a journal tab's entry (ADR 0120, amended 2026-10-12): every
     * panel extensions registered, in the order they were registered, each drawn by its extension
     * for the tab's day (`$lib/extensions/journal-panels.ts`). A panel registered while the tab is
     * open (an extension switched on) is drawn as it arrives, and one withdrawn goes.
     *
     * DocumentView puts this in the editor's scroller after the text and before the [[Backlink]]s,
     * for the tab's own entry only, a [[Draft]] included. `ondrawnchange` says when anything is
     * drawn, so the text gives up its full pane height: a panel that draws nothing takes no space.
     * The section carries `data-journal-panels` (`journal-panels-dom.ts`), which the modules that
     * share what is beneath the text find it by.
     */
    import { untrack } from "svelte";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import type { ViewVisibility } from "$lib/layout";
    import { mountJournalPanel } from "$lib/extensions/journal-panels";
    import { tryGetActiveContributionRegistry } from "$lib/surface";
    import { type ClientJournalPanel, JOURNAL_PANEL_KIND, listJournalPanels } from "$lib/surface/journal-panels";

    import { CONTENT_PAD_X } from "./cm-document";

    let {
        day,
        panelId,
        visibility,
        ondrawnchange,
    }: {
        /** The entry's day, `YYYY-MM-DD`. */
        day: string;
        /** Fixed for the View's life: a moved tab is a new View. */
        panelId?: string;
        visibility?: ViewVisibility;
        ondrawnchange?: (drawn: boolean) => void;
    } = $props();

    const registry = tryGetActiveContributionRegistry();
    const watchPanels = createSubscriber((update) => registry?.subscribe(JOURNAL_PANEL_KIND, update) ?? (() => {}));
    const panels = $derived.by(() => {
        watchPanels();
        return registry ? listJournalPanels(registry) : [];
    });

    /** A tab with no presenter-given visibility is always on screen. */
    const alwaysOnScreen = { onScreen: true, subscribe: () => () => {} };

    function drawPanel(panel: ClientJournalPanel): Attachment<HTMLElement> {
        return (element) => {
            const props = untrack(() => ({ day, ...(panelId === undefined ? {} : { panelId }), visibility: visibility ?? alwaysOnScreen }));
            const view = mountJournalPanel(element, panel, props);
            return () => view.destroy();
        };
    }

    /** Whether any panel draws something, as the panels' height says. */
    let drawn = $state(false);

    /**
     * Measure the panels as they draw, telling DocumentView each time anything starts or stops
     * showing. Told on the next frame, not inside the observer: what it changes (the text giving up
     * its full height, the panels joining the scroller's row) resizes them again, which an observer
     * callback changing layout reports as a loop.
     */
    const measured: Attachment<HTMLElement> = (inner) => {
        let frame = 0;
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const now = inner.offsetHeight > 0;
                if (now === drawn) return;
                drawn = now;
                ondrawnchange?.(now);
            });
        });
        observer.observe(inner);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            // Reset with what DocumentView is told, so panels coming back start undrawn.
            if (drawn) {
                drawn = false;
                ondrawnchange?.(false);
            }
        };
    };
</script>

{#if panels.length > 0}
    <div class="journal-panels" style:--content-pad-x={CONTENT_PAD_X} data-testid="journal-panels" data-journal-panels data-drawn={drawn || undefined}>
        <div class="journal-panels__inner" {@attach measured}>
            {#each panels as panel (panel.id)}
                <div class="journal-panel" data-journal-panel={panel.id} {@attach drawPanel(panel)}></div>
            {/each}
        </div>
    </div>
{/if}

<style>
    /* Until a panel draws something: out of the scroller's row, out of sight and no height, where the
       panels are still laid out and measured (inside, which keeps its own height). The scroller is a
       flex row that wraps only once something is drawn beneath the text, and an item in it would take
       width beside the text. No height also makes drawing one a size change, which the reading-point
       keeper hears. */
    .journal-panels {
        position: absolute;
        inset-inline: 0;
        height: 0;
        overflow: hidden;
        visibility: hidden;
        pointer-events: none;
    }
    /* Then a row of its own, in the text's column, as the Backlinks below it are. Each panel draws
       its own heading and spacing, in the chrome's size unless it sets its own. Visibility and
       pointer events come from the tab again, never forced on: dockview hides a tab behind another
       with `visibility: hidden`, which a `visible` here overrode, drawing the panel through the tab
       in front. */
    .journal-panels[data-drawn] {
        position: static;
        height: auto;
        overflow: visible;
        visibility: inherit;
        pointer-events: inherit;
        flex: 0 0 calc(100% - 2 * var(--content-pad-x));
        min-width: 0;
        box-sizing: border-box;
        margin: 0 var(--content-pad-x);
        font-family: var(--gk-sans, "Inter", system-ui, sans-serif);
        font-size: 0.875rem;
        line-height: 1.5;
        color: var(--gk-text-default);
        cursor: default;
    }
    .journal-panel {
        display: block;
    }
</style>
