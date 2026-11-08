<script lang="ts">
    /** Find in this EBook: a search of its text in the frame, never the graph's index. Results list by chapter. */
    import { iconSvg } from "#lib/surface/icons.js";

    import { isSearchable, type EbookReader } from "./ebook-reader.svelte";

    let { reader }: { reader: EbookReader } = $props();

    let debounce: ReturnType<typeof setTimeout> | undefined;
    let current = $state(-1);

    const flat = $derived(reader.findSections.flatMap((section) => section.matches));

    function onInput(event: Event) {
        const { value } = event.currentTarget as HTMLInputElement;
        reader.findQuery = value;
        current = -1;
        clearTimeout(debounce);
        debounce = setTimeout(() => reader.runFind(value), 250);
    }

    function goToMatch(index: number) {
        if (flat.length === 0) return;
        current = (index + flat.length) % flat.length;
        reader.goTo(flat[current].cfi);
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === "Escape") {
            event.preventDefault();
            reader.closeFind();
        } else if (event.key === "Enter") {
            event.preventDefault();
            goToMatch(event.shiftKey ? current - 1 : current + 1);
        }
    }

    const status = $derived.by(() => {
        if (!isSearchable(reader.findQuery)) return "";
        if (flat.length > 0) return `${current >= 0 ? `${current + 1} of ` : ""}${flat.length}${reader.findBusy ? ", searching…" : current < 0 ? (flat.length === 1 ? " match" : " matches") : ""}`;
        return reader.findBusy ? "Searching…" : "No matches";
    });

    const focusOnOpen = (input: HTMLInputElement) => {
        input.focus();
        input.select();
    };
</script>

<div class="relative shrink-0 border-b border-(--gk-surface-2) bg-(--gk-surface-1)" data-testid="ebook-find-bar">
    <div class="flex flex-wrap items-center gap-2 px-2 py-1.5">
        <label class="sr-only" for="ebook-find-input">Find in this EBook</label>
        <input
            id="ebook-find-input"
            {@attach focusOnOpen}
            type="search"
            placeholder="Find in this EBook"
            class="min-w-40 flex-1 rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700"
            value={reader.findQuery}
            oninput={onInput}
            onkeydown={onKeydown}
            data-testid="ebook-find-input"
        />
        <span class="min-w-16 text-sm text-(--gk-text-muted)" role="status" data-testid="ebook-find-status">{status}</span>
        <button type="button" class="ebook-tool" aria-label="Previous match" title="Previous match" onclick={() => goToMatch(current - 1)} data-testid="ebook-find-previous">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("move-up")}
        </button>
        <button type="button" class="ebook-tool" aria-label="Next match" title="Next match" onclick={() => goToMatch(current + 1)} data-testid="ebook-find-next">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("move-down")}
        </button>
        <button type="button" class="ebook-tool" aria-label="Close find" title="Close find" onclick={() => reader.closeFind()} data-testid="ebook-find-close">
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
            {@html iconSvg("close")}
        </button>
    </div>
    {#if flat.length > 0}
        <ul class="max-h-48 overflow-y-auto border-t border-(--gk-surface-2) p-1" data-testid="ebook-find-results">
            {#each reader.findSections as section, sectionIndex (sectionIndex)}
                {#if section.chapter}<li class="px-2 pt-1 text-sm font-medium text-(--gk-text-muted)">{section.chapter}</li>{/if}
                {#each section.matches as match (match.cfi)}
                    <li>
                        <button type="button" class="w-full rounded-md px-2 py-1 text-left text-sm text-(--gk-text-default) hover:bg-(--gk-surface-2)" onclick={() => goToMatch(flat.indexOf(match))} data-testid="ebook-find-result">
                            {match.before}<mark class="bg-(--gk-highlight-bg) text-inherit">{match.match}</mark>{match.after}
                        </button>
                    </li>
                {/each}
            {/each}
        </ul>
    {/if}
</div>
