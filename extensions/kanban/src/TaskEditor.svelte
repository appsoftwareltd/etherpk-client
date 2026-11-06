<script lang="ts">
    /**
     * The [[Task Editor]] (ADR 0170): a dialog over a [[Kanban Board]], or over whatever is on screen
     * when a task's line or a Tasks View row opens it (`open-task-editor.ts`), that edits one [[Task]]
     * as a title, a [[Lane]], a priority, a due and a scheduled date, [[Free Tag]]s, a description,
     * [[Asset]]s, [[Task Comment]]s and, when the task has lines below its comments, its additional
     * context. It is a way of editing the
     * task's text, never a store: every field is read from the document and written back there
     * (`task-editor-writes.ts`), and the description, comments and additional context are the
     * document's own editor, showing only those lines (`shown-range.ts`).
     *
     * Two modes:
     *
     * - **New** (a lane's "+"): a form. Nothing is written until Create task (or Ctrl/Cmd+Enter); the
     *   description is written in a document held in memory, and creating the task writes the task
     *   line and the description into today's journal entry as one change. Then the editor carries on
     *   over the task it wrote. Comments come once the task exists. Closing a form with anything in
     *   it asks first.
     * - **Editing** (a card): each field is saved as it changes, with an honest "Saving…" and
     *   "Saved". A task line changed elsewhere since it was read is never written over: the editor
     *   says so, keeps what was typed, and offers to read the task again.
     */
    import { EditorSelection } from "@codemirror/state";
    import { onDestroy, onMount, tick } from "svelte";

    import { Dialog } from "#lib/components/dialog.js";
    import { todayISO } from "#lib/document/calendar/month-grid-core.js";
    import { TASK_COPY_REFERENCE } from "#lib/document/commands/agent-instruction-commands.js";
    import { bulletLabel } from "#lib/document/index-derive.js";
    import { openConceptAtLine } from "#lib/document/open-concept.js";
    import { addTaskToJournal } from "#lib/document/task-placement.js";
    import { assetReferencesIn, newTaskLines, taskLineWithFreeTag, taskLineWithTitle } from "#lib/document/task-structure.js";
    import { type TaskPriority, type TaskStatus } from "#lib/document/task-tags.js";
    import { rewriteTaskLine, taskLineWith } from "#lib/document/task-write.js";
    import DocumentView from "#lib/document/view/DocumentView.svelte";
    import { openAssetPicker, subscribeAssetPicker } from "#lib/document/view/asset-picker.js";
    import { shownRangeIn } from "#lib/document/view/shown-range.js";
    import { taskPartRange } from "#lib/document/view/task-part-range.js";
    import type { ViewVisibility } from "#lib/layout/index.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { workspaceService } from "#lib/workspace/workspace-services.js";

    import { sameConcept } from "./board-actions";
    import { BOARD_LANES } from "./board-model";
    import {
        type ArchivedTask,
        createHeldDocument,
        DATE_FIELDS,
        type DateField,
        EMPTY_DESCRIPTION,
        freeTagProblem,
        isUntouched,
        PRIORITY_CHOICES,
        readFreeTag,
        type TaskEditorStart,
    } from "./task-editor-model";
    import { assetShown, viewTaskImages } from "./task-editor-assets";
    import { pickTaskDate } from "./task-editor-dates";
    import TaskEditorAsset from "./TaskEditorAsset.svelte";
    import TaskEditorPartBox from "./TaskEditorPartBox.svelte";
    import { addComment, addDescriptionLine, deleteTask, type ReadTask, readEditedTask, type RemovedTask, saveTaskLine, type TaskFields } from "./task-editor-writes";

    const {
        concept,
        onBoard = true,
        start,
        panelId,
        visibility,
        onclose,
        onarchived,
        ondeleted,
    }: {
        /** The board's concept, or null on the Graph Kanban (or outside a board). */
        concept: string | null;
        /**
         * Opened from a board (a card, a lane's "+"), or outside one (a task's line in an editor, a
         * Tasks View row), where the title names the task's document instead of a board.
         */
        onBoard?: boolean;
        start: TaskEditorStart;
        panelId?: string;
        visibility?: ViewVisibility;
        onclose: () => void;
        onarchived: (archived: ArchivedTask) => void;
        ondeleted: (removed: RemovedTask, label: string) => void;
    } = $props();

    const uid = $props.id();
    // svelte-ignore state_referenced_locally
    const startedIn: TaskStatus = start.kind === "new" ? start.status : "open";

    /** The task as last read or written, which every write starts from; null while it is new. */
    let task = $state.raw<ReadTask | null>(null);
    /** Editing an existing task (or one just created); false while the form is new. */
    // svelte-ignore state_referenced_locally
    let editing = $state(start.kind === "edit");
    // svelte-ignore state_referenced_locally
    let loading = $state(editing);
    let loadError = $state<string | null>(null);

    let title = $state("");
    let status = $state<TaskStatus>(startedIn);
    let priority = $state<TaskPriority | null>(null);
    let freeTags = $state<string[]>([]);
    /** The due and scheduled dates, `YYYY-MM-DD`, as the fields show them. */
    let dates = $state<Record<DateField, string | null>>({ due: null, scheduled: null });
    /** The date field whose calendar is open, for its button's `aria-expanded`. */
    let pickingDate = $state<DateField | null>(null);
    /** Counts calendars opened, so one that closes because another opened leaves `pickingDate` alone. */
    let pickCount = 0;
    type SavedFields = Pick<TaskFields, "title" | "status" | "priority" | "freeTags" | "due" | "scheduled">;
    /** The fields as the document has them, so a field is saved only when it differs. */
    let saved = $state.raw<SavedFields>({ title: "", status: startedIn, priority: null, freeTags: [], due: null, scheduled: null });
    /** The parts of the task the editors show, read again as its text changes. */
    let parts = $state.raw<Pick<TaskFields, "hasDescription" | "hasComments" | "hasAdditionalContext" | "assets">>({
        hasDescription: false,
        hasComments: false,
        hasAdditionalContext: false,
        assets: [],
    });

    type SaveState = "idle" | "saving" | "saved" | "stale" | "missing" | "failed";
    let saveState = $state<SaveState>("idle");
    /** "Saving…" shows only once a write has taken a moment, so it never flashes. */
    let savingShown = $state(false);
    let titleError = $state<string | null>(null);
    let tagInput = $state("");
    let tagError = $state<string | null>(null);
    let commentInput = $state("");
    let commentError = $state<string | null>(null);
    let createError = $state<string | null>(null);
    let creating = $state(false);
    /** A new task with something in it is being closed: the dialog asks first. */
    let discardAsked = $state(false);
    /** A close was refused once because the title could not be saved; the next one closes. */
    let titleUnsaved = false;

    /** The description of a new task, held here until the task is created. */
    const held = createHeldDocument(EMPTY_DESCRIPTION);
    /** The text the held description has, read when it changes. */
    let heldText = $state(EMPTY_DESCRIPTION);

    let descriptionView = $state<DocumentView>();
    let commentInputEl = $state<HTMLInputElement>();
    let additionalContextEl = $state<HTMLElement>();
    let titleEl = $state<HTMLInputElement>();
    let keepEditingEl = $state<HTMLButtonElement>();

    const taskDocument = $derived(task?.concept ?? null);
    /** The dialog's title: the board it was opened from, or, outside one, the task's document. */
    const heading = $derived(
        !onBoard ? `Task in ${task?.concept ?? (start.kind === "edit" ? start.document : "today's journal")}` : concept === null ? "Graph Kanban" : `Board: ${concept}`,
    );
    const assets = $derived(editing ? parts.assets : [...new Set(assetReferencesIn(heldText))]);

    function store() {
        return workspaceService("store");
    }

    // ── Reading ───────────────────────────────────────────────────────────

    /** The fields as the document has them, kept to tell which a person has changed. */
    function savedOf(fields: TaskFields): SavedFields {
        return { title: fields.title, status: fields.status, priority: fields.priority, freeTags: [...fields.freeTags], due: fields.due, scheduled: fields.scheduled };
    }

    /** Fill the fields from what the document says. */
    function showFields(fields: TaskFields): void {
        title = fields.title;
        status = fields.status;
        priority = fields.priority;
        freeTags = [...fields.freeTags];
        dates = { due: fields.due, scheduled: fields.scheduled };
        saved = savedOf(fields);
        parts = fields;
    }

    /** Where the task is now: the line the description editor follows, else where it was read. */
    function currentTarget(): { document: string; line: number; text: string } | null {
        if (!task) return start.kind === "edit" ? { document: start.document, line: start.line, text: start.text } : null;
        const shown = descriptionView?.shownLine();
        return { document: task.concept, line: shown?.line ?? task.line, text: bulletLabel(shown?.text ?? task.expected) };
    }

    /** Read the task afresh, fields and all: on opening, and on Reload after a refused write. */
    async function load(): Promise<void> {
        const target = currentTarget();
        const at = store();
        if (!target || !at) return;
        loading = true;
        const read = await readEditedTask(at, target);
        loading = false;
        if (!read.ok) {
            loadError =
                read.reason === "missing"
                    ? `"${target.document}" was renamed or deleted, so the task cannot be opened here.`
                    : onBoard
                      ? "This task is not where the board read it: its words were edited or it was deleted. Close this and open it again from the board."
                      : "This task is not where it was read: its words were edited or it was deleted. Close this and open it again.";
            return;
        }
        loadError = null;
        task = read.task;
        saveState = "idle";
        showFields(read.fields);
    }

    /**
     * Read the parts the editors show (description, comments, additional context, assets) again, after the text changed:
     * an edit in the description, a comment, an asset, or another member's change. The fields are
     * left as they are; a task line that reads otherwise now than it was read is said at once.
     */
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    function scheduleRefresh(): void {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshParts(), 150);
    }

    async function refreshParts(): Promise<void> {
        const target = currentTarget();
        const at = store();
        if (!editing || !task || !target || !at) return;
        const read = await readEditedTask(at, target);
        if (!read.ok) return;
        // The additional context goes with its last line (or its Comments block). When the keyboard
        // was in its editor, it moves to the comment field above rather than to the page.
        const contextHadFocus = additionalContextEl?.contains(document.activeElement) ?? false;
        parts = read.fields;
        if (read.task.expected !== task.expected && saveState !== "saving") saveState = "stale";
        if (contextHadFocus && !parts.hasAdditionalContext) {
            await tick();
            commentInputEl?.focus();
        }
    }

    // ── Saving a field ────────────────────────────────────────────────────

    /** One write at a time, each starting from the task as the last one left it. */
    let queue: Promise<unknown> = Promise.resolve();
    function serially<T>(write: () => Promise<T>): Promise<T> {
        const next = queue.then(write, write);
        queue = next.catch(() => {});
        return next;
    }

    /** Rewrite the task line, or say why not. True when it was written. */
    function save(rewrite: (line: string) => string | null): Promise<boolean> {
        return serially(async () => {
            const at = store();
            if (!task || !at) return false;
            if (saveState === "stale") return false;
            saveState = "saving";
            const slow = setTimeout(() => (savingShown = true), 200);
            try {
                const outcome = await saveTaskLine(at, task, rewrite);
                if (!outcome.ok) {
                    saveState = outcome.reason;
                    return false;
                }
                task = outcome.task;
                saveState = "saved";
                const read = await readEditedTask(at, { document: task.concept, line: task.line, text: bulletLabel(task.expected) });
                if (read.ok) {
                    saved = savedOf(read.fields);
                    freeTags = [...read.fields.freeTags];
                    parts = read.fields;
                }
                return true;
            } catch {
                saveState = "failed";
                return false;
            } finally {
                clearTimeout(slow);
                savingShown = false;
            }
        });
    }

    /** Save the title when it has changed: on leaving the field, Enter, or closing. True when it is saved. */
    async function commitTitle(): Promise<boolean> {
        if (!editing || title.trim() === saved.title) return true;
        if (title.trim() === "") {
            titleError = "A task needs a title. Type one, or Delete task to remove it.";
            return false;
        }
        titleError = null;
        return save((line) => taskLineWithTitle(line, title));
    }

    function onStatusChange(): void {
        if (editing && status !== saved.status) void save((line) => taskLineWith(line, { status }));
    }

    function onPriorityChange(next: TaskPriority | null): void {
        priority = next;
        if (editing && next !== saved.priority) void save((line) => taskLineWith(line, { priority: next }));
    }

    /**
     * A date field changed, or was cleared: written as its dated task tag in the run's own order, or
     * taken out. A date only partly typed reads as none until it is whole, so nothing is written for it.
     */
    function onDateChange(field: DateField, value: string | null): void {
        dates[field] = value;
        if (editing && value !== saved[field]) void save((line) => taskLineWith(line, field === "due" ? { due: value } : { scheduled: value }));
    }

    /**
     * A date field's button was pressed: the Client's Date Picker opens beside it on the date it
     * shows, and the day picked is written as `onDateChange` writes any. Pressed again while its
     * calendar is open, the button closes it (the Client closes a calendar asked for again by its
     * anchor), and the date stays as it was.
     */
    async function openDatePicker(field: DateField, label: string, anchor: HTMLElement): Promise<void> {
        const opened = ++pickCount;
        pickingDate = field;
        const picked = await pickTaskDate(anchor, label, dates[field]);
        if (opened === pickCount) pickingDate = null;
        if (picked !== undefined) onDateChange(field, picked);
    }

    async function addTag(): Promise<void> {
        const tag = readFreeTag(tagInput);
        tagError = freeTagProblem(tag, freeTags);
        if (tagError) return;
        if (!editing) {
            freeTags = [...freeTags, tag];
            tagInput = "";
            return;
        }
        if (await save((line) => taskLineWithFreeTag(line, tag, true))) tagInput = "";
    }

    function removeTag(tag: string): void {
        if (!editing) {
            freeTags = freeTags.filter((written) => written !== tag);
            return;
        }
        void save((line) => taskLineWithFreeTag(line, tag, false));
    }

    // ── Description, assets and comments ──────────────────────────────────

    /** The description editor's view, with the caret at the end of what it shows. */
    function caretAtDescriptionEnd() {
        const view = descriptionView?.editorView();
        if (!view) return null;
        const end = editing ? shownRangeIn(view.state)?.to : view.state.doc.length;
        if (end === undefined || end === null) return null;
        view.dispatch({ selection: EditorSelection.cursor(end), scrollIntoView: true });
        return view;
    }

    /** Start the description with an empty bullet, and put the caret in it. */
    async function addDescription(): Promise<void> {
        const at = store();
        if (!task || !at) return;
        const outcome = await serially(() => addDescriptionLine(at, task!));
        if (!outcome.ok) {
            saveState = outcome.reason;
            return;
        }
        await tick();
        caretAtDescriptionEnd()?.focus();
        scheduleRefresh();
    }

    /**
     * Add an asset as a bullet of its own at the end of the description, through the Client's upload
     * dialog: an empty bullet is started for it, and taken out again when the dialog closes with
     * nothing uploaded.
     */
    let assetBullet: number | null = null;
    async function addAsset(): Promise<void> {
        if (editing) {
            const at = store();
            if (!task || !at) return;
            const outcome = await serially(() => addDescriptionLine(at, task!));
            if (!outcome.ok) {
                saveState = outcome.reason;
                return;
            }
            await tick();
        } else {
            held.applyChange({ from: heldText.length, to: heldText.length, insert: heldText.trimEnd() === "-" ? "" : "\n- " }, "external");
        }
        const view = caretAtDescriptionEnd();
        if (!view) return;
        assetBullet = view.state.doc.lineAt(view.state.selection.main.head).number;
        openAssetPicker(view);
    }

    /** The upload dialog closed: an asset bullet it left empty is taken out. */
    function assetPickerClosed(): void {
        const view = descriptionView?.editorView();
        const number = assetBullet;
        assetBullet = null;
        if (!view || number === null || number > view.state.doc.lines) return;
        const line = view.state.doc.line(number);
        if (!/^\s*-\s*$/.test(line.text) || number === 1) {
            scheduleRefresh();
            return;
        }
        const target = editing ? store()?.open(task!.concept) : held;
        target?.applyChange({ from: line.from - 1, to: line.to, insert: "" }, "external");
        scheduleRefresh();
    }

    async function submitComment(): Promise<void> {
        const text = commentInput.trim();
        const at = store();
        if (text === "") {
            commentError = "Type a comment first.";
            return;
        }
        if (!task || !at) return;
        commentError = null;
        const outcome = await serially(() => addComment(at, task!, text));
        if (!outcome.ok) {
            commentError =
                outcome.reason === "missing"
                    ? "The task's document was renamed or deleted, so the comment was not added."
                    : "This task was changed elsewhere, so the comment was not added. Reload the task, then add it again.";
            if (outcome.reason === "stale") saveState = "stale";
            return;
        }
        commentInput = "";
        scheduleRefresh();
    }

    // ── Creating, archiving, deleting, closing ────────────────────────────

    async function create(): Promise<void> {
        if (editing || creating) return;
        if (title.trim() === "") {
            titleError = "Give the task a title.";
            titleEl?.focus();
            return;
        }
        const at = store();
        if (!at) return;
        titleError = null;
        createError = null;
        creating = true;
        try {
            const lines = newTaskLines({ status, priority, title, freeTags, due: dates.due, scheduled: dates.scheduled }, held.getText());
            // Today is read now, not when the board opened: a board is left open for days.
            const added = await addTaskToJournal(at, { day: todayISO(), concept, sameConcept: concept === null ? () => false : sameConcept(concept), lines });
            task = { concept: added.document, line: added.line, expected: added.text };
            editing = true;
            saveState = "saved";
            await load();
            await tick();
            titleEl?.focus();
        } catch (error) {
            // Everything typed stays in the form for another try.
            createError = `The task was not created: ${error instanceof Error ? error.message : "the journal entry could not be written"}. Try again.`;
        } finally {
            creating = false;
        }
    }

    async function archive(): Promise<void> {
        const at = store();
        if (!task || !at) return;
        const read = task;
        const outcome = await serially(() => rewriteTaskLine(at, read, (line) => taskLineWith(line, { status: "archived" })));
        if (!outcome.ok) {
            saveState = outcome.reason;
            return;
        }
        onarchived({ document: read.concept, label: saved.title, status: saved.status, priority: saved.priority, outcome });
        onclose();
    }

    async function remove(): Promise<void> {
        const at = store();
        if (!task || !at) return;
        const read = task;
        const outcome = await serially(() => deleteTask(at, read));
        if (!outcome.ok) {
            saveState = outcome.reason;
            return;
        }
        ondeleted(outcome.removed, saved.title);
        onclose();
    }

    function copyReference(): void {
        if (!task) return;
        void workspaceService("commands")?.execute(TASK_COPY_REFERENCE, { document: task.concept, line: task.line, label: bulletLabel(task.expected) });
    }

    /**
     * Open, or bring forward, the task's document in a tab of its own, at the line the description
     * editor follows. It leaves as Done does, saving the title or staying to say it could not: a tab
     * opened behind the dialog could not be seen. The tab opens after the dialog has gone, because
     * the dialog hands the keyboard back as it goes, and the tab's editor is to end up with it.
     */
    async function openInTab(): Promise<void> {
        const target = currentTarget();
        if (!task || !target || !(await requestClose())) return;
        await tick();
        openConceptAtLine(target.document, target.line, panelId);
    }

    /**
     * Close, unless a new task would be lost (then ask) or the title could not be saved (then stay).
     * True when it closed.
     */
    async function requestClose(): Promise<boolean> {
        if (!editing) {
            if (discardAsked) {
                discardAsked = false;
                return false;
            }
            if (!isUntouched({ title, status, priority, freeTags, due: dates.due, scheduled: dates.scheduled }, startedIn, held.getText())) {
                discardAsked = true;
                await tick();
                keepEditingEl?.focus();
                return false;
            }
            onclose();
            return true;
        }
        if ((await commitTitle()) || titleUnsaved) {
            onclose();
            return true;
        }
        // The title could not be saved. Closing now would lose it, so the first close says so, and
        // a second close lets it go.
        titleUnsaved = true;
        titleError ??= "Your title was not saved. Close again to leave without it.";
        return false;
    }

    /** Ctrl/Cmd+Enter anywhere in a new task's form creates it, the description's editor included. */
    function onKeydownCapture(event: KeyboardEvent): void {
        if (editing || event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopPropagation();
        void create();
    }

    // Every change to the document may change the parts shown: another member's, an agent's, or an
    // edit in the description, the comments or the additional context.
    $effect(() => {
        const concept = taskDocument;
        if (!editing || concept === null) return;
        try {
            return store()?.open(concept).subscribe(scheduleRefresh);
        } catch {
            return undefined;
        }
    });

    onMount(() => {
        const detachHeld = held.subscribe((text) => (heldText = text));
        let pickerOpen = false;
        const detachPicker = subscribeAssetPicker((state) => {
            if (pickerOpen && !state.open) assetPickerClosed();
            pickerOpen = state.open;
        });
        // The title takes the keyboard once the task is read: it is disabled until then.
        if (start.kind === "edit") void load().then(() => tick().then(() => titleEl?.focus()));
        return () => {
            detachHeld();
            detachPicker();
        };
    });

    onDestroy(() => clearTimeout(refreshTimer));

    const saveLine = $derived(
        saveState === "saving"
            ? savingShown
                ? "Saving…"
                : ""
            : saveState === "saved"
              ? "Saved"
              : saveState === "failed"
                ? "That change could not be saved. Try again."
                : "",
    );
    const laneLabel = (value: TaskStatus) => BOARD_LANES.find((lane) => lane.status === value)?.label ?? value;
</script>

{#snippet actionIcon(name: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table (ADR 0130) -->
    <span class="grid size-4 shrink-0 place-items-center" aria-hidden="true">{@html iconSvg(name)}</span>
{/snippet}

<Dialog
    open
    title={heading}
    size="xl"
    placement="top"
    fillPhone
    testId="task-editor"
    busy={creating}
    busyReason="Creating the task…"
    onclose={() => void requestClose()}
    onsubmit={editing ? undefined : () => void create()}
>
    {#snippet body()}
        <div class="flex flex-col gap-4" onkeydowncapture={onKeydownCapture} data-mode={editing ? "edit" : "new"} data-testid="task-editor-body">
            {#if loadError}
                <p role="alert" class="m-0 rounded-lg bg-(--gk-danger-surface) px-3 py-2 text-sm text-(--gk-text-danger)" data-testid="task-editor-load-error">
                    {loadError}
                </p>
            {:else}
                <div class="flex flex-wrap items-end gap-2">
                    <div class="flex min-w-40 flex-col gap-1">
                        <label for="{uid}-lane" class="gk-label">Lane</label>
                        <select id="{uid}-lane" class="gk-select" bind:value={status} onchange={onStatusChange} disabled={loading} data-testid="task-editor-lane">
                            {#each BOARD_LANES as lane (lane.status)}
                                <option value={lane.status}>{lane.label}</option>
                            {/each}
                        </select>
                    </div>
                    <span class="flex-1"></span>
                    {#if editing}
                        <!-- Each action's icon is the one its row carries in the task's menus; the
                             labels stay, and the row wraps on a narrow screen rather than dropping them. -->
                        <button type="button" class="gk-button" onclick={copyReference} disabled={!task} data-testid="task-editor-copy-reference">
                            {@render actionIcon("task-reference")}
                            Copy agent instruction
                        </button>
                        <button type="button" class="gk-button" onclick={() => void archive()} disabled={!task} data-testid="task-editor-archive">
                            {@render actionIcon("archive")}
                            Archive
                        </button>
                        <button type="button" class="gk-button gk-button--danger" onclick={() => void remove()} disabled={!task} data-testid="task-editor-delete">
                            {@render actionIcon("trash")}
                            Delete task
                        </button>
                    {/if}
                </div>

                {#if editing}
                    <!-- A link under the actions, since it goes somewhere rather than changing the task. A
                         button, because it saves and closes first, and a new task has no document to go to.
                         `-my-2` keeps the row's 32px hit area without widening the gaps around its text. -->
                    <div class="-my-2 flex justify-end">
                        <button
                            type="button"
                            class="inline-flex min-h-8 items-center rounded-sm text-sm text-(--gk-accent) underline hover:text-(--gk-accent-hover) focus-visible:outline-2 focus-visible:outline-(--gk-accent) disabled:text-(--gk-text-muted) disabled:no-underline"
                            onclick={() => void openInTab()}
                            disabled={!task}
                            data-testid="task-editor-open-in-tab"
                        >
                            Open in tab
                        </button>
                    </div>
                {/if}

                {#if saveState === "stale" || saveState === "missing"}
                    <div role="alert" class="flex items-center gap-3 rounded-lg bg-(--gk-warning-surface) px-3 py-2 text-sm text-(--gk-text-warning)" data-testid="task-editor-stale">
                        <span class="min-w-0 flex-1">
                            {#if saveState === "missing"}
                                The task's document was renamed or deleted, so nothing more can be saved here.
                            {:else}
                                Changed elsewhere: this task's line was edited since it was opened, so your change was not saved. Reload to see it as it is now.
                            {/if}
                        </span>
                        {#if saveState === "stale"}
                            <button type="button" class="shrink-0 rounded-md border border-current px-2 py-1 font-medium" onclick={() => void load()} data-testid="task-editor-reload">
                                Reload
                            </button>
                        {/if}
                    </div>
                {/if}

                <div class="flex flex-col gap-1">
                    <label for="{uid}-title" class="gk-label">Title</label>
                    <input
                        id="{uid}-title"
                        bind:this={titleEl}
                        bind:value={title}
                        class="gk-input"
                        type="text"
                        autocomplete="off"
                        data-autofocus
                        disabled={loading}
                        aria-invalid={titleError !== null}
                        aria-describedby={titleError ? `${uid}-title-error` : undefined}
                        oninput={() => {
                            if (titleError && title.trim() !== "") titleError = null;
                        }}
                        onblur={() => void commitTitle()}
                        onkeydown={(event) => {
                            // Editing: Enter saves the title and leaves the dialog open.
                            if (editing && event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                                event.preventDefault();
                                void commitTitle();
                            }
                        }}
                        data-testid="task-editor-title"
                    />
                    {#if titleError}
                        <p id="{uid}-title-error" class="gk-error m-0" data-testid="task-editor-title-error">{titleError}</p>
                    {/if}
                </div>

                <fieldset class="m-0 flex flex-col gap-1 border-0 p-0">
                    <legend class="gk-label mb-1">Priority</legend>
                    <div class="flex flex-wrap gap-2" data-testid="task-editor-priority">
                        {#each PRIORITY_CHOICES as choice (choice.label)}
                            {@const chosen = priority === choice.priority}
                            <!-- The chosen chip is outlined in the text colour, not filled: a fill in the
                                 priority's pastel read as one more chip colour. Every chip keeps its dot, so
                                 the colour still says which priority it is. The outline is the 1px border
                                 every chip has plus a 1px inset ring, so choosing a chip moves nothing. -->
                            <label
                                class={[
                                    "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm font-medium has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--gk-accent)",
                                    chosen
                                        ? "border-(--gk-text-strong) text-(--gk-text-strong) shadow-[inset_0_0_0_1px_var(--gk-text-strong)]"
                                        : "border-(--gk-control-border) text-(--gk-text-default) hover:bg-(--gk-control-hover)",
                                ]}
                                data-testid="task-editor-priority-chip"
                                data-priority={choice.priority ?? "none"}
                                data-chosen={chosen || undefined}
                            >
                                <input
                                    type="radio"
                                    class="sr-only"
                                    name="{uid}-priority"
                                    checked={chosen}
                                    disabled={loading}
                                    onchange={() => onPriorityChange(choice.priority)}
                                />
                                <!-- None's dot is an empty ring, so its label lines up with the others'. -->
                                <span
                                    class="size-3 shrink-0 rounded-full border border-(--gk-border-strong)"
                                    style:background-color={choice.colour ?? undefined}
                                    aria-hidden="true"
                                    data-testid="task-editor-priority-dot"
                                ></span>
                                {choice.label}
                            </label>
                        {/each}
                    </div>
                </fieldset>

                <!-- Due and Scheduled: each shows its date and opens the Client's Date Picker, the
                     calendar the document editor shows, with a Clear that takes its tag out of the
                     task line. -->
                <div class="flex flex-wrap gap-x-4 gap-y-3" data-testid="task-editor-dates">
                    {#each DATE_FIELDS as entry (entry.field)}
                        {@const value = dates[entry.field]}
                        <div class="flex min-w-56 flex-1 flex-col gap-1">
                            <label id="{uid}-{entry.field}-label" for="{uid}-{entry.field}" class="gk-label">{entry.label}</label>
                            <div class="flex gap-2">
                                <!-- Named by its label and the date it shows: "Due 2026-11-09", "Due No date". -->
                                <button
                                    id="{uid}-{entry.field}"
                                    type="button"
                                    class="gk-input flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                                    aria-haspopup="dialog"
                                    aria-expanded={pickingDate === entry.field}
                                    aria-labelledby="{uid}-{entry.field}-label {uid}-{entry.field}-value"
                                    aria-describedby="{uid}-{entry.field}-hint"
                                    disabled={loading}
                                    onclick={(event) => openDatePicker(entry.field, entry.label, event.currentTarget)}
                                    data-testid="task-editor-{entry.field}"
                                    data-value={value ?? ""}
                                >
                                    <span id="{uid}-{entry.field}-value" class={value === null ? "text-(--gk-text-muted)" : undefined}>{value ?? "No date"}</span>
                                    {@render actionIcon("calendar")}
                                </button>
                                <!-- Disabled while there is no date to clear: the empty field beside it says why. -->
                                <button
                                    type="button"
                                    class="gk-button"
                                    disabled={loading || value === null}
                                    aria-label="Clear the {entry.label.toLowerCase()} date"
                                    onclick={() => onDateChange(entry.field, null)}
                                    data-testid="task-editor-{entry.field}-clear"
                                >
                                    Clear
                                </button>
                            </div>
                            <p id="{uid}-{entry.field}-hint" class="gk-hint m-0">Written as {entry.tag}YYYY-MM-DD.</p>
                        </div>
                    {/each}
                </div>

                <div class="flex flex-col gap-1">
                    <label for="{uid}-tag" class="gk-label">Tags</label>
                    {#if freeTags.length > 0}
                        <!-- `my-1`: the pills sit as far below the label as the Priority chips do below
                             theirs, and as far above the field. -->
                        <ul class="mx-0 my-1 flex list-none flex-wrap gap-2 p-0" data-testid="task-editor-tags">
                            {#each freeTags as tag (tag)}
                                <li class="inline-flex items-center gap-1 rounded-full bg-(--gk-surface-2) py-0.5 pr-1 pl-3 text-sm text-(--gk-text-default)" data-testid="task-editor-tag">
                                    <span>{tag}</span>
                                    <button
                                        type="button"
                                        class="inline-flex size-7 items-center justify-center rounded-full text-(--gk-text-muted) hover:bg-(--gk-control-hover) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
                                        aria-label="Remove the tag {tag}"
                                        onclick={() => removeTag(tag)}
                                        data-testid="task-editor-tag-remove"
                                    >
                                        <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" /></svg>
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                    <div class="flex gap-2">
                        <input
                            id="{uid}-tag"
                            bind:value={tagInput}
                            class="gk-input min-w-0 flex-1"
                            type="text"
                            autocomplete="off"
                            placeholder="Add another tag…"
                            disabled={loading}
                            aria-invalid={tagError !== null}
                            aria-describedby={tagError ? `${uid}-tag-error` : `${uid}-tag-hint`}
                            oninput={() => {
                                if (tagError) tagError = freeTagProblem(readFreeTag(tagInput), freeTags);
                            }}
                            onkeydown={(event) => {
                                if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                                    event.preventDefault();
                                    void addTag();
                                }
                            }}
                            data-testid="task-editor-tag-input"
                        />
                        <button type="button" class="gk-button" onclick={() => void addTag()} disabled={loading} data-testid="task-editor-tag-add">Add tag</button>
                    </div>
                    {#if tagError}
                        <p id="{uid}-tag-error" class="gk-error m-0" data-testid="task-editor-tag-error">{tagError}</p>
                    {:else}
                        <p id="{uid}-tag-hint" class="gk-hint m-0">Written after the title as #tag. Letters, digits and single hyphens.</p>
                    {/if}
                </div>

                <section class="flex flex-col gap-1" aria-labelledby="{uid}-description">
                    <h3 id="{uid}-description" class="gk-label m-0">Description</h3>
                    <!-- The document's own editor, showing only the description. Hidden, not unmounted,
                         while there is none, so adding one shows it at once. -->
                    <TaskEditorPartBox
                        part="description"
                        label="Description"
                        minRem={14}
                        hidden={editing && !parts.hasDescription}
                        oninput={scheduleRefresh}
                        testId="task-editor-description"
                    >
                        {#if editing && task}
                            {#key task.concept}
                                <DocumentView
                                    bind:this={descriptionView}
                                    view={{ kind: "document", target: task.concept }}
                                    {panelId}
                                    {visibility}
                                    embedded
                                    revealAt={task.line}
                                    shownRange={taskPartRange("description")}
                                />
                            {/key}
                        {:else if !editing}
                            <DocumentView bind:this={descriptionView} view={{ kind: "document", target: todayISO() }} {panelId} {visibility} embedded source={held} />
                        {/if}
                    </TaskEditorPartBox>
                    {#if editing && !parts.hasDescription}
                        <button type="button" class="gk-button self-start" onclick={() => void addDescription()} disabled={!task} data-testid="task-editor-add-description">
                            Add a description
                        </button>
                    {/if}
                </section>

                <section class="flex flex-col gap-1" aria-labelledby="{uid}-assets">
                    <h3 id="{uid}-assets" class="gk-label m-0">Assets</h3>
                    {#if assets.length > 0}
                        <!-- Every asset the task shows, in its description, its comments or below them:
                             an image as a picture, any other file as an icon, each with its name. -->
                        <ul class="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2 p-0" data-testid="task-editor-assets">
                            {#each assets as ref (ref)}
                                <TaskEditorAsset asset={assetShown(ref)} onview={() => void viewTaskImages(assets, ref)} />
                            {/each}
                        </ul>
                        <p class="gk-hint m-0">Images and files added here go at the end of the description.</p>
                    {:else}
                        <p class="gk-hint m-0">No assets. Images and files added here go at the end of the description.</p>
                    {/if}
                    <button type="button" class="gk-button self-start" onclick={() => void addAsset()} disabled={editing && !task} data-testid="task-editor-add-asset">Add asset</button>
                </section>

                <section class="flex flex-col gap-1" aria-labelledby="{uid}-comments">
                    <h3 id="{uid}-comments" class="gk-label m-0">Comments</h3>
                    {#if !editing}
                        <p class="gk-hint m-0">Comments can be added once the task is created.</p>
                    {:else if task}
                        {#if parts.hasComments}
                            <TaskEditorPartBox part="comments" label="Comments" minRem={10} oninput={scheduleRefresh} testId="task-editor-comments">
                                {#key task.concept}
                                    <DocumentView
                                        view={{ kind: "document", target: task.concept }}
                                        {panelId}
                                        {visibility}
                                        embedded
                                        revealAt={task.line}
                                        shownRange={taskPartRange("comments")}
                                    />
                                {/key}
                            </TaskEditorPartBox>
                        {:else}
                            <p class="gk-hint m-0" data-testid="task-editor-no-comments">No comments yet.</p>
                        {/if}
                        <!-- With the section's `gap-1`, the row sits as far below the comments as one
                             section sits below another (the body's `gap-4`): the comments' resize
                             handle (12px) takes the place of the `mt-3` the row has under the hint. -->
                        <div class={["flex gap-2", !parts.hasComments && "mt-3"]} data-testid="task-editor-comment-row">
                            <input
                                bind:this={commentInputEl}
                                bind:value={commentInput}
                                class="gk-input min-w-0 flex-1"
                                type="text"
                                autocomplete="off"
                                placeholder="Add a comment…"
                                aria-label="Add a comment"
                                aria-invalid={commentError !== null}
                                aria-describedby={commentError ? `${uid}-comment-error` : undefined}
                                onkeydown={(event) => {
                                    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
                                        event.preventDefault();
                                        void submitComment();
                                    }
                                }}
                                data-testid="task-editor-comment-input"
                            />
                            <button type="button" class="gk-button" onclick={() => void submitComment()} data-testid="task-editor-comment-add">Add comment</button>
                        </div>
                        {#if commentError}
                            <p id="{uid}-comment-error" class="gk-error m-0" data-testid="task-editor-comment-error">{commentError}</p>
                        {/if}
                    {/if}
                </section>

                <!-- Lines nested under the task below its Comments block. Nothing here writes them
                     (they come from typing in the document, or from an agent), so the part shows only
                     while there are some, and goes, with its editor, when they or the Comments block
                     are taken out. -->
                {#if editing && task && parts.hasAdditionalContext}
                    <section bind:this={additionalContextEl} class="flex flex-col gap-1" aria-labelledby="{uid}-additional-context">
                        <h3 id="{uid}-additional-context" class="gk-label m-0">Additional context</h3>
                        <TaskEditorPartBox part="additionalContext" label="Additional context" minRem={10} oninput={scheduleRefresh} testId="task-editor-additional-context">
                            {#key task.concept}
                                <DocumentView
                                    view={{ kind: "document", target: task.concept }}
                                    {panelId}
                                    {visibility}
                                    embedded
                                    revealAt={task.line}
                                    shownRange={taskPartRange("additionalContext")}
                                />
                            {/key}
                        </TaskEditorPartBox>
                    </section>
                {/if}

                {#if createError}
                    <p role="alert" class="gk-error m-0" data-testid="task-editor-create-error">{createError}</p>
                {/if}
            {/if}
        </div>
    {/snippet}
    {#snippet footer()}
        {#if discardAsked}
            <div role="alert" class="mr-auto flex flex-wrap items-center gap-2 text-sm text-(--gk-text-default)" data-testid="task-editor-discard">
                <span>Discard this new task? Nothing of it has been saved.</span>
                <button type="button" bind:this={keepEditingEl} class="gk-button" onclick={() => (discardAsked = false)} data-testid="task-editor-keep-editing">
                    Keep editing
                </button>
                <button type="button" class="gk-button gk-button--danger" onclick={onclose} data-testid="task-editor-discard-confirm">Discard</button>
            </div>
        {:else if editing}
            <p class="m-0 mr-auto self-center text-sm text-(--gk-text-muted)" role="status" data-testid="task-editor-save-state">{saveLine}</p>
            <button type="button" class="gk-button gk-button--primary" onclick={() => void requestClose()} data-testid="task-editor-done">Done</button>
        {:else}
            <p class="m-0 mr-auto self-center text-sm text-(--gk-text-muted)">
                New task in {laneLabel(status)}, in today's journal{concept === null ? "" : ` under ${concept}`}.
            </p>
            <button type="button" class="gk-button" onclick={() => void requestClose()} data-testid="task-editor-cancel">Cancel</button>
            <button type="submit" class="gk-button gk-button--primary" data-testid="task-editor-create">Create task</button>
        {/if}
    {/snippet}
</Dialog>
