<!--
    The graph Sidebar's EBook bookmarks: the places the person marked, under the name of each EBook, below
    the PDF Bookmarks. A row opens the EBook at its place. It shows only once there is one, because most
    graphs hold no EBook. Removing one acts at once, because marking the place again is a click in the tab.
-->
<script lang="ts">
    import { getActiveLayoutController } from "#lib/layout/active-controller.js";
    import { requestEbookPlace } from "#lib/document/ebook/ebook-links.js";
    import { removeEbookBookmark, subscribeEbookBookmarks, type EbookBookmark } from "#lib/document/ebook/ebook-bookmarks.js";
    import { iconSvg } from "#lib/surface/icons.js";

    let bookmarks = $state.raw<EbookBookmark[]>([]);
    let open = $state(true);
    let error = $state("");

    $effect(() => subscribeEbookBookmarks((next) => (bookmarks = next)));

    const groups = $derived.by(() => {
        const byHash = new Map<string, { hash: string; name: string; items: EbookBookmark[] }>();
        for (const bookmark of bookmarks) {
            const group = byHash.get(bookmark.hash) ?? { hash: bookmark.hash, name: bookmark.name, items: [] };
            group.items.push(bookmark);
            byHash.set(bookmark.hash, group);
        }
        for (const group of byHash.values()) group.items.sort((a, b) => a.fraction - b.fraction);
        return [...byHash.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    });

    function openPlace(bookmark: EbookBookmark) {
        requestEbookPlace(bookmark.target, bookmark.cfi);
        getActiveLayoutController().openView({ kind: "asset", target: bookmark.target });
    }

    async function remove(bookmark: EbookBookmark) {
        error = "";
        try {
            await removeEbookBookmark(bookmark.id);
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        }
    }

    const rowLabel = (bookmark: EbookBookmark) => `${bookmark.chapter ? `${bookmark.chapter}, ` : ""}${Math.round(bookmark.fraction * 100)}%`;
</script>

{#if bookmarks.length > 0}
    <section data-testid="ebook-bookmarks-section">
        <button
            type="button"
            data-testid="ebook-bookmarks-toggle"
            onclick={() => (open = !open)}
            class="flex w-full items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-muted) uppercase"
            aria-expanded={open}
        >
            <span class="inline-block motion-safe:transition-transform {open ? 'rotate-90' : ''}">›</span>
            EBook Bookmarks
        </button>
        {#if open}
            {#each groups as group (group.hash)}
                <div class="flex items-center gap-1.5 py-1 pr-2 pl-6 text-sm text-(--gk-text-muted)" data-testid="ebook-bookmark-group" title={group.name}>
                    <span class="-ml-5 inline-flex w-3.5 shrink-0" aria-hidden="true">
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                        {@html iconSvg("book", { size: 14 })}
                    </span>
                    <span class="min-w-0 flex-1 truncate">{group.name}</span>
                </div>
                <ul>
                    {#each group.items as bookmark (bookmark.id)}
                        <li class="group/row relative">
                            <button type="button" class="w-full rounded-md py-1 pr-7 pl-6 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => openPlace(bookmark)} data-testid="ebook-bookmark-row">{rowLabel(bookmark)}</button>
                            <button type="button" class="absolute top-1 right-1 rounded p-0.5 text-(--gk-text-muted) hover:bg-(--gk-surface-2)" aria-label={`Remove the bookmark at ${rowLabel(bookmark)}`} title="Remove" onclick={() => remove(bookmark)} data-testid="ebook-bookmark-remove">
                                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                                {@html iconSvg("close", { size: 14 })}
                            </button>
                        </li>
                    {/each}
                </ul>
            {/each}
            {#if error}<p class="px-2 text-sm text-red-700 dark:text-red-400" role="alert">{error}</p>{/if}
        {/if}
    </section>
{/if}
