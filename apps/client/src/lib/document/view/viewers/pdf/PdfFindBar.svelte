<script lang="ts">
    /** Find in this PDF: an in-memory search of its pages, never the graph's index. */
    import { iconSvg } from "#lib/surface/icons.js";

    import type { PdfReader } from "./pdf-reader.svelte";

    let { reader }: { reader: PdfReader } = $props();

    let debounce: ReturnType<typeof setTimeout> | undefined;

    function onInput(event: Event) {
        const { value } = event.currentTarget as HTMLInputElement;
        reader.findQuery = value;
        clearTimeout(debounce);
        debounce = setTimeout(() => reader.runFind(value), 200);
    }

    function step(previous: boolean) {
        if (reader.findQuery !== "") reader.runFind(reader.findQuery, "again", previous);
    }

    function onKeydown(event: KeyboardEvent) {
        if (event.key === "Escape") {
            event.preventDefault();
            reader.closeFind();
        } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey);
        }
    }

    const status = $derived.by(() => {
        const { state, current, total } = reader.find;
        if (reader.findQuery === "" || state === "idle") return "";
        if (state === "no-text") return "This PDF has no text to search. It may be a scan.";
        if (state === "not-found") return "No matches";
        if (total === 0) return "Searching…";
        const count = `${current} of ${total}`;
        return state === "pending" ? `${count}, searching…` : count;
    });

    const focusOnOpen = (input: HTMLInputElement) => {
        input.focus();
        input.select();
    };
</script>

<div class="flex flex-wrap items-center gap-2 border-b border-(--gk-surface-2) bg-(--gk-surface-1) px-2 py-1.5" data-testid="pdf-find-bar">
    <label class="sr-only" for="pdf-find-input">Find in this PDF</label>
    <input
        id="pdf-find-input"
        {@attach focusOnOpen}
        type="search"
        placeholder="Find in this PDF"
        class="min-w-40 flex-1 rounded-lg border border-neutral-300 bg-(--gk-surface-0) px-2 py-1 text-sm text-(--gk-text-default) dark:border-neutral-700"
        value={reader.findQuery}
        oninput={onInput}
        onkeydown={onKeydown}
        data-testid="pdf-find-input"
    />
    <span class="min-w-16 text-sm text-(--gk-text-muted)" role="status" data-testid="pdf-find-status">{status}</span>
    <button type="button" class="pdf-tool" aria-label="Previous match" title="Previous match" onclick={() => step(true)} data-testid="pdf-find-previous">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg("move-up")}
    </button>
    <button type="button" class="pdf-tool" aria-label="Next match" title="Next match" onclick={() => step(false)} data-testid="pdf-find-next">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg("move-down")}
    </button>
    <button type="button" class="pdf-tool" aria-label="Close find" title="Close find" onclick={() => reader.closeFind()} data-testid="pdf-find-close">
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
        {@html iconSvg("close")}
    </button>
</div>
