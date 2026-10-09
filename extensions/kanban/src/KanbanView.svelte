<script lang="ts">
    /**
     * The [[Kanban Board]] (ADR 0113): the tasks that answer to one [[Concept]], set out in a
     * [[Lane]] per [[Task Status]] and a section per priority. A lens over documents: every card
     * is a task line the [[Derived Index]] reported, and moving a card rewrites that line.
     *
     * A move shows at once. The card holds its new place until the index agrees, or gives way to
     * the index after a while; a write that is refused puts it back with a notice. Nothing about
     * a move is kept anywhere but in the task's own text.
     *
     * Desktop only. Under the phone layout the board says so rather than squeezing five lanes
     * into a phone's width, and the menus that open one are hidden there.
     *
     * Mounted through the dockview adapter, so it reads its services through module accessors
     * rather than Svelte context (a separate Svelte root has none to inherit).
     */
    import { onMount, tick } from "svelte";
    import { MediaQuery } from "svelte/reactivity";

    import { conceptKey, getActiveGraphIndex, type TaskStatus, taskDateKey } from "$lib/document/backlinks";
    import { openConceptAtLine } from "$lib/document/open-concept";
    import { createSettleScheduler } from "$lib/document/settle-scheduler";
    import { bulletLabel } from "$lib/document/index-derive";
    import { findIndexedTask, isTaskLine, restoreTaskLine, type TaskChanges, type TaskWriteOutcome, writeTaskChanges } from "$lib/document/task-write";
    import type { DocumentStore } from "$lib/document/types";
    import { TASK_COPY_REFERENCE } from "$lib/document/commands/task-reference-commands";
    import DocumentView from "$lib/document/view/DocumentView.svelte";
    import type { ViewRef } from "$lib/layout";
    import { DESKTOP_MEDIA_QUERY } from "$lib/layout/breakpoint";
    import { attachContextMenu, openContextMenu } from "$lib/surface/context-menu-store";
    import { tryGetActiveEventBus } from "$lib/surface/active-bus";
    import { iconSvg } from "$lib/surface/icons";
    import { currentWorkspaceServices, workspaceService } from "$lib/workspace/workspace-services";

    import { registerBoard, takeBoardHandover } from "./board-actions";
    import { createBoardStateStore, type TaskDetailState } from "./board-state";

    import {
        BOARD_LANES,
        BOARD_SECTIONS,
        type BoardCard,
        type BoardCell,
        type BoardLane,
        type BoardSnapshot,
        cardKey,
        type DueState,
        laneAfter,
        type PendingMove,
        sameTask,
        sectionAfter,
        taskDetailCard,
        unsettledMoves,
        withPendingMoves,
    } from "./board-model";
    import { readBoard, SECTION_PAGE_SIZE } from "./board-queries";
    import KanbanCardText from "./KanbanCardText.svelte";
    import type { KanbanCardTarget } from "./kanban-commands";
    import { edgeStep, pastThreshold } from "./pointer-drag";

    const { view, panelId }: { view: ViewRef; panelId?: string } = $props();

    const uid = $props.id();
    const concept = $derived(view.target);
    const desktop = new MediaQuery(DESKTOP_MEDIA_QUERY);

    /** The board's shape with nothing in it, drawn while the first read is under way. */
    const EMPTY_LANES: BoardLane[] = BOARD_LANES.map((lane) => ({
        ...lane,
        total: 0,
        loaded: true,
        sections: BOARD_SECTIONS.map((section) => ({ ...section, cards: [], total: 0, hasMore: false })),
    }));

    /** How long a read may take before placeholder cards appear, so they never flash. */
    const PLACEHOLDER_DELAY_MS = 150;
    /**
     * How long a written move holds its card in place while the index has not confirmed it. The
     * index settles a change in about two seconds, so this is comfortably past that.
     */
    const HOLD_MS = 5000;

    let board = $state.raw<BoardSnapshot | null>(null);
    let pending = $state.raw<PendingMove[]>([]);
    let loading = $state(true);
    /** The last read failed outright, which is not the same as the concept having no tasks. */
    let failed = $state(false);
    let slow = $state(false);
    /** Why the last move did not happen, shown until dismissed or the next move. */
    let notice = $state<string | null>(null);
    /** The last move, said once for screen readers; the board already shows it. */
    let announcement = $state("");
    /** The card the keyboard is on, the one card in the tab order. */
    let activeKey = $state<string | null>(null);
    let lanesEl = $state<HTMLElement>();

    /**
     * What this device remembers about the board. A View's target is fixed for its life (a rename
     * opens the board afresh under the new name), so the store is keyed once. A board opened by a
     * rename starts from the state of the board it replaces, which that board handed over.
     */
    // svelte-ignore state_referenced_locally
    const boardState = createBoardStateStore(currentWorkspaceServices()?.graphId ?? "", view.target);
    // svelte-ignore state_referenced_locally
    const handedOver = takeBoardHandover(view.target);
    if (handedOver) boardState.set(handedOver);
    /** Lanes shown as a narrow strip with their count. */
    let collapsed = $state<TaskStatus[]>(boardState.get().collapsed);
    /** How many cards a section shows, where Show more has raised it past the first page. */
    let limits = $state.raw<ReadonlyMap<string, number>>(new Map());
    const cellId = (cell: BoardCell) => `${cell.status}:${cell.priority ?? "none"}`;

    /**
     * The task the [[Task Detail]] shows and the line it opened at, or null while it is closed.
     * Remembered on this device with the board's other state, and reopened once the board has
     * been read (`restoreDetail`), so a reload lands where the user left off.
     */
    let detail = $state<TaskDetailState | null>(null);
    /** Waiting for the first read, which says whether its document and task are still there. */
    let rememberedDetail: TaskDetailState | null = boardState.get().detail;
    /** The Task Detail's share of the board's height. */
    let detailHeight = $state(boardState.get().detailHeight);
    let detailView = $state<DocumentView>();
    let detailEl = $state<HTMLElement>();

    /** The board as read, with the moves the index has yet to confirm made on it. */
    const shown = $derived(board === null ? null : withPendingMoves(board, pending));
    const lanes = $derived<BoardLane[]>(shown?.lanes ?? EMPTY_LANES);
    const empty = $derived(shown !== null && shown.lanes.every((lane) => lane.total === 0));
    const showPlaceholders = $derived(board === null && loading && slow);
    /** The lane that says a board is empty: Open, unless it is collapsed. */
    const emptyNoticeLane = $derived(BOARD_LANES.find((lane) => !collapsed.includes(lane.status))?.status);
    /** Where Tab enters the board: the card last on the keyboard, or the first card. */
    const tabKey = $derived.by(() => {
        const keys = lanes.flatMap((lane) => lane.sections.flatMap((section) => section.cards.map((card) => card.key)));
        return activeKey !== null && keys.includes(activeKey) ? activeKey : (keys[0] ?? null);
    });

    /**
     * The index lives in a worker (ADR 0041), so a read is a round trip; `wanted` keeps a slow
     * answer to an older read from replacing a newer one.
     */
    let wanted = 0;
    async function load(): Promise<void> {
        const index = getActiveGraphIndex();
        const ticket = ++wanted;
        if (!index) {
            loading = false;
            return;
        }
        // A cold index has nothing true to say yet, and "no tasks" from it would be wrong. The
        // placeholders stay, and the update that ends the build asks again.
        if (index.isBuilding()) return;
        loading = true;
        try {
            // Today is read now, not at mount: a board is left open for days.
            const next = await readBoard(index, concept, taskDateKey(new Date()), {
                countOnly: new Set(collapsed),
                limitFor: (cell) => limits.get(cellId(cell)),
            });
            if (ticket !== wanted) return;
            board = next;
            pending = unsettledMoves(next, pending, Date.now(), HOLD_MS);
            failed = false;
            followDetailTask(next);
            if (rememberedDetail !== null) {
                const remembered = rememberedDetail;
                rememberedDetail = null;
                void restoreDetail(remembered);
            }
        } catch {
            // Said over the board rather than shown as an empty one: "no tasks" and "could not
            // read" look the same, and only one of them is worth acting on.
            if (ticket !== wanted) return;
            failed = true;
        } finally {
            if (ticket === wanted) loading = false;
        }
    }

    /**
     * The index updates on every ingest, several times a second while someone types. An update
     * is a signal to read again once typing settles, with a cap so a board never freezes; the
     * same timings as the Tasks View's.
     */
    const refresh = createSettleScheduler(() => void load(), { settleMs: 600, maxWaitMs: 2000 });

    function retry(): void {
        refresh.cancel();
        void load();
    }

    /**
     * Collapse or expand a lane, remember it on this device, and read the board for it. The button
     * pressed is replaced by its opposite (the strip's for the header's), and the keyboard moves
     * to that one rather than falling out of the board.
     */
    function toggleCollapsed(status: TaskStatus): void {
        const collapsing = !collapsed.includes(status);
        collapsed = collapsing ? [...collapsed, status] : collapsed.filter((s) => s !== status);
        boardState.set({ ...boardState.get(), collapsed: [...collapsed] });
        retry();
        void focusLaneButton(status, collapsing ? "kanban-lane-expand" : "kanban-lane-collapse");
    }

    async function focusLaneButton(status: TaskStatus, testid: "kanban-lane-expand" | "kanban-lane-collapse"): Promise<void> {
        await tick();
        lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-lane"][data-status="${status}"] [data-testid="${testid}"]`)?.focus();
    }

    /**
     * Show the next page of a section's cards, and put the keyboard on the first of them, since
     * the button may be gone once the section has no more to show. The limit is worked out from
     * the cards on screen, so a second click before the first read lands asks for the same page.
     */
    async function showMore(cell: BoardCell, shownCount: number): Promise<void> {
        limits = new Map(limits).set(cellId(cell), shownCount + SECTION_PAGE_SIZE);
        refresh.cancel();
        await load();
        await tick();
        const section = lanesEl?.querySelector(
            `[data-testid="kanban-lane"][data-status="${cell.status}"] [data-testid="kanban-section"][data-priority="${cell.priority ?? "none"}"]`,
        );
        section?.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]')[shownCount]?.focus();
    }

    /** Bring the keyboard to a collapsed lane's strip, where a card it moved has gone. */
    function focusStrip(status: TaskStatus): Promise<void> {
        return focusLaneButton(status, "kanban-lane-expand");
    }

    /** After a move, keep the keyboard with the card, or on the strip of the collapsed lane it went into. */
    function followMovedCard(key: string, to: BoardCell): void {
        if (collapsed.includes(to.status)) void focusStrip(to.status);
        else void focusCard(key);
    }

    /**
     * Whether the Task Detail shows this card's task: the card it last matched, by document, line
     * and words. Each read of the board matches it again (`followDetailTask`).
     */
    function isSelected(card: BoardCard): boolean {
        return (
            detail !== null &&
            detail.document.toLowerCase() === card.document.toLowerCase() &&
            detail.line === card.line &&
            detail.label === card.label
        );
    }

    /**
     * Show the card's task in the Task Detail, with its line at the top, and leave the keyboard on
     * the board so the arrows keep walking the cards. Opening the card the Task Detail already
     * shows puts the caret at the end of the task's line instead, to write there.
     */
    function open(card: BoardCard): void {
        if (isSelected(card)) {
            detailView?.editShownLine();
            return;
        }
        const sameDocument = detail !== null && detail.document === card.document;
        detail = { document: card.document, line: card.line, label: card.label };
        rememberDetail(detail);
        // Another task in the document already open is shown in place; another document mounts
        // an editor of its own (the `{#key}` in the template), which opens at `detail.line`.
        if (sameDocument) detailView?.showLine(card.line);
    }

    function rememberDetail(next: TaskDetailState | null): void {
        boardState.set({ ...boardState.get(), detail: next });
    }

    /**
     * Reopen the Task Detail remembered from last time: at its task's line, found as a move finds
     * it, and not at all when the document is gone. When its words are not found, the remembered
     * line is used while it still holds a task (the words may have been edited just before the
     * reload), and the top of the document otherwise.
     */
    async function restoreDetail(remembered: TaskDetailState): Promise<void> {
        const store = workspaceService("store");
        if (!store) return;
        const found = await findIndexedTask(store, { concept: remembered.document, line: remembered.line, text: remembered.label });
        // Something else was opened while this was being found.
        if (detail !== null) return;
        if ("reason" in found && found.reason === "missing") {
            rememberDetail(null);
            return;
        }
        detail = { ...remembered, line: "reason" in found ? rememberedTaskLine(store, remembered) : found.index - found.bodyStart };
    }

    /** The remembered line, when the document still has a task there, or the top of the document. */
    function rememberedTaskLine(store: DocumentStore, remembered: TaskDetailState): number {
        try {
            return isTaskLine(store.open(remembered.document).getText(), remembered.line) ? remembered.line : 0;
        } catch {
            return 0;
        }
    }

    /**
     * Keep the Task Detail on its task in a fresh read: the card whose words are what the Task
     * Detail's line says now (`taskDetailCard`), so editing the words, which the Task Detail is
     * there for, keeps the card selected once the index has read the edit. Its line and words are
     * remembered for Open in tab and a reload.
     */
    function followDetailTask(read: BoardSnapshot): void {
        if (detail === null) return;
        const card = taskDetailCard(read, detail, detailView?.shownLine() ?? null);
        if (card === null || (card.line === detail.line && card.label === detail.label)) return;
        detail = { ...detail, line: card.line, label: card.label };
        rememberDetail(detail);
    }

    /**
     * The Task Detail as it stands: at the line it shows the task on now, which the index may not
     * have read yet. One still waiting for the board's first read is as it was remembered.
     */
    function currentDetail(): TaskDetailState | null {
        if (detail === null) return rememberedDetail;
        return { ...detail, line: detailView?.shownLine()?.line ?? detail.line };
    }

    /**
     * A document was renamed, `from` exactly as the rename reported it. A Task Detail showing it
     * follows it: its editor mounts again over the new name (the `{#key}` in the template), at the
     * task's line, and the board remembers the new name for a reload.
     */
    function followDocumentRename(from: string, to: string): void {
        const current = currentDetail();
        if (current === null || conceptKey(current.document) !== conceptKey(from) || to === current.document) return;
        const next = { ...current, document: to };
        if (detail === null) {
            rememberedDetail = next;
            return;
        }
        detail = next;
        rememberDetail(detail);
    }

    /** Close the Task Detail. The keyboard, if it was in there, goes back to the card it showed. */
    function closeDetail(): void {
        const hadFocus = detailEl?.contains(document.activeElement) ?? false;
        const selected = selectedKey();
        detail = null;
        rememberDetail(null);
        if (hadFocus && selected !== null) void focusCard(selected);
    }

    /**
     * Open, or bring forward, the Task Detail's document in a tab of its own at the task's line:
     * where the Task Detail has it now, which the index may not have read yet.
     */
    function openDetailInTab(): void {
        if (detail === null) return;
        openConceptAtLine(detail.document, detailView?.shownLine()?.line ?? detail.line, panelId);
    }

    /** The key of the card the Task Detail shows, while the board draws it. */
    function selectedKey(): string | null {
        for (const lane of lanes) {
            for (const section of lane.sections) {
                const card = section.cards.find((shown) => isSelected(shown));
                if (card) return card.key;
            }
        }
        return null;
    }

    /**
     * Escape in the Task Detail's editor blurs it (the outliner's own Escape), and on a board the
     * keyboard then goes back to the card. An Escape a popover took leaves the editor focused,
     * and nothing moves.
     */
    function onDetailKeydown(event: KeyboardEvent): void {
        if (event.key !== "Escape") return;
        requestAnimationFrame(() => {
            if (detailEl?.contains(document.activeElement)) return;
            const selected = selectedKey();
            if (selected !== null) void focusCard(selected);
        });
    }

    /** How far one arrow press moves the divider, as a share of the board's height. */
    const DIVIDER_STEP = 0.05;
    let dividerDrag: { pointerId: number } | null = null;

    function setDetailHeight(share: number): void {
        boardState.set({ ...boardState.get(), detailHeight: share });
        // The store keeps it between a fifth and four fifths of the board.
        detailHeight = boardState.get().detailHeight;
    }

    function onDividerPointerDown(event: PointerEvent): void {
        if (event.button !== 0) return;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        dividerDrag = { pointerId: event.pointerId };
        event.preventDefault();
    }

    function onDividerPointerMove(event: PointerEvent): void {
        if (!dividerDrag || event.pointerId !== dividerDrag.pointerId || !boardEl) return;
        const rect = boardEl.getBoundingClientRect();
        if (rect.height > 0) setDetailHeight((rect.bottom - event.clientY) / rect.height);
    }

    function onDividerPointerUp(event: PointerEvent): void {
        if (dividerDrag?.pointerId === event.pointerId) dividerDrag = null;
    }

    /** The arrow keys move the divider; Home and End take it to either end (the splitter pattern). */
    function onDividerKeydown(event: KeyboardEvent): void {
        const next =
            event.key === "ArrowUp"
                ? detailHeight + DIVIDER_STEP
                : event.key === "ArrowDown"
                  ? detailHeight - DIVIDER_STEP
                  : event.key === "Home"
                    ? 1
                    : event.key === "End"
                      ? 0
                      : null;
        if (next === null) return;
        event.preventDefault();
        setDetailHeight(next);
    }

    /** Open, or bring forward, the task's document in a tab of its own, at the task's line. */
    function openInTab(card: BoardCard): void {
        openConceptAtLine(card.document, card.line, panelId);
    }

    /** A card and the lane and section it is shown in, by its key. */
    function findCard(key: string): { card: BoardCard; cell: BoardCell } | null {
        for (const lane of lanes) {
            for (const section of lane.sections) {
                const card = section.cards.find((shown) => shown.key === key);
                if (card) return { card, cell: { status: lane.status, priority: section.priority } };
            }
        }
        return null;
    }

    /** What a card's context menu acts on: the card, on this board. */
    function cardTarget(card: BoardCard, cell: BoardCell): KanbanCardTarget {
        return { kind: "kanban.card", board: uid, card: card.key, label: card.label, status: cell.status, priority: cell.priority };
    }

    /** The card's menu from the keyboard, placed at the card rather than at a pointer. */
    function openCardMenu(card: BoardCard, cell: BoardCell, element: HTMLElement): void {
        const rect = element.getBoundingClientRect();
        openContextMenu(cardTarget(card, cell), rect.left + 12, rect.bottom - 4);
    }

    function describeCell(cell: BoardCell): string {
        const lane = BOARD_LANES.find((l) => l.status === cell.status)?.label ?? cell.status;
        const section = BOARD_SECTIONS.find((s) => s.priority === cell.priority)?.label ?? "";
        return `${lane}, ${section}`;
    }

    let holdTimer: ReturnType<typeof setTimeout> | undefined;

    type WriteRefusal = "stale" | "missing";
    type WrittenTask = Extract<TaskWriteOutcome, { ok: true }>;

    /**
     * Show `card` in `to` at once, run `write`, and put the card back with a notice when the write
     * is refused. A write is refused when the task changed under the board (its text edited, or
     * now on two tasks) or its document went away, and the board then reads again at once.
     */
    async function showWhileWriting(
        card: BoardCard,
        to: BoardCell,
        write: (store: DocumentStore) => Promise<TaskWriteOutcome>,
        said: string,
        refused: (reason: WriteRefusal) => string,
    ): Promise<WrittenTask | null> {
        const store = workspaceService("store");
        if (!store) return null;
        const moving: PendingMove = { card, to, writtenAt: null };
        // One pending move per task: moving a card again replaces its first move.
        pending = [...pending.filter((move) => !sameTask(move.card, card)), moving];
        notice = null;
        announcement = said;
        const outcome = await write(store);
        if (!outcome.ok) {
            pending = pending.filter((move) => move !== moving);
            notice = refused(outcome.reason);
            announcement = notice;
            // The card is back where it was, and a keyboard that was on it goes back with it.
            if (activeKey === card.key) void focusCard(card.key);
            retry();
            return null;
        }
        // The board remembers what it wrote, so moving the card again before the index catches up
        // addresses the line as it is now. The key stays, so a card the keyboard is on keeps focus.
        const written: PendingMove = { card: { ...card, line: outcome.line, text: outcome.text }, to, writtenAt: Date.now() };
        pending = pending.map((move) => (move === moving ? written : move));
        // Read again once the hold has run out, so a move the index never confirms gives way even
        // when nothing else changes.
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => refresh.schedule(), HOLD_MS);
        return outcome;
    }

    /** Move a card to another lane or section, writing its new status or priority into its line. */
    async function moveCard(card: BoardCard, from: BoardCell, to: BoardCell): Promise<void> {
        if (from.status === to.status && from.priority === to.priority) return;
        const changes: TaskChanges = {};
        if (to.status !== from.status) changes.status = to.status;
        if (to.priority !== from.priority) changes.priority = to.priority;
        const outcome = await showWhileWriting(
            card,
            to,
            (store) => writeTaskChanges(store, { concept: card.document, line: card.line, text: card.text }, changes),
            `Moved "${card.label}" to ${describeCell(to)}`,
            (reason) =>
                reason === "missing"
                    ? `"${card.document}" was renamed or deleted after the board read it, so "${card.label}" was not moved.`
                    : `"${card.label}" changed after the board showed it, so it was not moved. The board has been read again.`,
        );
        if (outcome?.changed) {
            undoStack = [...undoStack, { document: card.document, label: card.label, line: outcome.line, before: outcome.before, after: outcome.after, from, to }];
            redoStack = [];
        }
    }

    /**
     * One move the board made, kept so Mod+Z can put its line back exactly, tag order and all. The
     * history belongs to the open board: it is gone when the board closes.
     */
    interface HistoryEntry {
        document: string;
        label: string;
        /** Where the task's line was after the write, body-relative. */
        line: number;
        /** The whole line before and after the move. */
        before: string;
        after: string;
        from: BoardCell;
        to: BoardCell;
    }
    let undoStack: HistoryEntry[] = [];
    let redoStack: HistoryEntry[] = [];

    /** The card the board shows for a history entry's task, or one made from the entry. */
    function cardForEntry(entry: HistoryEntry, line: string): BoardCard {
        const wanted: BoardCard = {
            key: cardKey(entry.document, entry.line),
            document: entry.document,
            line: entry.line,
            text: bulletLabel(line),
            label: entry.label,
            due: null,
            dueState: null,
            parent: null,
        };
        for (const lane of lanes) {
            for (const section of lane.sections) {
                const shown = section.cards.find((card) => sameTask(card, wanted));
                if (shown) return shown;
            }
        }
        return wanted;
    }

    /**
     * Undo the board's last move: the earlier line goes back, but only while the task's line still
     * reads what the move wrote, so an edit made since is never overwritten.
     */
    async function undo(): Promise<void> {
        const entry = undoStack.at(-1);
        if (!entry) return;
        undoStack = undoStack.slice(0, -1);
        const card = cardForEntry(entry, entry.after);
        const outcome = await showWhileWriting(
            card,
            entry.from,
            (store) => restoreTaskLine(store, { concept: entry.document, line: entry.line, text: bulletLabel(entry.after) }, entry.after, entry.before),
            `Undid the move of "${entry.label}", back to ${describeCell(entry.from)}`,
            (reason) =>
                reason === "missing"
                    ? `"${entry.document}" was renamed or deleted, so the move of "${entry.label}" was not undone.`
                    : `"${entry.label}" has changed since it was moved, so the move was not undone.`,
        );
        if (outcome) redoStack = [...redoStack, { ...entry, line: outcome.line }];
        if (activeKey === card.key) followMovedCard(card.key, outcome ? entry.from : entry.to);
    }

    /** Redo the move the last undo took back, on the same condition. */
    async function redo(): Promise<void> {
        const entry = redoStack.at(-1);
        if (!entry) return;
        redoStack = redoStack.slice(0, -1);
        const card = cardForEntry(entry, entry.before);
        const outcome = await showWhileWriting(
            card,
            entry.to,
            (store) => restoreTaskLine(store, { concept: entry.document, line: entry.line, text: bulletLabel(entry.before) }, entry.before, entry.after),
            `Moved "${entry.label}" to ${describeCell(entry.to)} again`,
            (reason) =>
                reason === "missing"
                    ? `"${entry.document}" was renamed or deleted, so the move of "${entry.label}" was not redone.`
                    : `"${entry.label}" has changed since the move was undone, so it was not redone.`,
        );
        if (outcome) undoStack = [...undoStack, { ...entry, line: outcome.line }];
        if (activeKey === card.key) followMovedCard(card.key, outcome ? entry.to : entry.from);
    }

    async function focusCard(key: string): Promise<void> {
        await tick();
        lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-key="${CSS.escape(key)}"]`)?.focus();
    }

    /**
     * The keyboard on a card: Alt with an arrow moves it one lane or one priority, as Alt with an
     * arrow moves a block in the outliner; an arrow alone moves the keyboard to the next card.
     */
    function onCardKeydown(event: KeyboardEvent, card: BoardCard, cell: BoardCell): void {
        // The Menu key and Shift+F10 open the card's menu, as a right-click does.
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            openCardMenu(card, cell, event.currentTarget as HTMLElement);
            return;
        }
        if (event.ctrlKey || event.metaKey || event.shiftKey) return;
        const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
        const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
        if (!horizontal && !vertical) return;
        event.preventDefault();
        if (!event.altKey) {
            walkFocus(event.currentTarget as HTMLElement, event.key);
            return;
        }
        const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
        let to: BoardCell | undefined;
        if (horizontal) {
            const status = laneAfter(cell.status, step);
            if (status !== undefined) to = { status, priority: cell.priority };
        } else {
            const priority = sectionAfter(cell.priority, step);
            if (priority !== undefined) to = { status: cell.status, priority };
        }
        if (!to) return;
        void moveCard(card, cell, to);
        followMovedCard(card.key, to);
    }

    /** Up and down within a lane; left and right to the nearest card of the next lane that has any. */
    function walkFocus(from: HTMLElement, key: string): void {
        const laneEls = [...(lanesEl?.querySelectorAll<HTMLElement>('[data-testid="kanban-lane"]') ?? [])];
        const laneIndex = laneEls.findIndex((lane) => lane.contains(from));
        if (laneIndex < 0) return;
        const cardsIn = (lane: HTMLElement) => [...lane.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]')];
        if (key === "ArrowUp" || key === "ArrowDown") {
            const cards = cardsIn(laneEls[laneIndex]);
            cards[cards.indexOf(from) + (key === "ArrowUp" ? -1 : 1)]?.focus();
            return;
        }
        const step = key === "ArrowLeft" ? -1 : 1;
        const top = from.getBoundingClientRect().top;
        for (let l = laneIndex + step; l >= 0 && l < laneEls.length; l += step) {
            const cards = cardsIn(laneEls[l]);
            if (cards.length === 0) continue;
            const distance = (card: HTMLElement) => Math.abs(card.getBoundingClientRect().top - top);
            cards.reduce((best, card) => (distance(card) < distance(best) ? card : best)).focus();
            return;
        }
    }

    /**
     * A card being carried by the mouse. Nothing is written until it is let go over a section,
     * and a press that has not yet moved `DRAG_THRESHOLD_PX` is still a click.
     */
    interface CardDrag {
        pointerId: number;
        card: BoardCard;
        from: BoardCell;
        startX: number;
        startY: number;
        x: number;
        y: number;
        /** Past the threshold: the card is being carried rather than clicked. */
        started: boolean;
        /** Where in the card it was picked up, so the carried copy keeps that spot under the pointer. */
        offsetX: number;
        offsetY: number;
        width: number;
        /** The section the card would land in if let go now. */
        over: BoardCell | null;
    }
    let drag = $state.raw<CardDrag | null>(null);
    /** The click a finished or abandoned drag ends with is not a click on the card. */
    let suppressClick = false;
    let boardEl = $state<HTMLElement>();
    let scrollFrame = 0;

    /**
     * The section at a point, read from the lane and section it is in, or null outside every
     * lane. Anywhere on a lane lands in it: over a section, in that section, and elsewhere (its
     * header, its padding) in the section nearest the pointer's height. No priority fills the lane
     * to its foot, so a card let go below the other sections lands there. A collapsed lane's strip
     * has no sections, so a card let go over it keeps the priority it was carried from
     * (`priority`) and changes only its status.
     */
    function cellAt(x: number, y: number, priority: BoardCell["priority"]): BoardCell | null {
        const under = document.elementFromPoint(x, y);
        const laneEl = under?.closest<HTMLElement>('[data-testid="kanban-lane"]');
        if (!laneEl || !boardEl?.contains(laneEl)) return null;
        const status = laneEl.dataset.status as TaskStatus;
        if (laneEl.dataset.collapsed === "true") return { status, priority };
        const sectionEl = under?.closest<HTMLElement>('[data-testid="kanban-section"]') ?? nearestSection(laneEl, y);
        if (!sectionEl) return null;
        const section = sectionEl.dataset.priority;
        return { status, priority: section === "none" ? null : (Number(section) as 1 | 2 | 3) };
    }

    /** The lane's section nearest a height on the screen: the one it falls within, or the closest above or below it. */
    function nearestSection(laneEl: HTMLElement, y: number): HTMLElement | null {
        let nearest: HTMLElement | null = null;
        let distance = Infinity;
        for (const sectionEl of laneEl.querySelectorAll<HTMLElement>('[data-testid="kanban-section"]')) {
            const box = sectionEl.getBoundingClientRect();
            const away = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
            if (away < distance) {
                nearest = sectionEl;
                distance = away;
            }
        }
        return nearest;
    }

    function sameCell(a: BoardCell | null, b: BoardCell | null): boolean {
        return a !== null && b !== null && a.status === b.status && a.priority === b.priority;
    }

    function onCardPointerDown(event: PointerEvent, card: BoardCard, cell: BoardCell): void {
        suppressClick = false;
        // The primary button of a mouse or pen only: a right-click opens the card's menu, and
        // the board is not built for touch, where the menu moves a card instead.
        if (event.button !== 0 || event.pointerType === "touch") return;
        const target = event.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        // The card keeps receiving the pointer wherever it goes, so the move and release
        // handlers can stay on the card.
        target.setPointerCapture(event.pointerId);
        drag = {
            pointerId: event.pointerId,
            card,
            from: cell,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            started: false,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            width: rect.width,
            over: null,
        };
    }

    function onCardPointerMove(event: PointerEvent): void {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const started = drag.started || pastThreshold(event.clientX - drag.startX, event.clientY - drag.startY);
        drag = { ...drag, started, x: event.clientX, y: event.clientY, over: started ? cellAt(event.clientX, event.clientY, drag.from.priority) : null };
        if (started && !scrollFrame) scrollFrame = requestAnimationFrame(scrollWhileDragging);
    }

    function onCardPointerUp(event: PointerEvent): void {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const { card, from, over, started } = drag;
        endDrag();
        // A press that never moved is a click, which the card's click handler takes.
        if (!started) return;
        suppressClick = true;
        if (over && !sameCell(over, from)) {
            void moveCard(card, from, over);
            followMovedCard(card.key, over);
        }
    }

    function endDrag(): void {
        drag = null;
        cancelAnimationFrame(scrollFrame);
        scrollFrame = 0;
    }

    /**
     * While a card is carried near the edge of the board, or of the lane under it, scroll that
     * way, so a card can reach a lane or a section that is scrolled out of view. What is under the
     * pointer changes as the board scrolls, so the target is read again every frame.
     */
    function scrollWhileDragging(): void {
        scrollFrame = 0;
        if (!drag?.started || !lanesEl) return;
        const lanesRect = lanesEl.getBoundingClientRect();
        lanesEl.scrollLeft += edgeStep(drag.x, lanesRect.left, lanesRect.right);
        const body = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>("[data-kanban-lane-body]");
        if (body) {
            const bodyRect = body.getBoundingClientRect();
            body.scrollTop += edgeStep(drag.y, bodyRect.top, bodyRect.bottom);
        }
        const over = cellAt(drag.x, drag.y, drag.from.priority);
        if (!sameCell(over, drag.over) && !(over === null && drag.over === null)) drag = { ...drag, over };
        scrollFrame = requestAnimationFrame(scrollWhileDragging);
    }

    /**
     * Escape abandons a drag where it is, and letting go afterwards writes nothing. Mod+Z and
     * Mod+Shift+Z (or Mod+Y) undo and redo the board's own moves while the keyboard is on the
     * board, but not in the Task Detail, whose editor keeps its own history.
     */
    function onWindowKeydown(event: KeyboardEvent): void {
        if (drag?.started && event.key === "Escape") {
            event.preventDefault();
            endDrag();
            suppressClick = true;
            return;
        }
        if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
        const focused = document.activeElement;
        if (!boardEl || !focused || !boardEl.contains(focused) || focused.closest("[data-kanban-detail]")) return;
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
            event.preventDefault();
            void undo();
        } else if ((key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey)) {
            event.preventDefault();
            void redo();
        }
    }

    const DUE_CLASSES: Record<DueState, string> = {
        overdue: "bg-(--gk-danger-surface) text-(--gk-text-danger)",
        today: "bg-(--gk-warning-surface) text-(--gk-text-warning)",
        upcoming: "bg-(--gk-surface-2) text-(--gk-text-default)",
    };

    function dueLabel(card: BoardCard): string {
        if (card.dueState === "overdue") return `Overdue ${card.due}`;
        if (card.dueState === "today") return "Due today";
        return `Due ${card.due}`;
    }

    onMount(() => {
        const placeholderTimer = setTimeout(() => (slow = true), PLACEHOLDER_DELAY_MS);
        const unsubscribe = getActiveGraphIndex()?.onUpdated(() => {
            // Nothing read yet (a cold index finishing its build): answer at once. The settle is
            // there to keep typing from churning a board that is already on screen.
            if (board === null) void load();
            else refresh.schedule();
        });
        // A card's context menu acts through this board, found by its id.
        const unregisterBoard = registerBoard(uid, {
            open: (key) => {
                const found = findCard(key);
                if (found) open(found.card);
            },
            openInTab: (key) => {
                const found = findCard(key);
                if (found) openInTab(found.card);
            },
            // Through the shared Command, which knows the graph, the clipboard and how to say so.
            copyReference: (key) => {
                const found = findCard(key);
                if (!found) return;
                const { document, line, text } = found.card;
                void workspaceService("commands")?.execute(TASK_COPY_REFERENCE, { document, line, label: text });
            },
            move: (key, to) => {
                const found = findCard(key);
                if (!found) return;
                void moveCard(found.card, found.cell, to);
                // The card is drawn anew in its new section, so the keyboard follows it there.
                if (activeKey === key) followMovedCard(key, to);
            },
        }, {
            concept: view.target,
            documentRenamed: followDocumentRename,
            // As its tab does (GraphWorkspace's removal listener): closed, unless it is being typed
            // in, where the next keystroke has the last word (ADR 0039).
            documentRemoved: (removed) => {
                if (detail === null || conceptKey(detail.document) !== conceptKey(removed)) return;
                if (detailEl?.contains(document.activeElement)) return;
                closeDetail();
            },
            state: () => ({ ...boardState.get(), detail: currentDetail() }),
        });
        // A Lock Now closes a Protected Document's tab, and the Task Detail over one closes with it.
        const detachLockNow = tryGetActiveEventBus()?.on("protection:locked-now", () => {
            if (detail !== null && detailView?.isProtected()) closeDetail();
        });
        void load();
        return () => {
            clearTimeout(placeholderTimer);
            clearTimeout(holdTimer);
            unsubscribe?.();
            detachLockNow?.();
            unregisterBoard();
            refresh.cancel();
            endDrag();
            // A lane collapsed just before the tab closed is still remembered.
            boardState.flush();
        };
    });
</script>

<!-- A reload or a closed window unmounts nothing, so the remembered lanes are written as the page goes. -->
<svelte:window onkeydown={onWindowKeydown} onpagehide={() => boardState.flush()} />

{#if !desktop.current}
    <div class="flex h-full items-center justify-center bg-(--gk-surface-0) p-6" data-testid="kanban-needs-wider">
        <p class="m-0 max-w-sm text-center text-sm text-(--gk-text-muted)">
            The Kanban board needs a wider window. Widen this one, or open the board on a larger screen.
        </p>
    </div>
{:else}
    <div
        bind:this={boardEl}
        class="relative flex h-full flex-col overflow-clip bg-(--gk-surface-0) text-(--gk-text-default)"
        data-testid="kanban-board"
        data-concept={concept}
        aria-busy={loading}
    >
        <p id="{uid}-card-hint" class="sr-only">
            Arrow keys move between cards. Alt with an arrow key moves the card to another lane or priority. Shift+F10 opens the
            card's menu.
        </p>
        <p class="sr-only" role="status" data-testid="kanban-announcement">{announcement}</p>
        {#if failed}
            <div
                role="alert"
                class="mx-3 mt-3 flex items-center gap-3 rounded-lg bg-(--gk-danger-surface) px-3 py-2 text-sm text-(--gk-text-danger)"
                data-testid="kanban-error"
            >
                <span class="min-w-0 flex-1">Couldn't read the task index, so the board may be out of date.</span>
                <button
                    type="button"
                    onclick={retry}
                    class="shrink-0 rounded-md border border-current px-2 py-1 font-medium hover:bg-(--gk-surface-0)"
                    data-testid="kanban-retry"
                >
                    Retry
                </button>
            </div>
        {/if}
        {#if notice}
            <div
                role="alert"
                class="mx-3 mt-3 flex items-center gap-3 rounded-lg bg-(--gk-warning-surface) px-3 py-2 text-sm text-(--gk-text-warning)"
                data-testid="kanban-notice"
            >
                <span class="min-w-0 flex-1">{notice}</span>
                <button
                    type="button"
                    onclick={() => (notice = null)}
                    class="shrink-0 rounded-md border border-current px-2 py-1 font-medium hover:bg-(--gk-surface-0)"
                    data-testid="kanban-notice-dismiss"
                >
                    Dismiss
                </button>
            </div>
        {/if}
        <!-- The lanes scroll sideways when they are wider than the pane, and each lane scrolls
             on its own, so a long Done lane never stretches the others. -->
        <div bind:this={lanesEl} class="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3" data-testid="kanban-lanes">
            {#each lanes as lane (lane.status)}
                {#if collapsed.includes(lane.status)}
                    {@const dropTarget = drag?.started === true && drag.over?.status === lane.status}
                    <!-- A collapsed lane: a narrow strip with its name and count, which opens the
                         lane again when pressed and takes a card dropped on it. -->
                    <section
                        class={[
                            "flex w-12 shrink-0 flex-col rounded-xl border border-(--gk-border-soft) bg-(--gk-surface-1)",
                            dropTarget && "bg-(--gk-surface-2) outline-2 outline-(--gk-accent) outline-dashed",
                        ]}
                        data-testid="kanban-lane"
                        data-status={lane.status}
                        data-collapsed="true"
                        data-drop-target={dropTarget || undefined}
                        aria-labelledby="{uid}-{lane.status}"
                    >
                        <button
                            type="button"
                            onclick={() => toggleCollapsed(lane.status)}
                            class="flex min-h-0 flex-1 flex-col items-center gap-2 rounded-xl px-1 py-2.5 text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)"
                            aria-label="Expand the {lane.label} lane, {lane.total} {lane.total === 1 ? 'task' : 'tasks'}"
                            data-testid="kanban-lane-expand"
                        >
                            <!-- In-repo constant markup from the icon table, never user content. -->
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                            {@html iconSvg("kanban.expand-lane")}
                            {#if shown !== null}
                                <span class="text-sm text-(--gk-text-subtle)" data-testid="kanban-lane-count">{lane.total}</span>
                            {/if}
                            <span
                                id="{uid}-{lane.status}"
                                class="text-sm font-semibold text-(--gk-text-strong) [writing-mode:vertical-rl]"
                                data-testid="kanban-lane-label"
                            >
                                {lane.label}
                            </span>
                        </button>
                    </section>
                {:else}
                    <section
                        class="flex w-72 shrink-0 flex-col rounded-xl border border-(--gk-border-soft) bg-(--gk-surface-1)"
                        data-testid="kanban-lane"
                        data-status={lane.status}
                        aria-labelledby="{uid}-{lane.status}"
                    >
                        <header class="flex items-center justify-between gap-2 border-b border-(--gk-border-soft) py-1.5 pl-3 pr-1.5">
                            <h2 id="{uid}-{lane.status}" class="m-0 text-sm font-semibold text-(--gk-text-strong)" data-testid="kanban-lane-label">
                                {lane.label}
                            </h2>
                            <span class="flex items-center gap-1">
                                {#if shown !== null}
                                    <span class="text-sm text-(--gk-text-subtle)" data-testid="kanban-lane-count">{lane.total}</span>
                                {/if}
                                <button
                                    type="button"
                                    onclick={() => toggleCollapsed(lane.status)}
                                    class="grid size-7 place-items-center rounded-md text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--gk-accent)"
                                    aria-label="Collapse the {lane.label} lane"
                                    title="Collapse the {lane.label} lane"
                                    data-testid="kanban-lane-collapse"
                                >
                                    <!-- In-repo constant markup from the icon table, never user content. -->
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                                    {@html iconSvg("kanban.collapse-lane")}
                                </button>
                            </span>
                        </header>
                        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2" data-kanban-lane-body>
                            {#if empty && lane.status === emptyNoticeLane}
                                <p class="m-0 px-1 pt-2 text-sm text-(--gk-text-subtle)" data-testid="kanban-empty">
                                    No tasks belong to {concept} yet. Tasks on its page, or nested under a link to it, appear here.
                                </p>
                            {/if}
                            {#each lane.sections as section (section.label)}
                                {@const cell = { status: lane.status, priority: section.priority }}
                                {@const dropTarget = drag?.started === true && sameCell(drag.over, cell) && !sameCell(drag.from, cell)}
                                <!-- While a card is carried over it, the section it would land in is
                                     outlined, so a drop never lands somewhere unexpected. No priority,
                                     the last, fills the lane to its foot, so its outline and the drops
                                     it takes reach there however few cards it holds. -->
                                <div
                                    class={[
                                        "rounded-md",
                                        section.priority === null && "grow",
                                        dropTarget && "bg-(--gk-surface-2) outline-2 outline-(--gk-accent) outline-dashed",
                                    ]}
                                    data-testid="kanban-section"
                                    data-priority={section.priority ?? "none"}
                                    data-drop-target={dropTarget || undefined}
                                >
                                    <div class="flex items-baseline justify-between gap-2 px-1 pb-1 pt-2">
                                        <h3 class="m-0 text-sm font-medium text-(--gk-text-muted)" data-testid="kanban-section-label">
                                            {section.label}
                                        </h3>
                                        {#if section.total > 0}
                                            <span class="text-sm text-(--gk-text-subtle)" data-testid="kanban-section-count">{section.total}</span>
                                        {/if}
                                    </div>
                                    {#if showPlaceholders && section.priority === 1}
                                        <!-- Card-sized blocks while the first read is slow, so the
                                             lanes do not jump when the cards arrive. -->
                                        <div class="flex flex-col gap-2" aria-hidden="true">
                                            <div class="h-16 rounded-lg bg-(--gk-surface-2)"></div>
                                            <div class="h-16 rounded-lg bg-(--gk-surface-2)"></div>
                                        </div>
                                    {:else if section.cards.length > 0}
                                        <ul class="m-0 flex list-none flex-col gap-2 p-0">
                                            {#each section.cards as card (card.key)}
                                                {@const carried = drag?.started === true && drag.card.key === card.key}
                                                {@const selected = isSelected(card)}
                                                <li>
                                                    <button
                                                        type="button"
                                                        tabindex={card.key === tabKey ? 0 : -1}
                                                        aria-describedby="{uid}-card-hint"
                                                        aria-current={selected || undefined}
                                                        onclick={() => {
                                                            if (suppressClick) {
                                                                suppressClick = false;
                                                                return;
                                                            }
                                                            open(card);
                                                        }}
                                                        onfocus={() => (activeKey = card.key)}
                                                        onkeydown={(event) => onCardKeydown(event, card, cell)}
                                                        onpointerdown={(event) => onCardPointerDown(event, card, cell)}
                                                        onpointermove={onCardPointerMove}
                                                        onpointerup={onCardPointerUp}
                                                        onpointercancel={endDrag}
                                                        {@attach (node) => attachContextMenu(node, () => cardTarget(card, cell))}
                                                        class={[
                                                            "block w-full cursor-grab select-none rounded-lg border p-2.5 text-left shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)",
                                                            // The card left behind while its copy is carried: its outline only, so it
                                                            // still says where the card came from. The card the Task Detail shows
                                                            // keeps an accent edge while it does.
                                                            carried
                                                                ? "border-dashed border-(--gk-border-strong) bg-(--gk-surface-1)"
                                                                : selected
                                                                  ? "border-(--gk-accent) bg-(--gk-surface-0) ring-1 ring-(--gk-accent)"
                                                                  : "border-(--gk-border-soft) bg-(--gk-surface-0) hover:border-(--gk-border-strong)",
                                                        ]}
                                                        data-testid="kanban-card"
                                                        data-selected={selected || undefined}
                                                        data-key={card.key}
                                                        data-document={card.document}
                                                        data-line={card.line}
                                                    >
                                                        <span class="line-clamp-3 text-sm" data-testid="kanban-card-label"><KanbanCardText text={card.label} /></span>
                                                        {#if card.parent !== null}
                                                            <!-- A subtask is a card of its own; this keeps it tied to the task it sits under. -->
                                                            <span class="mt-1 block truncate text-sm text-(--gk-text-muted)" data-testid="kanban-card-parent">
                                                                in: <KanbanCardText text={card.parent} />
                                                            </span>
                                                        {/if}
                                                        <span class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                                            <span class="min-w-0 truncate text-(--gk-text-subtle)" data-testid="kanban-card-document">{card.document}</span>
                                                            {#if card.due !== null}
                                                                <span
                                                                    class={["rounded px-1.5 font-medium", DUE_CLASSES[card.dueState ?? "upcoming"]]}
                                                                    data-testid="kanban-card-due"
                                                                    data-due-state={card.dueState}
                                                                >
                                                                    {dueLabel(card)}
                                                                </span>
                                                            {/if}
                                                        </span>
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                        {#if section.hasMore}
                                            <button
                                                type="button"
                                                onclick={() => showMore(cell, section.cards.length)}
                                                class="mt-1 flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--gk-accent)"
                                                data-testid="kanban-section-more"
                                            >
                                                <span>Show {Math.min(SECTION_PAGE_SIZE, section.total - section.cards.length)} more</span>
                                                <span class="font-normal text-(--gk-text-subtle)">{section.cards.length} of {section.total}</span>
                                            </button>
                                        {/if}
                                    {/if}
                                </div>
                            {/each}
                        </div>
                    </section>
                {/if}
            {/each}
        </div>
        {#if detail !== null}
            <!-- The divider between the lanes and the Task Detail: dragged with a pointer, or moved
                 with the arrow keys once it has the focus (the window splitter pattern). A focusable
                 separator is a widget in ARIA, which the a11y check does not know. -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
            <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Task Detail height"
                aria-valuemin={20}
                aria-valuemax={80}
                aria-valuenow={Math.round(detailHeight * 100)}
                aria-valuetext="{Math.round(detailHeight * 100)}% of the board"
                tabindex="0"
                class="group relative h-2 shrink-0 cursor-row-resize touch-none focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
                onpointerdown={onDividerPointerDown}
                onpointermove={onDividerPointerMove}
                onpointerup={onDividerPointerUp}
                onpointercancel={onDividerPointerUp}
                onkeydown={onDividerKeydown}
                data-testid="kanban-detail-divider"
            >
                <div class="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-(--gk-border-soft) group-hover:h-0.5 group-hover:bg-(--gk-accent)"></div>
            </div>
            <!-- The Task Detail (ADR 0113): the task's document in an editor of its own, the task's
                 line at the top. Clipped rather than hidden, so revealing a line scrolls the editor
                 and never the board around it. Its keydown only watches an Escape the editor
                 inside has handled, to bring the keyboard back to the card. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <section
                bind:this={detailEl}
                class="flex min-h-0 shrink-0 flex-col overflow-clip border-t border-(--gk-border-soft) bg-(--gk-surface-0)"
                style:height="{detailHeight * 100}%"
                aria-labelledby="{uid}-detail-title"
                onkeydown={onDetailKeydown}
                data-kanban-detail
                data-testid="kanban-detail"
                data-document={detail.document}
            >
                <header class="flex items-center gap-2 border-b border-(--gk-border-soft) bg-(--gk-surface-1) py-1 pl-3 pr-1.5">
                    <h2 id="{uid}-detail-title" class="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-sm">
                        <span class="shrink-0 text-(--gk-text-muted)">Task Detail</span>
                        <span class="truncate font-semibold text-(--gk-text-strong)" data-testid="kanban-detail-document">{detail.document}</span>
                    </h2>
                    <button
                        type="button"
                        onclick={openDetailInTab}
                        class="shrink-0 rounded-md px-2 py-1 text-sm font-medium text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
                        data-testid="kanban-detail-open"
                    >
                        Open in tab
                    </button>
                    <button
                        type="button"
                        onclick={closeDetail}
                        class="grid size-7 shrink-0 place-items-center rounded-md text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
                        aria-label="Close the Task Detail"
                        title="Close the Task Detail"
                        data-testid="kanban-detail-close"
                    >
                        <!-- In-repo constant markup from the icon table, never user content. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html iconSvg("close")}
                    </button>
                </header>
                <div class="min-h-0 flex-1 overflow-clip">
                    {#key detail.document}
                        <DocumentView
                            bind:this={detailView}
                            view={{ kind: "document", target: detail.document }}
                            {panelId}
                            embedded
                            revealAt={detail.line}
                        />
                    {/key}
                </div>
            </section>
        {/if}
        {#if drag?.started && boardEl}
            <!-- The carried copy, placed inside the board rather than fixed to the window, since a
                 transformed ancestor in the workspace would move a fixed box. It ignores the
                 pointer, so what is under the pointer is the section beneath it. -->
            {@const origin = boardEl.getBoundingClientRect()}
            <div
                class="pointer-events-none absolute z-50 rotate-1 rounded-lg border border-(--gk-border-strong) bg-(--gk-surface-0) p-2.5 text-left text-sm shadow-lg"
                style:left="{drag.x - origin.left - drag.offsetX}px"
                style:top="{drag.y - origin.top - drag.offsetY}px"
                style:width="{drag.width}px"
                data-testid="kanban-drag-ghost"
                aria-hidden="true"
            >
                <span class="line-clamp-3"><KanbanCardText text={drag.card.label} /></span>
            </div>
        {/if}
    </div>
{/if}
