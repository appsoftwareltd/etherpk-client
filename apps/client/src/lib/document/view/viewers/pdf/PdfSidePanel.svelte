<script lang="ts">
    /**
     * A PDF's panel: the person's annotations and PDF Bookmarks, and the Documents that link to the PDF.
     * Each row goes to its page. Removing an annotation can be undone, and a PDF Bookmark is a click to
     * make again, so neither asks first.
     */
    import { iconSvg } from "#lib/surface/icons.js";
    import type { PdfAnnotation } from "#lib/document/pdf/pdf-state.js";

    import type { PdfReader } from "./pdf-reader.svelte";

    let {
        reader,
        linkedFrom,
        onclose,
        onopendocument,
        oncopytojournal,
    }: {
        reader: PdfReader;
        /** The Documents linking here; null while it cannot be answered yet. */
        linkedFrom: { concept: string; references: number }[] | null;
        onclose: () => void;
        onopendocument: (concept: string) => void;
        oncopytojournal: (annotation: PdfAnnotation) => void;
    } = $props();

    type Tab = "annotations" | "marks" | "links";
    let tab = $state<Tab>("annotations");

    const sorted = $derived(reader.annotations.toSorted((a, b) => a.page - b.page || a.createdAt - b.createdAt));

    function describe(annotation: PdfAnnotation): string {
        if (annotation.kind === "note") return annotation.text;
        if (annotation.kind === "highlight") return annotation.text ?? "Highlight";
        return annotation.tool === "pen" ? "Drawing" : "Freehand highlight";
    }

    const tabClass = (on: boolean) =>
        `rounded-lg px-2 py-1 text-sm ${on ? "bg-(--gk-surface-2) font-medium text-(--gk-text-strong)" : "text-(--gk-text-default) hover:bg-(--gk-surface-2)"}`;
    const rowButton = "pdf-tool shrink-0";
</script>

<aside class="etherpk-pdf-panel flex flex-col border-l border-(--gk-surface-2) bg-(--gk-surface-1)" aria-label="This PDF's annotations and marks" data-testid="pdf-side-panel">
    <div class="flex items-center gap-1 border-b border-(--gk-surface-2) p-1.5">
        <div class="flex flex-1 flex-wrap gap-1" role="group" aria-label="Show">
            <button type="button" class={tabClass(tab === "annotations")} aria-pressed={tab === "annotations"} onclick={() => (tab = "annotations")} data-testid="pdf-panel-annotations">Annotations</button>
            <button type="button" class={tabClass(tab === "marks")} aria-pressed={tab === "marks"} onclick={() => (tab = "marks")} data-testid="pdf-panel-marks">PDF Bookmarks</button>
            <button type="button" class={tabClass(tab === "links")} aria-pressed={tab === "links"} onclick={() => (tab = "links")} data-testid="pdf-panel-links">Linked from</button>
        </div>
        <button type="button" class={rowButton} aria-label="Close panel" title="Close panel" onclick={onclose}>
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("close")}
        </button>
    </div>
    <div class="flex-1 overflow-y-auto p-1.5">
        {#if tab === "annotations"}
            {#if sorted.length === 0}
                <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="pdf-panel-empty">Highlight, draw or add a note, and it is listed here.</p>
            {:else}
                <ul class="flex flex-col gap-0.5">
                    {#each sorted as annotation (annotation.id)}
                        <li class="flex items-start gap-1 rounded-lg hover:bg-(--gk-surface-2)" data-testid="pdf-annotation-row" data-kind={annotation.kind === "stroke" ? annotation.tool : annotation.kind}>
                            <button type="button" class="min-w-0 flex-1 p-1.5 text-left text-sm text-(--gk-text-default)" onclick={() => reader.showPage(annotation.page)}>
                                <span class="mr-1 inline-block size-2.5 rounded-full" style:background-color={annotation.colour} aria-hidden="true"></span>
                                <span class="text-(--gk-text-muted)">p.{annotation.page}</span>
                                <span class="line-clamp-3 break-words">{describe(annotation)}</span>
                            </button>
                            <button type="button" class={rowButton} aria-label="Copy to journal" title="Copy to journal" onclick={() => oncopytojournal(annotation)} data-testid="pdf-annotation-copy">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("todays-journal")}
                            </button>
                            <button type="button" class={rowButton} aria-label="Delete this annotation" title="Delete" onclick={() => reader.removeAnnotation(annotation.id)} data-testid="pdf-annotation-delete">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("trash")}
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        {:else if tab === "marks"}
            {#if reader.bookmarks.length === 0}
                <p class="p-2 text-sm text-(--gk-text-muted)">Add a PDF Bookmark from the toolbar to come back to a page.</p>
            {:else}
                <ul class="flex flex-col gap-0.5">
                    {#each reader.bookmarks as mark (mark.id)}
                        <li class="flex items-center gap-1 rounded-lg hover:bg-(--gk-surface-2)" data-testid="pdf-panel-bookmark-row">
                            <button type="button" class="flex-1 p-1.5 text-left text-sm text-(--gk-text-default)" onclick={() => reader.goToPage(mark.page)}>Page {mark.page}</button>
                            <button type="button" class={rowButton} aria-label={`Remove the PDF Bookmark on page ${mark.page}`} title="Remove" onclick={() => reader.removeBookmark(mark.id)}>
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
            <p class="p-2 text-sm text-(--gk-text-muted)" data-testid="pdf-links-empty">No Document you can read links to this PDF.</p>
        {:else}
            <ul class="flex flex-col gap-0.5">
                {#each linkedFrom as document (document.concept)}
                    <li data-testid="pdf-link-row">
                        <button type="button" class="w-full rounded-lg p-1.5 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => onopendocument(document.concept)}>{document.concept}</button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</aside>
