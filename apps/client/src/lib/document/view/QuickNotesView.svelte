<script lang="ts">
    /**
     * The [[Quick Notes View]] (CONTEXT.md; ADR 0078): a box to put a thought down without
     * first choosing where it belongs, the list of thoughts not yet moved (newest first), and
     * the one action that moves them all into today's [[Journal Entry]] under the day each was
     * written. A resident of the left [[Sidebar]] beside the graph sidebar.
     *
     * Mounted through the dockview adapter, so it reads its services via module accessors
     * rather than Svelte context (a separate Svelte root has none to inherit). Writes go
     * through the shared store (`quick-notes.ts`), which the workspace has wired to whichever
     * backend it opened; the move goes through its [[Command]], so a refusal reaches the user
     * the same way from the button, the Command Menu and a keybinding.
     */
    import { onDestroy, onMount } from "svelte";

    import type { ViewRef } from "$lib/layout";
    import { tryGetActiveCommandRegistry, tryGetActiveEventBus } from "$lib/surface";

    import { QUICK_NOTES_MOVE } from "../commands/quick-notes-commands";
    import {
        MAX_QUICK_NOTE_LENGTH,
        addQuickNote,
        getQuickNoteDraft,
        type QuickNote,
        removeQuickNotes,
        setQuickNoteDraft,
        subscribeQuickNoteDraft,
        subscribeQuickNotes,
        takeQuickNoteFocusRequest,
    } from "../quick-notes";

    const { view: _view }: { view: ViewRef } = $props();

    let notes = $state.raw<QuickNote[]>([]);
    /** The box's text. Seeded from the per-graph draft so leaving the tab keeps it. */
    let text = $state(getQuickNoteDraft());
    let textarea = $state<HTMLTextAreaElement | undefined>();
    let moving = $state(false);
    /** Ids whose delete is in flight, so a row cannot be deleted twice while its write lands. */
    let deleting = $state.raw<ReadonlySet<string>>(new Set());
    /** What the last action did, for the screen reader; visible things confirm in place. */
    let announcement = $state("");

    const canAdd = $derived(text.trim() !== "");
    const count = $derived(notes.length);
    /**
     * `maxlength` cuts a long paste without a word, so the count appears as the box nears the
     * cap: "10,000 / 10,000" is what a cut paste reads, and nothing nags a short note.
     */
    const nearCap = $derived(text.length >= MAX_QUICK_NOTE_LENGTH * 0.9);

    /**
     * The move's Command is registered by the workspace; the dev harness mounts this View
     * without one. Read once at mount, like the graph sidebar's settings command.
     */
    const hasMoveCommand = tryGetActiveCommandRegistry()?.has(QUICK_NOTES_MOVE) ?? false;

    // The local time the note was written, in the reader's locale. The day is what tells
    // them which `[[date]]` block it will land under, so it is always shown; the year only
    // when it is not this year. Built at render, never cached: tabs are left open for days.
    const sameYear = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
    });
    const otherYear = new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
    function writtenAt(createdAt: number): string {
        const date = new Date(createdAt);
        return (date.getFullYear() === new Date().getFullYear() ? sameYear : otherYear).format(date);
    }

    function onInput() {
        setQuickNoteDraft(text);
    }

    function clear() {
        text = "";
        setQuickNoteDraft("");
        textarea?.focus();
    }

    /**
     * The box clears at submit, not when the write lands: the write is asynchronous (a file
     * on a Filesystem Backend), and clearing afterwards would wipe whatever the user had
     * started typing next. The note is already in the list optimistically, so the box is
     * free. On a refused write the submitted text comes back - into an empty box only,
     * because a box the user has since typed into is theirs, and the announcement carries
     * the rest.
     *
     * Not guarded against an add already in flight: a second Enter while the first write is
     * still landing is a second note, not a repeat (the box was empty, so it cannot be the
     * same text), and swallowing it lost notes typed in quick succession. Each add is its own
     * note with its own id; the store tolerates the overlap.
     */
    async function add() {
        if (!canAdd) return;
        const submitted = text;
        text = "";
        setQuickNoteDraft("");
        try {
            const added = await addQuickNote(submitted);
            announcement = added ? "Note added" : "";
        } catch (err) {
            if (text === "") {
                text = submitted;
                setQuickNoteDraft(submitted);
            }
            announcement = `Could not add the note: ${(err as Error).message}`;
        } finally {
            textarea?.focus();
        }
    }

    /** Enter adds, Shift+Enter breaks a line - the outliner's own convention, so it needs no learning. */
    function onKeydown(event: KeyboardEvent) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void add();
        }
    }

    async function remove(note: QuickNote) {
        if (deleting.has(note.id)) return;
        deleting = new Set([...deleting, note.id]);
        try {
            await removeQuickNotes([note.id]);
            announcement = "Note deleted";
        } catch (err) {
            announcement = `Could not delete the note: ${(err as Error).message}`;
        } finally {
            const next = new Set(deleting);
            next.delete(note.id);
            deleting = next;
        }
    }

    async function move() {
        if (moving || count === 0) return;
        moving = true;
        try {
            // The Command reports its own outcome (a notice either way) and opens the entry.
            await tryGetActiveCommandRegistry()?.execute(QUICK_NOTES_MOVE);
        } finally {
            moving = false;
        }
    }

    /** How long a reveal is given to paint the tab before the caret stops trying to land. */
    const FOCUS_RETRY_MS = 1000;

    /**
     * Focus the box, retrying frame by frame for a bounded time. The renderer reveals a newly
     * activated tab asynchronously, and `focus()` on an element that is not yet displayed is a
     * silent no-op - so one call right after the Event lands in the still-hidden panel and
     * nothing happens. Bounded by time rather than by a count of frames: under load a frame
     * count runs out before the tab has painted, and the caret never lands.
     */
    function focusBox(deadline = performance.now() + FOCUS_RETRY_MS) {
        const box = textarea;
        if (!box) return;
        box.focus();
        if (document.activeElement === box || performance.now() >= deadline) return;
        requestAnimationFrame(() => focusBox(deadline));
    }

    const unsubscribers: (() => void)[] = [];
    onMount(() => {
        unsubscribers.push(subscribeQuickNotes((next) => (notes = next)));
        // Text put in the box from outside: a shared text whose write was refused (ADR 0087).
        // The module has already merged it after whatever the box held; this is the whole draft.
        unsubscribers.push(
            subscribeQuickNoteDraft((whole) => {
                text = whole;
                announcement = "The shared text is in the box";
            }),
        );
        // Opened by the reveal Command: it emitted its focus Event before this View existed, and
        // left the request here instead.
        if (takeQuickNoteFocusRequest()) focusBox();
        const bus = tryGetActiveEventBus();
        if (bus) {
            // The `quickNotes.open` Command (Alt+N): the workspace has focused the tab; the
            // caret is this View's to place, once the tab switch has painted.
            unsubscribers.push(bus.on("quick-notes:focus", () => focusBox()));
        }
    });
    onDestroy(() => {
        for (const off of unsubscribers) off();
    });
</script>

<div
    class="flex h-full flex-col gap-2 p-2 text-(--gk-text-default)"
    style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
    data-testid="quick-notes"
>
    <span class="sr-only" aria-live="polite" data-testid="quick-notes-announcement">{announcement}</span>

    <!-- ── Move ───────────────────────────────────────────────────────────────── -->
    <!-- Disabled only while there is nothing to move: the empty list below says why. -->
    <button
        type="button"
        data-testid="quick-notes-move"
        onclick={move}
        disabled={count === 0 || moving || !hasMoveCommand}
        aria-busy={moving}
        class="flex w-full items-center justify-center gap-2 rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5 text-sm font-medium text-(--gk-text-strong) hover:bg-(--gk-surface-2) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-(--gk-surface-1)"
    >
        <svg
            class="h-4 w-4 shrink-0 text-(--gk-text-subtle)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
        >
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0V11.25A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"
            />
        </svg>
        {moving ? "Moving…" : `Move all to today's journal${count > 0 ? ` (${count})` : ""}`}
    </button>

    <!-- ── Input ──────────────────────────────────────────────────────────────── -->
    <div class="flex flex-col gap-1.5">
        <textarea
            bind:this={textarea}
            bind:value={text}
            oninput={onInput}
            onkeydown={onKeydown}
            data-testid="quick-notes-input"
            aria-label="New quick note"
            aria-describedby="quick-notes-hint"
            placeholder="Jot something down…"
            rows="3"
            maxlength={MAX_QUICK_NOTE_LENGTH}
            spellcheck="false"
            class="w-full resize-y rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5 text-sm text-(--gk-text-strong) placeholder:text-(--gk-text-subtle) focus:border-(--gk-border-strong) focus:outline-none"
        ></textarea>
        <span id="quick-notes-hint" class="sr-only">Enter adds the note; Shift+Enter starts a new line.</span>
        {#if nearCap}
            <p class="text-sm text-(--gk-text-muted)" data-testid="quick-notes-length" role="status">
                {text.length.toLocaleString()} / {MAX_QUICK_NOTE_LENGTH.toLocaleString()} characters
            </p>
        {/if}
        <div class="flex items-center justify-between gap-2">
            <button
                type="button"
                data-testid="quick-notes-clear"
                onclick={clear}
                disabled={text === ""}
                class="rounded-md px-2 py-1 text-sm text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
            >
                Clear
            </button>
            <button
                type="button"
                data-testid="quick-notes-add"
                onclick={add}
                disabled={!canAdd}
                class="rounded-md bg-(--gk-accent) px-3 py-1 text-sm font-medium text-white hover:bg-(--gk-accent-hover) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-(--gk-accent)"
            >
                Add
            </button>
        </div>
    </div>

    <!-- ── The notes, newest first ────────────────────────────────────────────── -->
    {#if count === 0}
        <p class="px-2 py-4 text-center text-sm text-(--gk-text-muted)" data-testid="quick-notes-empty">
            No quick notes yet. Anything you add here waits until you move it to today's journal.
        </p>
    {:else}
        <ul class="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" data-testid="quick-notes-list" aria-label="Quick notes">
            {#each notes as note (note.id)}
                <li
                    class="group/note rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5"
                    data-testid="quick-notes-row"
                    data-note-id={note.id}
                >
                    <p class="text-sm whitespace-pre-wrap break-words text-(--gk-text-strong)" data-testid="quick-notes-text">{note.text}</p>
                    <div class="mt-1 flex items-center justify-between gap-2">
                        <time
                            datetime={new Date(note.createdAt).toISOString()}
                            class="text-sm text-(--gk-text-muted)"
                            data-testid="quick-notes-date">{writtenAt(note.createdAt)}</time
                        >
                        <!-- Always in the DOM (a touch screen has no hover); quiet until the row is
                             hovered or the button itself is focused. -->
                        <button
                            type="button"
                            data-testid="quick-notes-delete"
                            onclick={() => remove(note)}
                            disabled={deleting.has(note.id)}
                            aria-label="Delete note"
                            title="Delete note"
                            class="rounded-md px-1.5 py-0.5 text-sm text-(--gk-text-subtle) opacity-70 hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) hover:opacity-100 focus-visible:opacity-100 disabled:opacity-40 motion-safe:transition-opacity"
                        >
                            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M6 18L18 6" />
                            </svg>
                        </button>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</div>
