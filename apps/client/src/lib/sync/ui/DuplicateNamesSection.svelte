<script lang="ts">
    /**
     * The Duplicate Names section of Settings → Maintenance (ADR 0157): each name that more than
     * one document answers to, what each document holds, a preview of the merged text, and the
     * person-confirmed [[Merge]] that joins them. Shown on the phone layout too: the text the
     * section finds is hidden on every device until it is merged.
     */
    import { tick, untrack } from "svelte";
    import { mergeConfirmation } from "./duplicate-names-copy";
    import type { DuplicateNameRow, DuplicateNamesSession } from "./duplicate-names-session.svelte";

    let { session }: { session: DuplicateNamesSession } = $props();

    const uid = $props.id();
    let root = $state<HTMLElement | null>(null);
    /**
     * Whether the dialog's Review opened Settings onto this section. Read once: Settings opening
     * puts focus on its first field (the Formatting confirmation, further down), so the heading
     * is marked as the dialog's focus target instead.
     */
    const revealOnOpen = untrack(() => session.revealRequested);

    // Reading the texts starts with the section and stops with it: nothing is read for a graph
    // whose Maintenance tab nobody opens. Untracked, so a text arriving does not reopen it.
    $effect(() => untrack(() => session.open()));

    // The open dialog's Review lands here: bring the section into view and put focus on its
    // heading, once, so a screen reader starts at the list.
    $effect(() => {
        if (!session.revealRequested || !root) return;
        session.revealRequested = false;
        const heading = root.querySelector<HTMLElement>("[data-duplicate-names-heading]");
        // "nearest": the section starts the tab, so this scrolls only a body scrolled away from it.
        // "start" scrolled the page behind the fixed dialog as well, out of view.
        heading?.scrollIntoView({ block: "nearest" });
        heading?.focus({ preventScroll: true });
    });

    const announcement = $derived(session.lastMerged ? `Merged the documents named ${session.lastMerged}.` : "");

    async function askMerge(row: DuplicateNameRow) {
        session.askMerge(row.key);
        await tick();
        root?.querySelector<HTMLElement>(`[data-merge-confirm="${row.key}"] [data-merge-go]`)?.focus();
    }

    async function cancelMerge(row: DuplicateNameRow) {
        session.cancelMerge(row.key);
        await tick();
        root?.querySelector<HTMLElement>(`[data-merge-ask="${row.key}"]`)?.focus();
    }

    function onConfirmKeydown(event: KeyboardEvent, row: DuplicateNameRow) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        void cancelMerge(row);
    }

    const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

    const button =
        "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40";
    const primary =
        "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40";
</script>

<section bind:this={root} class="space-y-3" aria-labelledby="{uid}-heading" data-testid="duplicate-names-section">
    <h3
        id="{uid}-heading"
        class="text-sm font-medium text-gray-500 dark:text-gray-400 focus:outline-none"
        tabindex="-1"
        data-duplicate-names-heading
        data-autofocus={revealOnOpen ? "" : undefined}
    >
        Duplicate names
    </h3>
    <p class="text-sm text-gray-600 dark:text-gray-300">
        When two devices each create a document for the same name before they sync, the graph keeps both. The name opens
        only one of them. Merge them to keep all the text in one document.
    </p>
    <p class="sr-only" aria-live="polite">{announcement}</p>

    {#if session.rows.length === 0}
        <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="duplicate-names-empty">
            Every name in this graph opens one document.
        </p>
    {:else}
        <ul class="space-y-3">
            {#each session.rows as row (row.key)}
                <li
                    class="space-y-3 rounded-lg border border-gray-200 dark:border-gray-800 p-3"
                    data-duplicate-name={row.concept}
                    data-state={row.state}
                    data-testid="duplicate-name"
                >
                    <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h4 class="break-words text-sm font-medium text-gray-950 dark:text-gray-100" data-testid="duplicate-name-concept">
                            {row.concept}
                        </h4>
                        <p class="text-sm text-gray-500 dark:text-gray-400">
                            {plural(row.documents.length, "document", "documents")}
                        </p>
                    </div>

                    {#if row.state === "reading"}
                        <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="duplicate-name-reading">Reading the documents…</p>
                    {:else if row.state === "unreadable"}
                        <div class="flex flex-wrap items-center gap-2">
                            <p class="text-sm text-gray-600 dark:text-gray-300">
                                These documents could not be read. Check your connection, then try again.
                            </p>
                            <button type="button" onclick={() => session.retry(row.key)} class={button} data-testid="duplicate-name-retry"
                                >Try again</button
                            >
                        </div>
                    {:else}
                        <ol class="space-y-2" aria-label="Documents named {row.concept}, in the order they are joined">
                            {#each row.documents as document, index (document.docId)}
                                <li
                                    class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 rounded-md bg-gray-50 dark:bg-white/5 px-3 py-2"
                                    data-testid="duplicate-document"
                                    data-doc-id={document.docId}
                                >
                                    <div class="min-w-0 flex-1">
                                        <p class="text-sm text-gray-950 dark:text-gray-100">
                                            {#if index === 0}<span class="font-medium">Kept: </span>{/if}{plural(document.lines, "line", "lines")}{#if document.isProtected}
                                                <span class="text-gray-600 dark:text-gray-300"> · protected</span>{/if}
                                        </p>
                                        <p class="truncate text-sm text-gray-600 dark:text-gray-300" data-testid="duplicate-document-first-line">
                                            {document.isProtected ? "Protected text" : document.firstLine || "(empty)"}
                                        </p>
                                    </div>
                                    {#if index > 0}
                                        <button
                                            type="button"
                                            onclick={() => session.makeFirst(row.key, document.docId)}
                                            disabled={row.merging}
                                            class={button}
                                            data-testid="duplicate-document-make-first">Keep this one</button
                                        >
                                    {/if}
                                </li>
                            {/each}
                        </ol>

                        {#if row.hasProtected}
                            <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="duplicate-name-protected">
                                One of these pages is protected. Remove its protection, then merge.
                            </p>
                        {/if}

                        <div class="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onclick={() => session.togglePreview(row.key)}
                                aria-expanded={row.previewing}
                                aria-controls="{uid}-preview-{row.key}"
                                disabled={row.hasProtected}
                                class={button}
                                data-testid="duplicate-name-preview-toggle"
                                >{row.previewing ? "Hide merged text" : "Show merged text"}</button
                            >
                            {#if !row.confirming}
                                <button
                                    type="button"
                                    onclick={() => askMerge(row)}
                                    disabled={row.hasProtected || row.merging}
                                    class={primary}
                                    data-merge-ask={row.key}
                                    data-testid="duplicate-name-merge">{row.merging ? "Merging…" : "Merge…"}</button
                                >
                            {/if}
                        </div>

                        {#if row.previewing && !row.hasProtected}
                            <pre
                                id="{uid}-preview-{row.key}"
                                class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-black/20 p-3 font-mono text-sm text-gray-800 dark:text-gray-200"
                                data-testid="duplicate-name-preview">{row.merged}</pre>
                        {/if}

                        {#if row.confirming}
                            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                            <div
                                class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100"
                                role="group"
                                aria-label="Confirm the merge"
                                data-merge-confirm={row.key}
                                data-testid="duplicate-name-merge-confirm"
                                onkeydown={(event) => onConfirmKeydown(event, row)}
                            >
                                <p>{mergeConfirmation(row.concept, row.documents.map((d) => d.lines))}</p>
                                <div class="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onclick={() => session.merge(row.key)}
                                        class={primary}
                                        data-merge-go
                                        data-testid="duplicate-name-merge-go">Merge</button
                                    >
                                    <button type="button" onclick={() => cancelMerge(row)} class={button}>Cancel</button>
                                </div>
                            </div>
                        {/if}
                    {/if}

                    {#if row.message}
                        <p class="text-sm text-gray-700 dark:text-gray-200" role="status" data-testid="duplicate-name-message">{row.message}</p>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</section>
