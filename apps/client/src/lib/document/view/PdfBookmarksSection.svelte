<!--
    The graph Sidebar's [[PDF Bookmark]]s: the pages the person marked, under the name of each PDF, below
    the line Bookmarks. With none the section is its heading alone, and opening it says how to add
    one (`bookmarks/section-open.ts`). A row opens the PDF at its page. Removing one acts at once, because marking
    the page again is a click in the PDF's toolbar.
-->
<script lang="ts">
    import { getActiveLayoutController } from "#lib/layout/active-controller.js";
    import { requestPdfPage } from "#lib/document/pdf/page-requests.js";
    import { removePdfBookmark, subscribePdfBookmarks, type PdfBookmark } from "#lib/document/pdf/pdf-bookmarks.js";
    import { sectionOpen, toggledChoice } from "#lib/document/bookmarks/section-open.js";
    import { iconSvg } from "#lib/surface/icons.js";

    let bookmarks = $state.raw<PdfBookmark[]>([]);
    /** What the person chose on the heading; until they do, the section is open only with a bookmark in it. */
    let openChoice = $state<boolean | null>(null);
    const open = $derived(sectionOpen(openChoice, bookmarks.length));
    let error = $state("");

    $effect(() => subscribePdfBookmarks((next) => (bookmarks = next)));

    const groups = $derived.by(() => {
        const byHash = new Map<string, { hash: string; name: string; items: PdfBookmark[] }>();
        for (const bookmark of bookmarks) {
            const group = byHash.get(bookmark.hash) ?? { hash: bookmark.hash, name: bookmark.name, items: [] };
            group.items.push(bookmark);
            byHash.set(bookmark.hash, group);
        }
        for (const group of byHash.values()) group.items.sort((a, b) => a.page - b.page);
        return [...byHash.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    });

    function openPage(bookmark: PdfBookmark) {
        requestPdfPage(bookmark.target, bookmark.page);
        getActiveLayoutController().openView({ kind: "asset", target: bookmark.target });
    }

    async function remove(bookmark: PdfBookmark) {
        error = "";
        try {
            await removePdfBookmark(bookmark.id);
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        }
    }
</script>

<section data-testid="pdf-bookmarks-section">
    <button
        type="button"
        data-testid="pdf-bookmarks-toggle"
        onclick={() => (openChoice = toggledChoice(open, bookmarks.length))}
        class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-muted) uppercase"
        aria-expanded={open}
    >
        <span class="inline-block motion-safe:transition-transform {open ? 'rotate-90' : ''}">›</span>
        PDF Bookmarks
    </button>
    {#if open}
        {#each groups as group (group.hash)}
            <div class="flex items-center gap-1.5 py-1 pr-2 pl-6 text-sm text-(--gk-text-muted)" data-testid="pdf-bookmark-group" title={group.name}>
                <span class="-ml-5 inline-flex w-3.5 shrink-0" aria-hidden="true">
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                    {@html iconSvg("pdf", { size: 14 })}
                </span>
                <span class="min-w-0 flex-1 truncate">{group.name}</span>
            </div>
            <ul>
                {#each group.items as bookmark (bookmark.id)}
                    <li class="group/row relative">
                        <button
                            type="button"
                            data-testid="pdf-bookmark-row"
                            onclick={() => openPage(bookmark)}
                            class="flex w-full touch-manipulation items-center gap-1.5 rounded-md py-1 pr-8 pl-8 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)"
                        >
                            <span class="inline-flex shrink-0 text-(--gk-text-subtle)" aria-hidden="true">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("bookmark", { size: 13 })}
                            </span>
                            Page {bookmark.page}
                        </button>
                        <button
                            type="button"
                            data-testid="pdf-bookmark-remove"
                            aria-label={`Remove the PDF Bookmark on page ${bookmark.page} of ${group.name}`}
                            title="Remove"
                            onclick={() => remove(bookmark)}
                            class="absolute top-1/2 right-1 inline-flex -translate-y-1/2 rounded p-1 text-(--gk-text-subtle) hover:bg-(--gk-surface-2)"
                        >
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                            {@html iconSvg("close", { size: 12 })}
                        </button>
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="px-6 py-1 text-sm text-(--gk-text-subtle)" data-testid="pdf-bookmarks-empty">To bookmark a page of a PDF, open it and choose Bookmark this page in its toolbar.</p>
        {/each}
        {#if error}<p class="px-6 py-1 text-sm text-(--gk-text-danger)" role="alert">{error}</p>{/if}
    {/if}
</section>
