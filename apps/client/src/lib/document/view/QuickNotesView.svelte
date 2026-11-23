<script lang="ts">
    /**
     * The [[Quick Notes View]] (CONTEXT.md; ADR 0078, ADR 0200): a box to put a thought down
     * without first choosing where it belongs, the list of thoughts not yet moved (newest
     * first), and the one action that moves them all into today's [[Journal Entry]] under the
     * day each was written. A resident of the [[Primary Sidebar]], chosen from its icon in the
     * [[Activity Bar]] or with Alt+N.
     *
     * What is in the box (text, chosen files, the Favourite, the task tick) is not this
     * component's: `noteInProgress` holds it for the open graph, so it outlives a View that is
     * hidden, or that the phone's drawer unmounts to show another.
     *
     * Mounted through the Layout's renderer, so it reads its services through the module
     * accessors. Writes go through the shared store (`quick-notes.ts`), which the workspace has
     * wired to whichever backend it opened; the move goes through its [[Command]], so a refusal
     * reaches the user the same way from the button, the Command Menu and a keybinding.
     *
     * The box is `QuickNoteBox`, the one the [[Share Target]]'s page uses (ADR 0186): it links
     * to a page, takes files, and a note can be filed under one of the person's [[Favourite]]s.
     * A file is stored as an [[Asset]] when the note is added, and its reference is a line of
     * the note's text.
     */
    import { onDestroy, onMount, tick, untrack } from "svelte";

    import InstallOffer from "#lib/install/InstallOffer.svelte";
    import type { ViewProps } from "#lib/layout/index.js";
    import { tryGetActiveCommandRegistry } from "#lib/surface/index.js";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import { getActiveGraphIndex } from "../backlinks";
    import { QUICK_NOTES_MOVE } from "../commands/quick-notes-commands";
    import { subscribeFavourites } from "../favourites";
    import { noteInProgress, type QuickNotesFocus } from "../note-in-progress";
    import { quickNoteParts, quickNoteTask } from "../quick-note-files";
    import { fileUnderChoices } from "../quick-note-filing";
    import { MAX_QUICK_NOTE_LENGTH, discardQuickNotes, type QuickNote, subscribeQuickNotes } from "../quick-notes";
    import { defaultMaxImageDisplaySize } from "./asset-upload";
    import QuickNoteAsset from "./QuickNoteAsset.svelte";
    import QuickNoteBox from "./QuickNoteBox.svelte";
    import QuickNoteFileUnder from "./QuickNoteFileUnder.svelte";

    // Every View is handed its ViewRef; this one is the only one of its kind.
    let { view: _view }: ViewProps = $props();

    /** The note being written, kept for the graph rather than for this component. */
    const writing = noteInProgress;

    let notes = $state.raw<QuickNote[]>([]);
    let box = $state<QuickNoteBox | undefined>();
    /** The notes' list, which takes focus when the box should not (see `takeFocus`, `remove`). */
    let list = $state<HTMLUListElement | undefined>();
    let root = $state<HTMLElement | undefined>();
    /** The concepts a note can be filed under: the person's Favourites, in their order. */
    let fileUnder = $state.raw<string[]>([]);
    let moving = $state(false);
    /** Ids whose delete is in flight, so a row cannot be deleted twice while its write lands. */
    let deleting = $state.raw<ReadonlySet<string>>(new Set());

    /** A graph with no store for files (the dev harness) takes none. */
    const takesFiles = tryGetActiveAssetStore() !== null;
    const count = $derived(notes.length);
    /**
     * `maxlength` cuts a long paste without a word, so the count appears as the box nears the
     * cap: "10,000 / 10,000" is what a cut paste reads, and nothing nags a short note.
     */
    const nearCap = $derived(writing.text.length >= MAX_QUICK_NOTE_LENGTH * 0.9);

    /**
     * The move's Command is registered by the workspace. Read once at mount, like the graph
     * sidebar's settings command.
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

    function clear() {
        writing.clear();
        box?.focus();
    }

    async function add() {
        if (!writing.canAdd) return;
        const added = writing.add({ assets: tryGetActiveAssetStore, imageSize: defaultMaxImageDisplaySize });
        // Back to the box, which is empty already: the next thought need not wait for the write.
        box?.focus();
        await added;
    }

    /** Enter adds, Shift+Enter breaks a line - the outliner's own convention, so it needs no learning. */
    function onKey(event: KeyboardEvent): boolean {
        if (event.key !== "Enter" || event.shiftKey) return false;
        void add();
        return true;
    }

    async function remove(note: QuickNote) {
        if (deleting.has(note.id)) return;
        deleting = new Set([...deleting, note.id]);
        try {
            await discardQuickNotes([note.id]);
            writing.announcement = "Note deleted";
        } catch (err) {
            writing.announcement = `Could not delete the note: ${(err as Error).message}`;
        } finally {
            const next = new Set(deleting);
            next.delete(note.id);
            deleting = next;
        }
        // The pressed button went with its row. Focus stays in the View: on the notes left, or in
        // the box when that was the last one. Not the box while notes remain, which on a phone
        // would raise the keyboard after every delete.
        await tick();
        if (root?.isConnected && document.activeElement === document.body) (list ?? box)?.focus();
    }

    async function move() {
        if (moving || count === 0) return;
        moving = true;
        try {
            // The Command reports its own outcome (a notice either way) and opens the entry, which
            // on a phone closes the drawer this is in. A refused move leaves the notes here.
            await tryGetActiveCommandRegistry()?.execute(QUICK_NOTES_MOVE);
        } finally {
            moving = false;
        }
    }

    /** How long a reveal is given to put the View on screen before the keyboard stops trying to land. */
    const FOCUS_RETRY_MS = 1000;
    let focusFrame = 0;

    /**
     * Put the keyboard where the workspace asked (`noteInProgress.askFocus`): in the box for
     * Alt+N and New quick note, on the list for a share that landed, where the caret would raise
     * a phone's keyboard over the note. Retried frame by frame, because the renderer reveals a
     * View after it is brought forward and `focus()` on an element not yet displayed does nothing.
     * Bounded by time rather than by frames: under load a count of frames runs out first. With no
     * note in the list (a share whose write was refused, its text in the box) there is nothing to
     * focus but the box, and that is left for the person to choose.
     */
    function takeFocus(on: QuickNotesFocus, deadline = performance.now() + FOCUS_RETRY_MS) {
        cancelAnimationFrame(focusFrame);
        const target = on === "box" ? box : list;
        target?.focus();
        const landed = on === "box" ? document.activeElement?.getAttribute("data-testid") === "quick-notes-input" : list !== undefined && document.activeElement === list;
        if (landed || performance.now() >= deadline) {
            writing.focusTaken();
            return;
        }
        focusFrame = requestAnimationFrame(() => takeFocus(on, deadline));
    }

    // Asked of the View from outside it, before or after it mounts; answered once per request.
    $effect(() => {
        const asked = writing.focusAsked;
        if (asked) untrack(() => takeFocus(asked));
    });

    const unsubscribers: (() => void)[] = [];
    onMount(() => {
        unsubscribers.push(subscribeQuickNotes((next) => (notes = next)));
        unsubscribers.push(subscribeFavourites((favourites) => (fileUnder = fileUnderChoices(favourites))));
    });
    onDestroy(() => {
        cancelAnimationFrame(focusFrame);
        for (const off of unsubscribers) off();
    });
</script>

<!-- The View scrolls as one, so the box, the files chosen and the notes share the height there is:
     on a phone the keyboard takes half of it. The padding is inside the scroller, so nothing in the
     column is squeezed to fit. -->
<div
    bind:this={root}
    class="h-full overflow-y-auto break-words text-(--gk-text-default)"
    style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
    data-testid="quick-notes"
>
    <div class="flex flex-col gap-4 p-3">
        <span class="sr-only" aria-live="polite" data-testid="quick-notes-announcement">{writing.announcement}</span>

        <!-- ── Move ───────────────────────────────────────────────────────────────── -->
        <!-- Disabled only while there is nothing to move: the empty list below says why. A grey
             fill from the theme's own tokens, the Sidebar buttons' look, so Add is the one
             accent-coloured action in the View. -->
        <button
            type="button"
            data-testid="quick-notes-move"
            onclick={move}
            disabled={count === 0 || moving || !hasMoveCommand}
            aria-busy={moving}
            class="gk-button w-full whitespace-normal"
        >
            <svg
                class="h-4 w-4 shrink-0"
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
        <div class="flex flex-col gap-2">
            <QuickNoteBox
                bind:this={box}
                bind:value={() => writing.text, (text) => (writing.text = text)}
                testid="quick-notes-input"
                label="New quick note"
                placeholder="Create a quick note…"
                describedBy="quick-notes-hint"
                maxlength={MAX_QUICK_NOTE_LENGTH}
                concepts={() => getActiveGraphIndex()?.allConcepts() ?? []}
                files={writing.files.shown}
                onaddfiles={takesFiles ? (files) => writing.files.add(files) : undefined}
                onremovefile={(id) => writing.files.remove(id)}
                onkey={onKey}
            >
                <!-- In the box's own button row, at its right end. -->
                {#snippet tools()}
                    <label class="flex w-fit cursor-pointer items-center gap-2 [-webkit-tap-highlight-color:transparent] pointer-coarse:min-h-11">
                        <input type="checkbox" bind:checked={() => writing.asTask, (asTask) => (writing.asTask = asTask)} data-testid="quick-notes-task" class="gk-checkbox" />
                        <span class="text-sm text-(--gk-text-default)">Add as task</span>
                    </label>
                {/snippet}
            </QuickNoteBox>
            <span id="quick-notes-hint" class="sr-only">Enter adds the note, Shift+Enter starts a new line.</span>
            {#if nearCap}
                <p class="gk-hint" data-testid="quick-notes-length" role="status">
                    {writing.text.length.toLocaleString()} / {MAX_QUICK_NOTE_LENGTH.toLocaleString()} characters
                </p>
            {/if}
            <QuickNoteFileUnder choices={fileUnder} bind:selected={() => writing.under, (under) => (writing.under = under)} testid="quick-notes-under" />
            {#if writing.storing > 0}
                <p class="gk-hint" role="status" data-testid="quick-notes-storing">Storing files…</p>
            {/if}
            {#if writing.error}
                <p class="gk-error" role="alert" data-testid="quick-notes-add-error">{writing.error}</p>
            {/if}
            <div class="flex flex-wrap items-center justify-between gap-2">
                <button
                    type="button"
                    data-testid="quick-notes-clear"
                    onclick={clear}
                    disabled={writing.isEmpty}
                    class="gk-button gk-button--quiet"
                >
                    Clear
                </button>
                <button
                    type="button"
                    data-testid="quick-notes-add"
                    onclick={add}
                    disabled={!writing.canAdd}
                    class="gk-button gk-button--primary"
                >
                    <!-- heroicons/outline plus. -->
                    <svg class="size-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                    </svg>
                    Add
                </button>
            </div>
        </div>

        <!-- Sharing from other apps lands here, and needs the installed app (Android and ChromeOS). -->
        <InstallOffer
            moment="quick-notes"
            text="Install EtherPK to share text, links and files from other apps into Quick notes."
        />

        <!-- ── The notes, newest first ────────────────────────────────────────────── -->
        {#if count === 0}
            <p class="px-2 py-4 text-center text-sm text-(--gk-text-muted)" data-testid="quick-notes-empty">
                No quick notes yet. Anything you add here waits until you move it to today's journal.
            </p>
        {:else}
            <!-- Where focus lands when a share landed (`takeFocus`): on the notes, not in the box. -->
            <ul
                bind:this={list}
                class="flex flex-col gap-1 outline-none"
                data-testid="quick-notes-list"
                aria-label="Quick notes"
                tabindex="-1"
            >
                {#each notes as note (note.id)}
                    {@const task = quickNoteTask(note.text)}
                    <li
                        class="group/note relative rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) py-1.5 pr-9 pl-2 pointer-coarse:pr-12"
                        data-testid="quick-notes-row"
                        data-note-id={note.id}
                    >
                        {#if note.under}
                            <p class="mb-1 text-sm text-(--gk-text-muted)" data-testid="quick-notes-filed">
                                Under <span class="font-medium text-(--gk-text-default)">{note.under}</span>
                            </p>
                        {/if}
                        <!-- A task's checkbox is the first characters of its text (`shareNoteText`).
                             It is drawn as a box here, beside the first line, and written as it
                             is by the move. A picture, not a control: a note is ticked in the
                             journal, once it is a task there. -->
                        <div class="flex items-start gap-2">
                            {#if task}
                                <span
                                    class="inline-flex h-5 shrink-0 items-center text-(--gk-text-muted)"
                                    role="img"
                                    aria-label={task.done ? "Task, done" : "Task"}
                                    data-testid="quick-notes-task-mark"
                                    data-state={task.done ? "done" : "open"}
                                >
                                    <svg class="size-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                                        <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
                                        {#if task.done}
                                            <path stroke-linecap="round" stroke-linejoin="round" d="M5.5 8 7.3 10 10.5 5.8" />
                                        {/if}
                                    </svg>
                                </span>
                            {/if}
                            <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                                {#each quickNoteParts(task ? task.text : note.text) as part, index (index)}
                                    {#if part.kind === "text"}
                                        <p class="text-sm whitespace-pre-wrap break-words text-(--gk-text-strong)" data-testid="quick-notes-text">{part.text}</p>
                                    {:else}
                                        <QuickNoteAsset url={part.url} kind={part.kind} alt={part.kind === "image" ? part.alt : ""} />
                                    {/if}
                                {/each}
                            </div>
                        </div>
                        <time
                            datetime={new Date(note.createdAt).toISOString()}
                            class="mt-1 block text-sm text-(--gk-text-muted)"
                            data-testid="quick-notes-date">{writtenAt(note.createdAt)}</time
                        >
                        <!-- In the row's top right corner, where a panel's close button is looked
                             for; the row's right padding keeps the note's text clear of it. After
                             the text in the DOM, so a screen reader hears the note before its
                             delete. Always drawn: a touch screen has no hover. -->
                        <button
                            type="button"
                            data-testid="quick-notes-delete"
                            onclick={() => remove(note)}
                            disabled={deleting.has(note.id)}
                            aria-label="Delete note"
                            data-tooltip="Delete note"
                            class="gk-icon-button absolute top-1 right-1 pointer-coarse:top-0 pointer-coarse:right-0"
                        >
                            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M6 18L18 6" />
                            </svg>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</div>
