<script lang="ts">
    /**
     * The [[Quick Notes Modal]] (CONTEXT.md; ADR 0078, ADR 0189): a box to put a thought down
     * without first choosing where it belongs, the list of thoughts not yet moved (newest
     * first), and the one action that moves them all into today's [[Journal Entry]] under the
     * day each was written. A dialog over the workspace, opened by the graph [[Sidebar]]'s
     * button and the `quickNotes.open` Command (Alt+N).
     *
     * The workspace mounts it once for the open graph and only changes `open`, so what is in
     * the box when the dialog is dismissed (text, chosen files, the Favourite, the task tick)
     * is there when it opens again. It reads its services through the module accessors, as
     * the Views do. Writes go through the shared store (`quick-notes.ts`), which the workspace
     * has wired to whichever backend it opened; the move goes through its [[Command]], so a
     * refusal reaches the user the same way from the button, the Command Menu and a keybinding.
     *
     * The box is `QuickNoteBox`, the one the [[Share Target]]'s page uses (ADR 0186): it links
     * to a page, takes files, and a note can be filed under one of the person's [[Favourite]]s.
     * A file is stored as an [[Asset]] when the note is added, and its reference is a line of
     * the note's text.
     */
    import { onDestroy, onMount, tick } from "svelte";
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";

    import InstallOffer from "#lib/install/InstallOffer.svelte";
    import { iconSvg } from "#lib/surface/icons.js";
    import { tryGetActiveCommandRegistry } from "#lib/surface/index.js";

    import { tryGetActiveAssetStore } from "../active-asset-store";
    import { getActiveGraphIndex } from "../backlinks";
    import { QUICK_NOTES_MOVE } from "../commands/quick-notes-commands";
    import { subscribeFavourites } from "../favourites";
    import { NoteFileError, storeNoteFiles } from "../quick-note-file-store";
    import { quickNoteParts, quickNoteTask } from "../quick-note-files";
    import { fileUnderChoices } from "../quick-note-filing";
    import {
        MAX_QUICK_NOTE_LENGTH,
        addQuickNote,
        discardQuickNotes,
        getQuickNoteDraft,
        getQuickNotes,
        type QuickNote,
        setQuickNoteDraft,
        subscribeQuickNoteDraft,
        subscribeQuickNotes,
    } from "../quick-notes";
    import { shareNoteTextWithFiles } from "../share-target";
    import { defaultMaxImageDisplaySize } from "./asset-upload";
    import QuickNoteAsset from "./QuickNoteAsset.svelte";
    import QuickNoteBox from "./QuickNoteBox.svelte";
    import QuickNoteFileUnder from "./QuickNoteFileUnder.svelte";
    import { PendingNoteFiles } from "./quick-note-pending-files.svelte";

    const {
        open,
        focusBox = true,
        onclose,
    }: {
        open: boolean;
        /**
         * Whether opening puts the caret in the box. False when a [[Share Target]] share opens
         * the dialog: on a phone the caret raises the keyboard over the note that just landed,
         * so focus goes to the list instead.
         */
        focusBox?: boolean;
        onclose: () => void;
    } = $props();

    let notes = $state.raw<QuickNote[]>([]);
    /** The box's text. Seeded from the per-graph draft, where a refused share's text waits. */
    let text = $state(getQuickNoteDraft());
    let box = $state<QuickNoteBox | undefined>();
    /** The notes' list, which takes focus when the box should not (see `focusBox`, `remove`). */
    let list = $state<HTMLUListElement | undefined>();
    /** Files chosen for the note in the box, stored when it is added. */
    const pending = new PendingNoteFiles();
    /** The concepts a note can be filed under: the person's Favourites, in their order. */
    let fileUnder = $state.raw<string[]>([]);
    /** The one chosen for the note in the box, or none. */
    let under = $state<string | null>(null);
    /** Whether the note in the box is added as a [[Task]]. Unchecked again after each add. */
    let asTask = $state(false);
    /** Notes whose files are still being stored: the count shows under the box. */
    let storing = $state(0);
    /** Why the last add did not happen, shown under the box until the next one. */
    let addError = $state("");
    let moving = $state(false);
    /** Ids whose delete is in flight, so a row cannot be deleted twice while its write lands. */
    let deleting = $state.raw<ReadonlySet<string>>(new Set());
    /** What the last action did, for the screen reader; visible things confirm in place. */
    let announcement = $state("");

    const canAdd = $derived(text.trim() !== "" || pending.count > 0);
    /** A graph with no store for files (the dev harness) takes none. */
    const takesFiles = tryGetActiveAssetStore() !== null;
    const count = $derived(notes.length);
    /**
     * `maxlength` cuts a long paste without a word, so the count appears as the box nears the
     * cap: "10,000 / 10,000" is what a cut paste reads, and nothing nags a short note.
     */
    const nearCap = $derived(text.length >= MAX_QUICK_NOTE_LENGTH * 0.9);

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

    function onInput() {
        setQuickNoteDraft(text);
    }

    function clear() {
        text = "";
        setQuickNoteDraft("");
        pending.clear();
        under = null;
        asTask = false;
        addError = "";
        box?.focus();
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
        const files = pending.take();
        const filed = under;
        const task = asTask;
        text = "";
        under = null;
        asTask = false;
        addError = "";
        setQuickNoteDraft("");
        try {
            // A task's checkbox is the note's own text, as on the share page (`shareNoteText`).
            const noteText = files.length === 0 ? shareNoteTextWithFiles(submitted, [], task) : await withFiles(submitted, files, task);
            const added = await addQuickNote(noteText, { under: filed });
            announcement = added ? "Note added" : "";
        } catch (err) {
            // The text and the files come back into an empty box only: a box the user has since
            // typed into is theirs. A file already stored is named, since nothing references it.
            if (text === "" && pending.count === 0) {
                text = submitted;
                setQuickNoteDraft(submitted);
                pending.add(files);
                under = filed;
                asTask = task;
            }
            const stored = err instanceof NoteFileError ? err.stored.map((asset) => asset.name) : [];
            addError =
                `Could not add the note: ${(err as Error).message}` +
                (stored.length > 0 ? ` ${stored.join(", ")} was stored and is not in any note.` : "");
            announcement = addError;
        } finally {
            box?.focus();
        }
    }

    /**
     * Store the files and write their references after the text. The box is already clear, so a
     * line under it says files are being stored: a photo takes a moment to re-encode.
     */
    async function withFiles(submitted: string, files: File[], task: boolean): Promise<string> {
        const store = tryGetActiveAssetStore();
        if (!store) throw new Error("this graph cannot store files.");
        storing += 1;
        try {
            const saved = await storeNoteFiles(files, store);
            return shareNoteTextWithFiles(submitted, saved, task, defaultMaxImageDisplaySize());
        } finally {
            storing -= 1;
        }
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
            announcement = "Note deleted";
        } catch (err) {
            announcement = `Could not delete the note: ${(err as Error).message}`;
        } finally {
            const next = new Set(deleting);
            next.delete(note.id);
            deleting = next;
        }
        // The pressed button went with its row. Focus stays in the dialog, so Tab keeps cycling
        // inside it: on the notes left, or in the box when that was the last one. Not the box
        // while notes remain, which on a phone would raise the keyboard after every delete.
        await tick();
        if (open && document.activeElement === document.body) (list ?? box)?.focus();
    }

    async function move() {
        if (moving || count === 0) return;
        moving = true;
        try {
            // The Command reports its own outcome (a notice either way) and opens the entry.
            await tryGetActiveCommandRegistry()?.execute(QUICK_NOTES_MOVE);
            // The entry the notes went to is open behind the dialog, so the dialog gets out of
            // its way. A refused move leaves the notes here and says why in a notice.
            if (getQuickNotes().length === 0) onclose();
        } finally {
            moving = false;
        }
    }

    /**
     * Put the caret in the box of a dialog that is already open: Alt+N pressed again. Opening
     * the dialog places focus itself (the shell's focus contract).
     */
    export function focusInput() {
        box?.focus();
    }

    const unsubscribers: (() => void)[] = [];
    onMount(() => {
        unsubscribers.push(subscribeQuickNotes((next) => (notes = next)));
        unsubscribers.push(subscribeFavourites((favourites) => (fileUnder = fileUnderChoices(favourites))));
        // Text put in the box from outside: a shared text whose write was refused (ADR 0087).
        // The module has already merged it after whatever the box held; this is the whole draft.
        unsubscribers.push(
            subscribeQuickNoteDraft((whole) => {
                text = whole;
                announcement = "The shared text is in the box";
            }),
        );
    });
    onDestroy(() => {
        pending.clear();
        for (const off of unsubscribers) off();
    });
</script>

<!-- `top`: the list grows and shrinks under the box, and a centred panel would move the box
     with every note. No `onsubmit`: Enter adds from the box itself, and nothing else submits. -->
<Dialog {open} title="Quick notes" size="lg" placement="top" testId="quick-notes-modal" {onclose}>
    <!-- The Sidebar button's own picture, so the dialog reads as what that button opened. -->
    {#snippet icon()}
        <!-- Markup from the Client's icon table, never user or document content. -->
        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
        {@html iconSvg("quick-notes", { size: 18 })}
    {/snippet}
    {#snippet body()}
        <div
            class="flex flex-col gap-2 text-(--gk-text-default)"
            style:font-family="var(--gk-sans, 'Inter', system-ui, sans-serif)"
            data-testid="quick-notes"
        >
            <span class="sr-only" aria-live="polite" data-testid="quick-notes-announcement">{announcement}</span>

            <!-- ── Move ───────────────────────────────────────────────────────────────── -->
            <!-- Disabled only while there is nothing to move: the empty list below says why. A grey
                 fill from the theme's own tokens, the Sidebar buttons' look, so Add is the one
                 accent-coloured action in the dialog. -->
            <button
                type="button"
                data-testid="quick-notes-move"
                onclick={move}
                disabled={count === 0 || moving || !hasMoveCommand}
                aria-busy={moving}
                class="flex w-full items-center justify-center gap-2 rounded-md border border-transparent bg-(--gk-surface-2) px-3 py-1.5 text-sm font-medium text-(--gk-text-strong) hover:bg-(--gk-border-strong) disabled:cursor-default disabled:text-(--gk-text-muted) disabled:hover:bg-(--gk-surface-2) pointer-coarse:min-h-11"
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
            <div class="flex flex-col gap-1.5">
                <QuickNoteBox
                    bind:this={box}
                    bind:value={text}
                    testid="quick-notes-input"
                    label="New quick note"
                    placeholder="Create a quick note…"
                    describedBy="quick-notes-hint"
                    maxlength={MAX_QUICK_NOTE_LENGTH}
                    concepts={() => getActiveGraphIndex()?.allConcepts() ?? []}
                    files={pending.shown}
                    onaddfiles={takesFiles ? (files) => pending.add(files) : undefined}
                    onremovefile={(id) => pending.remove(id)}
                    oninput={onInput}
                    onkey={onKey}
                >
                    <!-- In the box's own button row, at its right end. -->
                    {#snippet tools()}
                        <label class="flex w-fit cursor-pointer items-center gap-2 [-webkit-tap-highlight-color:transparent] pointer-coarse:min-h-11">
                            <input type="checkbox" bind:checked={asTask} data-testid="quick-notes-task" class="size-4 shrink-0 accent-(--gk-accent)" />
                            <span class="text-sm text-(--gk-text-default)">Add as task</span>
                        </label>
                    {/snippet}
                </QuickNoteBox>
                <span id="quick-notes-hint" class="sr-only">Enter adds the note, Shift+Enter starts a new line.</span>
                {#if nearCap}
                    <p class="text-sm text-(--gk-text-muted)" data-testid="quick-notes-length" role="status">
                        {text.length.toLocaleString()} / {MAX_QUICK_NOTE_LENGTH.toLocaleString()} characters
                    </p>
                {/if}
                <QuickNoteFileUnder choices={fileUnder} bind:selected={under} testid="quick-notes-under" />
                {#if storing > 0}
                    <p class="text-sm text-(--gk-text-muted)" role="status" data-testid="quick-notes-storing">Storing files…</p>
                {/if}
                {#if addError}
                    <p class="text-sm text-(--gk-text-danger)" role="alert" data-testid="quick-notes-add-error">{addError}</p>
                {/if}
                <div class="flex items-center justify-between gap-2">
                    <button
                        type="button"
                        data-testid="quick-notes-clear"
                        onclick={clear}
                        disabled={text === "" && pending.count === 0 && under === null && !asTask}
                        class="rounded-md px-2 py-1 text-sm text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent pointer-coarse:min-h-11"
                    >
                        Clear
                    </button>
                    <button
                        type="button"
                        data-testid="quick-notes-add"
                        onclick={add}
                        disabled={!canAdd}
                        class="inline-flex items-center gap-1.5 rounded-md bg-(--gk-accent) py-1.5 pr-5 pl-4 text-sm font-medium text-(--gk-surface-0) hover:bg-(--gk-accent-hover) disabled:cursor-default disabled:opacity-50 disabled:hover:bg-(--gk-accent) pointer-coarse:min-h-11"
                    >
                        <!-- heroicons/outline plus. A little less padding on its side than after
                             the word, so the two ends look the same. -->
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
                <!-- Where focus lands when a share opened the dialog (`focusBox`): on the notes, not in the
                     box. The dialog scrolls as one, so the list has no scroller of its own. -->
                <ul
                    bind:this={list}
                    class="flex flex-col gap-1 outline-none"
                    data-testid="quick-notes-list"
                    aria-label="Quick notes"
                    tabindex="-1"
                    data-autofocus={focusBox ? undefined : ""}
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
                                title="Delete note"
                                class="absolute top-1 right-1 inline-flex items-center justify-center rounded-md p-1.5 text-(--gk-text-subtle) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) disabled:opacity-40 pointer-coarse:top-0 pointer-coarse:right-0 pointer-coarse:size-11"
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
    {/snippet}
</Dialog>
