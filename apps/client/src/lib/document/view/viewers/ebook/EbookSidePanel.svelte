<script lang="ts">
    /**
     * An EBook's panel: its contents, the person's highlights and bookmarks, and the Documents that link to
     * it. Each row goes to its place. Removing a highlight can be undone, and a bookmark is a click to make
     * again, so neither asks first.
     */
    import { formatMinutes } from "#lib/document/ebook/ebook-pace.js";
    import type { EbookHighlight } from "#lib/document/ebook/ebook-state.js";
    import { iconSvg } from "#lib/surface/icons.js";

    import type { EbookReader } from "./ebook-reader.svelte";

    let {
        reader,
        linkedFrom,
        onclose,
        onopendocument,
        oncopytojournal,
        onexport,
    }: {
        reader: EbookReader;
        /** The Documents linking here; null while it cannot be answered yet. */
        linkedFrom: { concept: string; references: number }[] | null;
        onclose: () => void;
        onopendocument: (concept: string) => void;
        oncopytojournal: (highlight: EbookHighlight) => void;
        onexport: () => void;
    } = $props();

    type Tab = "contents" | "highlights" | "bookmarks" | "links";
    let tab = $state<Tab>("contents");

    const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;
    const tabClass = (on: boolean) => `rounded-lg px-2 py-1 text-sm ${on ? "bg-(--gk-surface-2) font-medium text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-2)"}`;
    const rowButton = "ebook-tool shrink-0";

    let skim = $state<number | null>(null);
    const skimValue = $derived(skim ?? Math.round((reader.place?.fraction ?? 0) * 100));
    const leftInEbook = $derived(reader.paced(reader.place?.minutesLeftInEbook ?? null));
</script>

<aside class="etherpk-ebook-panel flex flex-col border-l border-(--gk-surface-2) bg-(--gk-surface-1)" aria-label="This EBook's contents and marks" data-testid="ebook-side-panel">
    <div class="flex items-center gap-1 border-b border-(--gk-surface-2) p-1.5">
        <div class="flex flex-1 flex-wrap gap-1" role="group" aria-label="Show">
            <button type="button" class={tabClass(tab === "contents")} aria-pressed={tab === "contents"} onclick={() => (tab = "contents")} data-testid="ebook-panel-contents">Contents</button>
            <button type="button" class={tabClass(tab === "highlights")} aria-pressed={tab === "highlights"} onclick={() => (tab = "highlights")} data-testid="ebook-panel-highlights">Highlights</button>
            <button type="button" class={tabClass(tab === "bookmarks")} aria-pressed={tab === "bookmarks"} onclick={() => (tab = "bookmarks")} data-testid="ebook-panel-bookmarks">Bookmarks</button>
            <button type="button" class={tabClass(tab === "links")} aria-pressed={tab === "links"} onclick={() => (tab = "links")} data-testid="ebook-panel-links">Linked from</button>
        </div>
        <button type="button" class={rowButton} aria-label="Close panel" title="Close panel" onclick={onclose} data-testid="ebook-panel-close">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("close")}
        </button>
    </div>
    <div class="flex-1 overflow-y-auto p-1.5">
        {#if tab === "contents"}
            <label class="mb-1 flex items-center gap-2 px-1.5 text-sm text-(--gk-text-muted)">
                <span class="shrink-0">Skim</span>
                <input
                    type="range"
                    min="0"
                    max="100"
                    class="min-w-0 flex-1"
                    value={skimValue}
                    oninput={(event) => (skim = event.currentTarget.valueAsNumber)}
                    onchange={(event) => {
                        reader.goToFraction(event.currentTarget.valueAsNumber / 100);
                        skim = null;
                    }}
                    data-testid="ebook-skim"
                />
                <span class="w-10 shrink-0 text-right">{skimValue}%</span>
            </label>
            <p class="px-1.5 pb-1 text-sm text-(--gk-text-muted)" data-testid="ebook-stats">
                {#if leftInEbook !== null}About {formatMinutes(leftInEbook)} left in this EBook.{/if}
                {#if reader.minutesReadToday >= 1}{formatMinutes(reader.minutesReadToday)} read today on this device.{/if}
            </p>
            {#if reader.toc.length === 0}
                <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="ebook-contents-empty">This EBook has no table of contents.</p>
            {:else}
                <ul class="flex flex-col gap-0.5">
                    {#each reader.toc as entry, index (index)}
                        <li>
                            <button
                                type="button"
                                class={["w-full rounded-lg p-1.5 text-left text-sm hover:bg-(--gk-surface-2)", reader.place?.chapter === entry.label ? "font-medium text-(--gk-text-strong)" : "text-(--gk-text-default)"]}
                                style:padding-left="{0.375 + entry.depth * 0.75}rem"
                                aria-current={reader.place?.chapter === entry.label ? "location" : undefined}
                                onclick={() => reader.goTo(entry.href)}
                                data-testid="ebook-contents-row">{entry.label || "Untitled"}</button
                            >
                        </li>
                    {/each}
                </ul>
            {/if}
        {:else if tab === "highlights"}
            {#if reader.highlights.length === 0}
                <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="ebook-highlights-empty">Select some words and highlight them, and they are listed here.</p>
            {:else}
                <button type="button" class="mb-1 w-full rounded-lg border border-neutral-300 px-2 py-1 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2) dark:border-neutral-700" onclick={onexport} data-testid="ebook-highlights-export">Export to a page</button>
                <ul class="flex flex-col gap-0.5">
                    {#each reader.highlights as highlight (highlight.id)}
                        <li class="flex items-start gap-1 rounded-lg hover:bg-(--gk-surface-2)" data-testid="ebook-highlight-row">
                            <button type="button" class="min-w-0 flex-1 p-1.5 text-left text-sm text-(--gk-text-default)" onclick={() => reader.goTo(highlight.cfi)}>
                                <span class="mr-1 inline-block size-2.5 rounded-full" style:background-color={highlight.colour} aria-hidden="true"></span>
                                <span class="text-(--gk-text-muted)">{highlight.chapter ? `${highlight.chapter}, ` : ""}{percent(highlight.fraction)}</span>
                                <span class="line-clamp-3 break-words">{highlight.text}</span>
                                {#if highlight.note}<span class="mt-0.5 block break-words text-(--gk-text-muted)" data-testid="ebook-highlight-note">{highlight.note}</span>{/if}
                            </button>
                            <button type="button" class={rowButton} aria-label="Note" title={highlight.note ? "Change the note" : "Add a note"} onclick={() => reader.startNote(highlight)} data-testid="ebook-highlight-note-edit">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("pdf-note")}
                            </button>
                            <button type="button" class={rowButton} aria-label="Copy to journal" title="Copy to journal" onclick={() => oncopytojournal(highlight)} data-testid="ebook-highlight-copy">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("todays-journal")}
                            </button>
                            <button type="button" class={rowButton} aria-label="Delete this highlight" title="Delete" onclick={() => reader.removeHighlight(highlight.id)} data-testid="ebook-highlight-delete">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("trash")}
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        {:else if tab === "bookmarks"}
            {#if reader.bookmarks.length === 0}
                <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="ebook-bookmarks-empty">Add a bookmark from the toolbar to come back to a place.</p>
            {:else}
                <ul class="flex flex-col gap-0.5">
                    {#each reader.bookmarks as mark (mark.id)}
                        <li class="flex items-center gap-1 rounded-lg hover:bg-(--gk-surface-2)" data-testid="ebook-panel-bookmark-row">
                            <button type="button" class="flex-1 p-1.5 text-left text-sm text-(--gk-text-default)" onclick={() => reader.goTo(mark.cfi)}>{mark.chapter ? `${mark.chapter}, ` : ""}{percent(mark.fraction)}</button>
                            <button type="button" class={rowButton} aria-label={`Remove the bookmark at ${percent(mark.fraction)}`} title="Remove" onclick={() => reader.removeBookmark(mark.id)} data-testid="ebook-panel-bookmark-remove">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("trash")}
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        {:else if linkedFrom === null}
            <p class="p-2 text-sm text-(--gk-text-muted)" role="status">Still reading this graph. Links show once it has finished.</p>
        {:else if linkedFrom.length === 0}
            <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="ebook-links-empty">No Document you can read links to this EBook.</p>
        {:else}
            <ul class="flex flex-col gap-0.5">
                {#each linkedFrom as document (document.concept)}
                    <li data-testid="ebook-link-row">
                        <button type="button" class="w-full rounded-lg p-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => onopendocument(document.concept)}>{document.concept}</button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</aside>
