<!--
    The graph Sidebar's [[Bookmark]]s (ADR 0159): the person's bookmarked lines, grouped under the
    name of the document each is in. Groups sort by name and lines by their place in the document,
    so nothing here has an order to keep or to move under the pointer.

    A row reads as its label, or as its line's text when it has none. Opening a row shows the line
    (`bookmarks.open`). Removing, from a row, a group or "Remove all", acts at once and offers Undo,
    and focus moves to the nearest row left, so a keyboard user is never dropped on the page.
-->
<script lang="ts">
    import { onDestroy, onMount, tick } from "svelte";

    import {
        BOOKMARK_OPEN,
        BOOKMARK_REMOVE_ALL,
    } from "$lib/document/commands/bookmark-commands";
    import {
        conceptKeyOf,
        getBookmarks,
        MAX_LABEL,
        setBookmarkLabel,
        subscribeBookmarks,
        type Bookmark,
    } from "$lib/document/bookmarks/bookmarks";
    import {
        readCollapsedGroups,
        writeCollapsedGroups,
    } from "$lib/document/bookmarks/collapsed-groups";
    import { reason } from "$lib/document/bookmarks/remove-with-undo";
    import {
        missingBookmarkLines,
        subscribeBookmarkLabelEdit,
        subscribeBookmarkStatus,
        takeBookmarkLabelEdit,
    } from "$lib/document/bookmarks/status";
    import {
        attachContextMenu,
        formatChordHint,
        isApplePlatform,
        openContextMenu,
        tryGetActiveCommandRegistry,
        type ContextMenuTarget,
    } from "$lib/surface";
    import { iconSvg } from "$lib/surface/icons";
    import { currentWorkspaceServices } from "$lib/workspace/workspace-services";

    let bookmarks = $state.raw<Bookmark[]>([]);
    /** Ids whose line an editor looked for and did not find. */
    let missing = $state.raw<ReadonlySet<string>>(new Set());
    let open = $state(true);
    const graphId = currentWorkspaceServices()?.graphId;
    /** Groups collapsed on this device, remembered per graph. */
    let collapsed = $state.raw<Set<string>>(readCollapsedGroups(graphId));
    /** A collapsed group opened only while one of its labels is edited: not remembered. */
    let openForEdit = $state<string | null>(null);
    let editingId = $state<string | null>(null);
    let labelDraft = $state("");
    let labelError = $state("");
    let section = $state<HTMLElement>();
    /** The row focus was on when a removal started, for putting focus back near it. */
    let focusAfterRemoval: number | null = null;

    const toggleChord = formatChordHint("Ctrl+Alt+K", isApplePlatform());

    const groups = $derived.by(() => {
        const byKey = new Map<string, { concept: string; key: string; items: Bookmark[] }>();
        for (const bookmark of bookmarks) {
            const key = conceptKeyOf(bookmark.concept);
            const group = byKey.get(key) ?? { concept: bookmark.concept, key, items: [] };
            group.items.push(bookmark);
            byKey.set(key, group);
        }
        for (const group of byKey.values()) group.items.sort((a, b) => a.line - b.line);
        return [...byKey.values()].sort((a, b) =>
            a.concept.localeCompare(b.concept, undefined, { sensitivity: "base" }),
        );
    });

    const execute = (command: string, arg?: unknown) =>
        void tryGetActiveCommandRegistry()?.execute(command, arg);

    const isOpen = (key: string) => !collapsed.has(key) || openForEdit === key;

    function toggleGroup(key: string) {
        if (openForEdit === key) openForEdit = null;
        const next = new Set(collapsed);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        collapsed = next;
        writeCollapsedGroups(graphId, next);
    }

    /**
     * Right-click and long-press on a row or a group header, as on a Favourite. Opening the menu
     * notes the row, so focus can come back near it if the menu removes it.
     */
    function menuOn(target: ContextMenuTarget) {
        return (node: HTMLElement) =>
            attachContextMenu(node, () => {
                const index = focusableRows().indexOf(node);
                focusAfterRemoval = index === -1 ? null : index;
                return target;
            });
    }

    /** The row or group header beside `button` (a ⋯ button), as an index into the focusable rows. */
    function rowIndexBeside(button: HTMLElement): number | null {
        const row = button.parentElement?.querySelector<HTMLElement>("[data-bookmark-focus]") ?? null;
        const index = row ? focusableRows().indexOf(row) : -1;
        return index === -1 ? null : index;
    }

    function focusableRows(): HTMLElement[] {
        return [...(section?.querySelectorAll<HTMLElement>("[data-bookmark-focus]") ?? [])];
    }

    function menuFromButton(event: MouseEvent, target: ContextMenuTarget) {
        event.stopPropagation();
        const button = event.currentTarget as HTMLElement;
        focusAfterRemoval = rowIndexBeside(button);
        const rect = button.getBoundingClientRect();
        openContextMenu(target, rect.right, rect.bottom);
    }

    function removeAll() {
        focusAfterRemoval = 0;
        execute(BOOKMARK_REMOVE_ALL);
    }

    /**
     * After the list changed under a removal started here, put focus on the nearest row left, or on
     * the section's own toggle when none is. Only when focus was dropped on the page: a menu that
     * closed, or an editor, may have it on purpose.
     */
    async function restoreFocusAfterRemoval() {
        const index = focusAfterRemoval;
        if (index === null) return;
        await tick();
        // The context menu gives focus back to its trigger as it closes; let it try first.
        setTimeout(() => {
            if (focusAfterRemoval !== index) return;
            focusAfterRemoval = null;
            // Only when focus was dropped (its row is gone): never take it from where it went.
            const active = document.activeElement;
            if (active && active !== document.body) return;
            const rows = focusableRows();
            const target = rows[Math.min(index, rows.length - 1)] ?? section?.querySelector<HTMLElement>("[data-testid='bookmarks-toggle']");
            target?.focus();
        }, 0);
    }

    // ---- the label, edited in its row ----

    function startEditing(id: string) {
        const bookmark = getBookmarks().find((b) => b.id === id);
        if (!bookmark) return;
        open = true;
        const key = conceptKeyOf(bookmark.concept);
        if (collapsed.has(key)) openForEdit = key;
        editingId = id;
        labelDraft = bookmark.label ?? "";
        labelError = "";
    }

    function focusOnMount(node: HTMLInputElement) {
        node.focus();
        node.select();
    }

    async function focusRow(id: string) {
        await tick();
        section?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(id)}"]`)?.focus();
    }

    let saving = false;
    /**
     * Save the label. `focusAfter` puts focus back on the row, for Enter. Leaving the box by a click
     * elsewhere saves too, and leaves focus where the click put it.
     */
    async function saveLabel(focusAfter: boolean) {
        const id = editingId;
        if (id === null || saving) return;
        saving = true;
        try {
            await setBookmarkLabel(id, labelDraft);
            editingId = null;
            openForEdit = null;
            if (focusAfter) await focusRow(id);
        } catch (err) {
            // The typed label stays in the box, so nothing is lost; the reason shows beneath it.
            labelError = `The label was not saved. ${reason(err)} Press Enter to try again.`.replace(/\s+/g, " ");
        } finally {
            saving = false;
        }
    }

    function cancelEditing() {
        const id = editingId;
        editingId = null;
        openForEdit = null;
        labelError = "";
        if (id) void focusRow(id);
    }

    function onLabelKeydown(event: KeyboardEvent) {
        if (event.key === "Enter") {
            event.preventDefault();
            void saveLabel(true);
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancelEditing();
        }
    }

    /** Leaving the box saves, unless Escape already took the edit back. */
    function onLabelBlur() {
        if (editingId !== null) void saveLabel(false);
    }

    let unsubscribers: (() => void)[] = [];
    onMount(() => {
        unsubscribers.push(
            subscribeBookmarks((next) => {
                bookmarks = next;
                void restoreFocusAfterRemoval();
            }),
        );
        unsubscribers.push(subscribeBookmarkStatus(() => (missing = missingBookmarkLines())));
        missing = missingBookmarkLines();
        unsubscribers.push(subscribeBookmarkLabelEdit((id) => startEditing(takeBookmarkLabelEdit() ?? id)));
        const pending = takeBookmarkLabelEdit();
        if (pending) startEditing(pending);
    });
    onDestroy(() => {
        for (const dispose of unsubscribers) dispose();
        unsubscribers = [];
    });
</script>

<section data-testid="bookmarks-section" bind:this={section}>
    <div class="flex items-center gap-1 pr-1">
        <button
            type="button"
            data-testid="bookmarks-toggle"
            onclick={() => (open = !open)}
            class="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left text-sm font-semibold tracking-wide text-(--gk-text-subtle) uppercase pointer-coarse:min-h-11"
            aria-expanded={open}
        >
            <span class="inline-block motion-safe:transition-transform {open ? 'rotate-90' : ''}"
                >›</span
            >
            Bookmarks
        </button>
        {#if bookmarks.length > 0}
            <button
                type="button"
                data-testid="bookmarks-remove-all"
                onclick={removeAll}
                class="shrink-0 rounded px-1.5 py-0.5 text-sm text-(--gk-text-subtle) hover:bg-(--gk-surface-2) hover:text-(--gk-text-default) pointer-coarse:min-h-11"
                >Remove all</button
            >
        {/if}
    </div>
    {#if open}
        <div data-testid="bookmarks-list">
            {#each groups as group (group.key)}
                {@const groupOpen = isOpen(group.key)}
                <div class="group/head relative">
                    <button
                        type="button"
                        data-testid="bookmark-group"
                        data-bookmark-focus
                        {@attach menuOn({ kind: "bookmark-group", concept: group.concept })}
                        onclick={() => toggleGroup(group.key)}
                        aria-expanded={groupOpen}
                        class="flex w-full items-center gap-1 rounded-md py-1 pr-8 pl-4 text-left text-sm font-medium text-(--gk-text-muted) hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
                        title={group.concept}
                    >
                        <span
                            class="inline-block motion-safe:transition-transform {groupOpen
                                ? 'rotate-90'
                                : ''}">›</span
                        >
                        <span class="min-w-0 flex-1 truncate">{group.concept}</span>
                        <span class="shrink-0 text-(--gk-text-subtle)">{group.items.length}</span>
                    </button>
                    <button
                        type="button"
                        data-testid="bookmark-group-menu"
                        aria-label="Actions for the bookmarks in {group.concept}"
                        onclick={(e) => menuFromButton(e, { kind: "bookmark-group", concept: group.concept })}
                        class="absolute top-1/2 right-1 -translate-y-1/2 rounded px-1 text-(--gk-text-subtle) opacity-0 group-hover/head:opacity-100 focus:opacity-100 hover:bg-(--gk-surface-2) max-lg:opacity-100"
                        >⋯</button
                    >
                </div>
                {#if groupOpen}
                    <ul>
                        {#each group.items as bookmark (bookmark.id)}
                            <li class="group/row relative">
                                {#if editingId === bookmark.id}
                                    <div class="py-1 pr-2 pl-8">
                                        <input
                                            type="text"
                                            data-testid="bookmark-label-input"
                                            aria-label="Label for this bookmark"
                                            aria-describedby="bookmark-label-hint-{bookmark.id}"
                                            aria-invalid={labelError !== ""}
                                            placeholder={bookmark.text}
                                            maxlength={MAX_LABEL}
                                            bind:value={labelDraft}
                                            onkeydown={onLabelKeydown}
                                            onblur={onLabelBlur}
                                            {@attach focusOnMount}
                                            class="w-full rounded border border-(--gk-border-strong) bg-(--gk-surface-0) px-1.5 py-0.5 text-sm"
                                        />
                                        <p
                                            id="bookmark-label-hint-{bookmark.id}"
                                            class="mt-0.5 text-sm text-(--gk-text-subtle)"
                                            aria-live="polite"
                                        >
                                            {#if labelError}
                                                <span class="text-(--gk-text-danger)">{labelError}</span>
                                            {:else}
                                                Enter saves, Esc cancels. Leave it empty to show the line.
                                            {/if}
                                        </p>
                                    </div>
                                {:else}
                                    <button
                                        type="button"
                                        data-testid="bookmark-row"
                                        data-bookmark-id={bookmark.id}
                                        data-bookmark-focus
                                        {@attach menuOn({ kind: "bookmark", id: bookmark.id })}
                                        onclick={() => execute(BOOKMARK_OPEN, { kind: "bookmark", id: bookmark.id })}
                                        class="flex w-full touch-manipulation items-start gap-1.5 rounded-md py-1.5 pr-8 pl-8 text-left text-sm hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
                                        title={bookmark.label ? `${bookmark.label}: ${bookmark.text}` : bookmark.text}
                                    >
                                        <span class="mt-0.5 inline-flex shrink-0 text-(--gk-text-subtle)" aria-hidden="true">
                                            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                            {@html iconSvg("bookmark", { size: 13 })}
                                        </span>
                                        <span class="min-w-0 flex-1">
                                            <span class="block truncate">{bookmark.label ?? bookmark.text}</span>
                                            {#if bookmark.label}
                                                <!-- The line under its label, in reach of a keyboard and a finger, not only a hover. -->
                                                <span class="block truncate text-sm text-(--gk-text-subtle)" data-testid="bookmark-line-text">{bookmark.text}</span>
                                            {/if}
                                            {#if missing.has(bookmark.id)}
                                                <span
                                                    class="block text-sm text-(--gk-text-subtle)"
                                                    data-testid="bookmark-missing">Line not found</span
                                                >
                                            {/if}
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        data-testid="bookmark-menu"
                                        aria-label="Actions for this bookmark"
                                        onclick={(e) => menuFromButton(e, { kind: "bookmark", id: bookmark.id })}
                                        class="absolute top-1.5 right-1 rounded px-1 text-(--gk-text-subtle) opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:bg-(--gk-surface-2) max-lg:opacity-100"
                                        >⋯</button
                                    >
                                {/if}
                            </li>
                        {/each}
                    </ul>
                {/if}
            {:else}
                <p class="px-6 py-1 text-sm text-(--gk-text-subtle)" data-testid="bookmarks-empty">
                    To bookmark a line, right-click it or press {toggleChord}. On a phone, type / on the
                    line and choose Toggle bookmark.
                </p>
            {/each}
        </div>
    {/if}
</section>
