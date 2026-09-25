<script lang="ts">
    /**
     * The [[All Documents]] View: every [[Document]] in the graph, filterable by name.
     *
     * Lives in the main region rather than the [[Sidebar]] because at real scale it needs the
     * room - the graph this was built against holds 2838 documents, which is precisely why
     * the old flat sidebar list had to go. It is the browse-everything surface: the only way
     * to reach a document that is neither recent nor favourited without already knowing its
     * name.
     *
     * Filtering uses the same normalise-then-`matchScore` path as [[Quick Find]], so a
     * [[Scoped Concept]] is found by the words a human would type here too.
     */
    import { onDestroy, onMount } from "svelte";

    import { getActiveDocumentStore } from "$lib/document";
    import { quickFindKey } from "$lib/document/quick-find";
    import { matchScore } from "$lib/document/view/augmentations/wikilink-complete-core";
    import { getActiveLayoutController, type ViewRef } from "$lib/layout";
    import type { FilesystemDocumentStore } from "$lib/storage";
    import { attachContextMenu, tryGetActiveEventBus, type DocumentContextMenuTarget } from "$lib/surface";

    const { view: _view }: { view: ViewRef } = $props();

    const store = getActiveDocumentStore() as FilesystemDocumentStore;

    let all = $state.raw<{ concept: string; kind: string }[]>([]);
    let filter = $state("");

    const matches = $derived.by(() => {
        const q = quickFindKey(filter);
        if (q === "") return all;
        return all
            .map((doc) => ({ doc, score: matchScore(quickFindKey(doc.concept), q) }))
            .filter((m): m is { doc: { concept: string; kind: string }; score: number } => m.score !== null)
            .sort((a, b) => b.score - a.score || a.doc.concept.localeCompare(b.doc.concept))
            .map((m) => m.doc);
    });

    function refresh() {
        all = store.listDocuments().map((d) => ({ concept: d.concept, kind: d.kind }));
    }

    function open(concept: string) {
        getActiveLayoutController().openView({ kind: "document", target: concept });
    }

    function menuTarget(concept: string) {
        // Returns its cleanup directly — the attachment contract, not `use:action`'s.
        return (node: HTMLElement) =>
            attachContextMenu(node, () => ({ kind: "document-row" as DocumentContextMenuTarget["kind"], concept }))
    }

    let unsubscribe: (() => void) | undefined;
    onMount(() => {
        refresh();
        unsubscribe = tryGetActiveEventBus()?.on("documents:changed", refresh);
    });
    onDestroy(() => unsubscribe?.());
</script>

<div class="flex h-full flex-col gap-3 overflow-hidden p-4" data-testid="all-documents">
    <div class="flex items-baseline gap-3">
        <input
            data-testid="all-documents-filter"
            placeholder="Filter by name…"
            aria-label="Filter documents by name"
            autocomplete="off"
            bind:value={filter}
            class="min-w-0 flex-1 rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-3 py-2 text-sm text-(--gk-text-strong) placeholder:text-(--gk-text-subtle) focus:border-(--gk-border-strong) focus:outline-none"
        />
        <span class="shrink-0 text-sm text-(--gk-text-subtle)" data-testid="all-documents-count">
            {matches.length} of {all.length}
        </span>
    </div>

    <ul class="min-h-0 flex-1 overflow-y-auto" data-testid="all-documents-list">
        {#each matches as doc (doc.concept)}
            <li>
                <button
                    type="button"
                    data-testid="all-documents-row"
                    {@attach menuTarget(doc.concept)}
                    onclick={() => open(doc.concept)}
                    class="flex w-full touch-manipulation select-none items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--gk-surface-2)"
                >
                    <span class="min-w-0 flex-1 truncate">{doc.concept}</span>
                    <span class="shrink-0 text-sm text-(--gk-text-subtle)">{doc.kind === "journal" ? "Journal" : "Page"}</span>
                </button>
            </li>
        {:else}
            <li class="px-2 py-3 text-sm text-(--gk-text-subtle)" data-testid="all-documents-empty">
                {all.length === 0 ? "This graph has no documents yet." : `Nothing matches "${filter}".`}
            </li>
        {/each}
    </ul>
</div>
