<script lang="ts">
    /**
     * The [[Kanban Board]] (ADR 0113): the tasks that answer to one [[Concept]], or every task in
     * the graph on the Graph Kanban, set out in a [[Lane]] per [[Task Status]] and a section per
     * priority. A lens over documents: every card
     * is a task line the [[Derived Index]] reported, and moving a card rewrites that line.
     *
     * A move shows at once. The card holds its new place until the index agrees, or gives way to
     * the index after a while; a write that is refused puts it back with a notice. Nothing about
     * a move is kept anywhere but in the task's own text.
     *
     * Desktop only. Under the phone layout the board says so rather than squeezing six lanes
     * into a phone's width, and the menus that open one are hidden there.
     *
     * Mounted through the dockview adapter, so it reads its services through module accessors
     * rather than Svelte context (a separate Svelte root has none to inherit).
     */
    import { onMount, tick } from "svelte";
    import { MediaQuery } from "svelte/reactivity";

    import { conceptKey, getActiveGraphIndex, type TaskStatus, taskDateKey } from "#lib/document/backlinks/index.js";
    import { openConceptAtLine } from "#lib/document/open-concept.js";
    import { createSettleScheduler, TASK_TEXT_FILTER_SETTLE } from "#lib/document/settle-scheduler.js";
    import { bulletLabel, parseTaskTextFilter } from "#lib/document/index-derive.js";
    import { findIndexedTask, isTaskLine, type TaskChanges, type TaskWrite, type TaskWriteOutcome, undoTaskWrite, writeTaskChanges } from "#lib/document/task-write.js";
    import type { DocumentStore } from "#lib/document/types.js";
    import { TASK_COPY_LANE_REFERENCE, TASK_COPY_REFERENCE } from "#lib/document/commands/task-reference-commands.js";
    import DocumentView from "#lib/document/view/DocumentView.svelte";
    import type { ViewRef, ViewVisibility } from "#lib/layout/index.js";
    import { DESKTOP_MEDIA_QUERY } from "#lib/layout/breakpoint.js";
    import { attachContextMenu, openContextMenu } from "#lib/surface/context-menu-store.js";
    import { tryGetActiveEventBus } from "#lib/surface/active-bus.js";
    import { iconSvg } from "#lib/surface/icons.js";
    import { currentWorkspaceServices, workspaceService } from "#lib/workspace/workspace-services.js";

    import { createAgentHint } from "./agent-hint";
    import { type MoveSource, registerBoard, takeBoardHandover } from "./board-actions";
    import { createBoardStateStore, type TaskDetailState } from "./board-state";

    import {
        BOARD_LANES,
        BOARD_SECTIONS,
        boardConceptOf,
        type BoardCard,
        type BoardCell,
        type BoardLane,
        type BoardSnapshot,
        cardKey,
        type DueState,
        laneAfter,
        MOVE_TARGETS,
        type PendingMove,
        sameTask,
        sectionAfter,
        passesFilter,
        taskDetailCard,
        unsettledMoves,
        withPendingMoves,
    } from "./board-model";
    import { laneTasks, readBoard, SECTION_PAGE_SIZE } from "./board-queries";
    import KanbanCardText from "./KanbanCardText.svelte";
    import TaskEditor from "./TaskEditor.svelte";
    import type { ArchivedTask, TaskEditorStart } from "./task-editor-model";
    import { type RemovedTask, restoreTask } from "./task-editor-writes";
    import type { KanbanCardTarget, KanbanLaneTarget } from "./kanban-commands";
    import { type MovedTask, moveTasks, revertMoves } from "./lane-move";
    import { centreWithin, movedOutOfViewText } from "./move-follow";
    import { edgeStep, pastThreshold } from "./pointer-drag";
    import { dragSeparator, separatorKeyValue } from "./separator";

    // `visibility` reaches the Task Detail's editor, so a map in it lets go behind another tab.
    const { view, panelId, visibility }: { view: ViewRef; panelId?: string; visibility?: ViewVisibility } = $props();

    const uid = $props.id();
    /** The board's concept, or null on the Graph Kanban, which reads every task in the graph. */
    const concept = $derived(boardConceptOf(view));
    const desktop = new MediaQuery(DESKTOP_MEDIA_QUERY);

    /** The board's shape with nothing in it, drawn while the first read is under way. */
    const EMPTY_LANES: BoardLane[] = BOARD_LANES.map((lane) => ({
        ...lane,
        total: 0,
        loaded: true,
        filter: null,
        unfiltered: 0,
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
    // The line above the lanes saying an agent can work on these tasks, until it is dismissed.
    const agentHint = createAgentHint();
    let agentHintShown = $state(agentHint.shown());
    /** The last move, said once for screen readers; the board already shows it. */
    let announcement = $state("");
    /**
     * What the last move brought with it: the nested tasks a move into Done ticked, or a move out of
     * a ticked lane unticked (`task-cascade.ts`). Their cards move too once the index catches up, so
     * the board says so, and offers to undo the whole move to a pointer that has no Mod+Z. `entry`
     * is the move to undo; null once the line only reports what an undo did.
     */
    // Raw, so `entry` stays the history entry itself, not a proxy of it: an undo finds it by identity.
    let cascade = $state.raw<{ text: string; entry: BoardHistory | null } | null>(null);
    /** What the [[Task Editor]] is open on (ADR 0170), or null while it is closed. */
    let taskEditor = $state.raw<TaskEditorStart | null>(null);
    /** A task the Task Editor deleted, which the board offers to put back. */
    let deleted = $state.raw<{ text: string; removed: RemovedTask | null } | null>(null);
    /** The card the keyboard is on, the one card in the tab order. */
    let activeKey = $state<string | null>(null);
    let lanesEl = $state<HTMLElement>();

    /**
     * What this device remembers about the board. A View's target is fixed for its life (a rename
     * opens the board afresh under the new name), so the store is keyed once. A board opened by a
     * rename starts from the state of the board it replaces, which that board handed over.
     */
    // svelte-ignore state_referenced_locally
    const boardState = createBoardStateStore(currentWorkspaceServices()?.graphId ?? "", boardConceptOf(view));
    // svelte-ignore state_referenced_locally
    const handedOver = boardConceptOf(view) === null ? undefined : takeBoardHandover(view.target);
    if (handedOver) boardState.set(handedOver);
    /** Lanes shown as a narrow strip with their count. */
    let collapsed = $state<TaskStatus[]>(boardState.get().collapsed);
    /** How many cards a section shows, where Show more has raised it past the first page. */
    let limits = $state.raw<ReadonlyMap<string, number>>(new Map());
    const cellId = (cell: BoardCell) => `${cell.status}:${cell.priority ?? "none"}`;
    /**
     * The [[Lane Filter]]s, as typed, by the lane whose input is open. Not remembered: closing or
     * reloading shows the whole lane again, so a board never opens looking short of tasks.
     */
    let laneFilters = $state.raw<ReadonlyMap<TaskStatus, string>>(new Map());

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
    const empty = $derived(shown !== null && shown.lanes.every((lane) => lane.unfiltered === 0));
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
                textFilterFor: (status) => laneFilters.get(status),
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
        filterSettled.cancel();
        void load();
    }

    /** A read per pause in typing into a Lane Filter, the previous cards staying until it lands. */
    const filterSettled = createSettleScheduler(() => void load(), TASK_TEXT_FILTER_SETTLE);

    function withoutLaneFilter(status: TaskStatus): ReadonlyMap<TaskStatus, string> {
        const next = new Map(laneFilters);
        next.delete(status);
        return next;
    }

    /** Open a lane's filter input, which takes the keyboard, or close it. */
    function toggleLaneFilter(status: TaskStatus): void {
        if (laneFilters.has(status)) closeLaneFilter(status);
        else laneFilters = new Map(laneFilters).set(status, "");
    }

    function onLaneFilterInput(status: TaskStatus, typed: string): void {
        laneFilters = new Map(laneFilters).set(status, typed);
        filterSettled.schedule();
    }

    /** Close a lane's filter input, which clears the filter, and hand the keyboard back to the lane's search button. */
    function closeLaneFilter(status: TaskStatus): void {
        laneFilters = withoutLaneFilter(status);
        retry();
        void tick().then(() => lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-lane"][data-status="${status}"] [data-testid="kanban-lane-filter-toggle"]`)?.focus());
    }

    /**
     * Collapse or expand a lane, remember it on this device, and read the board for it. The button
     * pressed is replaced by its opposite (the strip's for the header's), and the keyboard moves
     * to that one rather than falling out of the board.
     */
    function toggleCollapsed(status: TaskStatus): void {
        const collapsing = !collapsed.includes(status);
        // A strip has no room for the filter, and its count has to be the whole lane's.
        if (collapsing) laneFilters = withoutLaneFilter(status);
        collapsed = collapsing ? [...collapsed, status] : collapsed.filter((s) => s !== status);
        boardState.set({ ...boardState.get(), collapsed: [...collapsed] });
        retry();
        void focusLaneButton(status, collapsing ? "kanban-lane-expand" : "kanban-lane-collapse");
    }

    async function focusLaneButton(
        status: TaskStatus,
        testid: "kanban-lane-expand" | "kanban-lane-collapse",
        options?: { preventScroll: boolean },
    ): Promise<void> {
        await tick();
        lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-lane"][data-status="${status}"] [data-testid="${testid}"]`)?.focus(options);
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
    function focusStrip(status: TaskStatus, options?: { preventScroll: boolean }): Promise<void> {
        return focusLaneButton(status, "kanban-lane-expand", options);
    }

    /**
     * After a move, keep the keyboard with the card, or on the strip of the collapsed lane it went
     * into. A keyboard move scrolls to it, since the keyboard goes where the card went; a pointer
     * move leaves the lanes' scroll where it was (`move-follow.ts`), and the focus still moves, so a
     * key pressed next acts on the card. A card the lane's Lane Filter hides has no element to hold
     * the keyboard, so the filter's input takes it.
     */
    function followMovedCard(key: string, to: BoardCell, source: MoveSource = "keyboard"): void {
        const options = { preventScroll: source === "pointer" };
        if (collapsed.includes(to.status)) void focusStrip(to.status, options);
        else if (laneFilters.has(to.status)) void focusCardOrLaneFilter(key, to.status, options);
        else void focusCard(key, options);
    }

    async function focusCardOrLaneFilter(key: string, status: TaskStatus, options: { preventScroll: boolean }): Promise<void> {
        await tick();
        const laneEl = lanesEl?.querySelector(`[data-testid="kanban-lane"][data-status="${status}"]`);
        const target = laneEl?.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-key="${CSS.escape(key)}"]`) ?? laneEl?.querySelector<HTMLElement>('[data-testid="kanban-lane-filter-input"]');
        target?.focus(options);
    }

    /**
     * Whether the board should say where a moved card went. A pointer move does when the card did not
     * land in sight; a keyboard move scrolls to its card, so only when a Lane Filter hides the card.
     * An archived card leaves the board, which is what Archive is for: nothing to point to.
     */
    async function movedOutOfSight(card: BoardCard, to: BoardCell, source: MoveSource): Promise<boolean> {
        if (to.status === "archived") return false;
        if (source === "pointer") return !(await landedInView(card.key, to.status));
        // What is typed, not the read's: the read of a filter typed a moment ago may not have landed.
        return !passesFilter({ filter: parseTaskTextFilter(laneFilters.get(to.status) ?? "") }, card);
    }

    /**
     * Whether a moved card shows where it landed: its middle inside the lanes and inside its lane's
     * body, both of which scroll. In a collapsed lane, whether the lane's strip shows. A card the
     * board does not draw at all (past a section's Show more) is not in view. Measured once the
     * board has drawn the card where it went.
     */
    async function landedInView(key: string, status: TaskStatus): Promise<boolean> {
        await tick();
        const laneEl = lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-lane"][data-status="${status}"]`);
        if (!lanesEl || !laneEl) return false;
        const clips = [lanesEl.getBoundingClientRect()];
        if (laneEl.dataset.collapsed === "true") return centreWithin(laneEl.getBoundingClientRect(), clips);
        const cardEl = laneEl.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-key="${CSS.escape(key)}"]`);
        const body = laneEl.querySelector<HTMLElement>("[data-kanban-lane-body]");
        if (!cardEl || !body) return false;
        return centreWithin(cardEl.getBoundingClientRect(), [...clips, body.getBoundingClientRect()]);
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
     * the board so the arrows keep walking the cards: the card menu's Open in pane below (a click opens the
     * Task Editor, ADR 0170). Opening the card the Task Detail already shows puts the caret at the
     * end of the task's line instead, to write there.
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

    function setDetailHeight(share: number): void {
        boardState.set({ ...boardState.get(), detailHeight: share });
        // The store keeps it between a fifth and four fifths of the board.
        detailHeight = boardState.get().detailHeight;
    }

    /** A drag on the divider sets the Task Detail's share from where the pointer is (`separator.ts`). */
    function onDividerPointerDown(event: PointerEvent): void {
        dragSeparator(event, (move) => {
            const rect = boardEl?.getBoundingClientRect();
            if (rect && rect.height > 0) setDetailHeight((rect.bottom - move.clientY) / rect.height);
        });
    }

    /**
     * The arrow keys move the divider; Home and End take it to either end (the splitter pattern). The
     * Task Detail is below the divider, so moving it up makes the Task Detail taller.
     */
    function onDividerKeydown(event: KeyboardEvent): void {
        const next = separatorKeyValue(event.key, detailHeight, { min: 0, max: 1, step: DIVIDER_STEP, growsDownward: false });
        if (next === null) return;
        event.preventDefault();
        setDetailHeight(next);
    }

    /**
     * Copy a Task Reference to the card's task, through the shared Command, which knows the graph,
     * the clipboard and how to say so.
     */
    function copyReference(card: BoardCard): void {
        const { document, line, text } = card;
        void workspaceService("commands")?.execute(TASK_COPY_REFERENCE, { document, line, label: text });
    }

    /**
     * Copy a [[Lane Reference]] to one of the board's lanes, through the shared Command, which knows
     * the graph, the clipboard and how to say so. The count is every task the lane holds, as its
     * header shows, not only the cards loaded.
     */
    function copyLaneReference(status: TaskStatus): void {
        const lane = lanes.find((shown) => shown.status === status);
        if (!lane) return;
        void workspaceService("commands")?.execute(TASK_COPY_LANE_REFERENCE, { concept, status, label: lane.label, count: lane.unfiltered });
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
        openContextMenu({ ...cardTarget(card, cell), fromKeyboard: true }, rect.left + 12, rect.bottom - 4);
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

    /**
     * Move a card to another lane or section, writing its new status or priority into its line. A
     * card moved with the pointer to where the board does not show it is said in the board's status
     * line, with Undo, since the board does not scroll after it.
     */
    async function moveCard(card: BoardCard, from: BoardCell, to: BoardCell, source: MoveSource = "keyboard"): Promise<void> {
        if (from.status === to.status && from.priority === to.priority) return;
        cascade = null;
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
            const entry: HistoryEntry = { document: card.document, label: card.label, from, to, write: writtenPart(outcome) };
            undoStack = [...undoStack, entry];
            redoStack = [];
            const unseen = await movedOutOfSight(card, to, source);
            const count = outcome.nested.length;
            if (count > 0) {
                const verb = to.status === "done" ? "Ticked" : to.status === "archived" ? "Archived" : "Unticked";
                const nested = `${verb} ${count === 1 ? "1 task" : `${count} tasks`} nested under`;
                cascade = {
                    text: unseen ? `${movedOutOfViewText(card.label, from, to)} ${nested} it.` : `${nested} "${card.label}".`,
                    entry,
                };
                announcement = `${announcement}. ${cascade.text}`;
            } else if (unseen) {
                cascade = { text: movedOutOfViewText(card.label, from, to), entry };
            }
        }
    }

    /** The lines a write changed, which is all an undo of it needs. */
    function writtenPart(outcome: WrittenTask): TaskWrite {
        return { line: outcome.line, before: outcome.before, after: outcome.after, nested: outcome.nested };
    }

    /**
     * One move the board made, kept so Mod+Z can put its line back exactly, tag order and all. The
     * history belongs to the open board: it is gone when the board closes.
     */
    interface HistoryEntry {
        document: string;
        label: string;
        /** The cells the move went from and to: an undo goes back to `from`, a redo to `to`. */
        from: BoardCell;
        to: BoardCell;
        /**
         * The write that undoing this entry puts back: on the undo stack the move itself, on the redo
         * stack the undo's own write. Its line is where the task's line was after it, body-relative,
         * and its nested lines are the nested tasks the move brought with it.
         */
        write: TaskWrite;
    }
    /**
     * A Move all to lane (ADR 0167), kept as one move so one undo takes back every task it wrote.
     * `writes` are, on the undo stack, the lines the move changed, and on the redo stack the lines
     * its undo changed: reverting either makes the other.
     */
    interface LaneMoveEntry {
        kind: "lane";
        from: TaskStatus;
        to: TaskStatus;
        moved: number;
        writes: MovedTask[];
    }
    type BoardHistory = HistoryEntry | LaneMoveEntry;
    const isLaneMove = (entry: BoardHistory): entry is LaneMoveEntry => "kind" in entry && entry.kind === "lane";

    let undoStack: BoardHistory[] = [];
    let redoStack: BoardHistory[] = [];

    /** The card the board shows for a history entry's task, or one made from the entry. */
    function cardForEntry(entry: HistoryEntry): BoardCard {
        const wanted: BoardCard = {
            key: cardKey(entry.document, entry.write.line),
            document: entry.document,
            line: entry.write.line,
            text: bulletLabel(entry.write.after),
            label: entry.label,
            freeTags: [],
            freeTag: null,
            due: null,
            dueState: null,
            parent: null,
            inConcept: null,
            subtasks: { done: 0, total: 0 },
        };
        for (const lane of lanes) {
            for (const section of lane.sections) {
                const shown = section.cards.find((card) => sameTask(card, wanted));
                if (shown) return shown;
            }
        }
        return wanted;
    }

    /** Undo the board's last move. */
    async function undo(): Promise<void> {
        const entry = undoStack.at(-1);
        if (!entry) return;
        if (isLaneMove(entry)) await undoLaneMove(entry);
        else await undoEntry(entry);
    }

    /**
     * Undo the move the cascade line names, which need not be the last, and say what it did: a
     * refusal is said by the board's notice, as for any undo.
     */
    async function undoCascade(): Promise<void> {
        const entry = cascade?.entry;
        if (!entry) return;
        if (isLaneMove(entry)) {
            await undoLaneMove(entry);
            return;
        }
        const outcome = await undoEntry(entry);
        if (!outcome.ok) return;
        const { skipped } = outcome;
        cascade = {
            entry: null,
            text:
                entry.write.nested.length === 0
                    ? `Undone: "${entry.label}" is back in ${describeCell(entry.from)}.`
                    : skipped === 0
                      ? `Undone: "${entry.label}" and the tasks nested under it are as they were.`
                      : skipped === 1
                        ? "Undone, except 1 nested task that changed since. It was left as it is."
                        : `Undone, except ${skipped} nested tasks that changed since. They were left as they are.`,
        };
    }

    /**
     * Undo one move, the last or the one the cascade line names: the earlier lines go back, but only
     * while the task's line still reads what the move wrote, so an edit made since is never
     * overwritten (`undoTaskWrite`). Nested lines changed since are left, and counted.
     */
    async function undoEntry(entry: HistoryEntry): Promise<TaskWriteOutcome> {
        if (!undoStack.includes(entry)) return { ok: false, reason: "stale" };
        undoStack = undoStack.filter((e) => e !== entry);
        // The line offers this move's undo, which is now under way: take it down, so it cannot run twice.
        if (cascade?.entry === entry) cascade = null;
        const card = cardForEntry(entry);
        let result: TaskWriteOutcome = { ok: false, reason: "stale" };
        const outcome = await showWhileWriting(
            card,
            entry.from,
            async (store) => (result = await undoTaskWrite(store, entry.document, entry.write)),
            `Undid the move of "${entry.label}", back to ${describeCell(entry.from)}`,
            (reason) =>
                reason === "missing"
                    ? `"${entry.document}" was renamed or deleted, so the move of "${entry.label}" was not undone.`
                    : `"${entry.label}" has changed since it was moved, so the move was not undone.`,
        );
        if (outcome) redoStack = [...redoStack, { ...entry, write: writtenPart(outcome) }];
        if (activeKey === card.key) followMovedCard(card.key, outcome ? entry.from : entry.to);
        return result;
    }

    /** Redo the move the last undo took back, on the same condition. */
    async function redo(): Promise<void> {
        const entry = redoStack.at(-1);
        if (!entry) return;
        redoStack = redoStack.slice(0, -1);
        if (isLaneMove(entry)) {
            await redoLaneMove(entry);
            return;
        }
        const card = cardForEntry(entry);
        const outcome = await showWhileWriting(
            card,
            entry.to,
            (store) => undoTaskWrite(store, entry.document, entry.write),
            `Moved "${entry.label}" to ${describeCell(entry.to)} again`,
            (reason) =>
                reason === "missing"
                    ? `"${entry.document}" was renamed or deleted, so the move of "${entry.label}" was not redone.`
                    : `"${entry.label}" has changed since the move was undone, so it was not redone.`,
        );
        if (outcome) undoStack = [...undoStack, { ...entry, write: writtenPart(outcome) }];
        if (activeKey === card.key) followMovedCard(card.key, outcome ? entry.to : entry.from);
    }

    // ── Move all to lane (ADR 0167) ─────────────────────────────────────────

    /** A Move all to lane under way, which a second one waits for rather than racing. */
    let movingLane = false;

    const statusLabel = (status: TaskStatus) => MOVE_TARGETS.find((lane) => lane.status === status)?.label ?? status;
    const tasks = (count: number) => (count === 1 ? "1 task" : `${count} tasks`);

    /**
     * Move every task in the lane `from`, read whole from the index rather than from the cards on
     * screen (a lane may be collapsed, or show only its first page), into `to`, and keep the move as
     * one entry an undo takes back. The board says it is under way, then what it did, with Undo.
     */
    async function moveLane(from: TaskStatus, to: TaskStatus): Promise<void> {
        const store = workspaceService("store");
        const index = getActiveGraphIndex();
        if (movingLane || !store || !index || from === to) return;
        movingLane = true;
        notice = null;
        cascade = { text: `Moving the tasks in ${statusLabel(from)} to ${statusLabel(to)}…`, entry: null };
        try {
            // Today is read now, not at mount: a board is left open for days.
            const hits = await laneTasks(index, concept, from, taskDateKey(new Date()), { textFilter: laneFilters.get(from) });
            const moved = await moveTasks(
                store,
                hits.map((hit) => ({ concept: hit.concept, line: hit.line, text: hit.text })),
                to,
            );
            const entry: LaneMoveEntry = { kind: "lane", from, to, moved: moved.moved, writes: moved.writes };
            if (moved.writes.length > 0) {
                undoStack = [...undoStack, entry];
                redoStack = [];
            }
            const one = moved.refused === 1;
            const left =
                moved.refused === 0
                    ? ""
                    : ` ${tasks(moved.refused)} changed after the board read ${one ? "it" : "them"}, so ${one ? "it was" : "they were"} left in ${statusLabel(from)}.`;
            const did = to === "archived" ? `Archived ${tasks(moved.moved)} from ${statusLabel(from)}.` : `Moved ${tasks(moved.moved)} from ${statusLabel(from)} to ${statusLabel(to)}.`;
            cascade = { text: did + left, entry: moved.writes.length > 0 ? entry : null };
            announcement = cascade.text;
        } catch {
            cascade = null;
            notice = `Couldn't read the ${statusLabel(from)} lane's tasks from the index, so nothing was moved. Try again.`;
            announcement = notice;
        } finally {
            movingLane = false;
            retry();
        }
    }

    /** Take a Move all to lane back: every line it wrote that still reads what it wrote. */
    async function undoLaneMove(entry: LaneMoveEntry): Promise<void> {
        const store = workspaceService("store");
        if (!store || !undoStack.includes(entry)) return;
        undoStack = undoStack.filter((e) => e !== entry);
        // The line offers this move's undo, which is now under way: take it down, so it cannot run twice.
        if (cascade?.entry === entry) cascade = null;
        const { writes, skipped } = await revertMoves(store, entry.writes);
        redoStack = [...redoStack, { ...entry, writes }];
        cascade = {
            entry: null,
            text:
                skipped === 0
                    ? `Undone: the ${tasks(entry.moved)} ${entry.moved === 1 ? "is" : "are"} back in ${statusLabel(entry.from)}.`
                    : `Undone, except ${tasks(skipped)} that changed since. ${skipped === 1 ? "It was" : "They were"} left as ${skipped === 1 ? "it is" : "they are"}.`,
        };
        announcement = cascade.text;
        retry();
    }

    /** Make a Move all to lane again after its undo, on the same condition. */
    async function redoLaneMove(entry: LaneMoveEntry): Promise<void> {
        const store = workspaceService("store");
        if (!store) return;
        const { writes } = await revertMoves(store, entry.writes);
        undoStack = [...undoStack, { ...entry, writes }];
        announcement = `Moved the ${statusLabel(entry.from)} lane's tasks to ${statusLabel(entry.to)} again`;
        retry();
    }

    /** What a lane's context menu acts on: the lane, on this board, with the tasks Move all would move counted: what its Lane Filter lets through. */
    function laneTarget(lane: BoardLane): KanbanLaneTarget {
        return { kind: "kanban.lane", board: uid, status: lane.status, label: lane.label, count: lane.total };
    }

    /** The Menu key and Shift+F10 on a lane's header open its menu, as a right-click does. */
    function onLaneHeaderKeydown(event: KeyboardEvent, lane: BoardLane): void {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        event.preventDefault();
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        openContextMenu(laneTarget(lane), rect.left + 12, rect.bottom - 4);
    }

    // ── The Task Editor (ADR 0170) ──────────────────────────────────────────

    /**
     * Move an element to the page's body for as long as it is mounted. Moving an element drops the
     * focus from inside it, and the dialog has put the focus in its title by now, so it is put back.
     */
    function onBody(node: HTMLElement): () => void {
        const focused = document.activeElement;
        document.body.appendChild(node);
        if (focused instanceof HTMLElement && node.contains(focused)) focused.focus();
        return () => node.remove();
    }

    /** Open the card's task in the Task Editor: what clicking a card, or Enter on it, does. */
    function editCard(card: BoardCard): void {
        taskEditor = { kind: "edit", document: card.document, line: card.line, text: card.text };
    }

    /** Open the Task Editor on a new task in `status`, written into today's journal entry. */
    function newTask(status: TaskStatus): void {
        taskEditor = { kind: "new", status };
    }

    /** The Task Editor closed: the board reads again, for whatever it wrote. */
    function taskEditorClosed(): void {
        taskEditor = null;
        retry();
    }

    /** A task archived from the Task Editor, kept as a board move so Undo and Mod+Z take it back. */
    function taskArchived(archived: ArchivedTask): void {
        const from: BoardCell = { status: archived.status, priority: archived.priority };
        const entry: HistoryEntry = { document: archived.document, label: archived.label, from, to: { status: "archived", priority: archived.priority }, write: writtenPart(archived.outcome) };
        undoStack = [...undoStack, entry];
        redoStack = [];
        deleted = null;
        cascade = { text: `Archived "${archived.label}". The Tasks view still lists it.`, entry };
        announcement = cascade.text;
    }

    /** A task deleted from the Task Editor, with everything nested under it: said, with Undo. */
    function taskDeleted(removed: RemovedTask, label: string): void {
        cascade = null;
        deleted = { text: `Deleted "${label}" and everything nested under it.`, removed };
        announcement = deleted.text;
    }

    /** Put back the task the Task Editor deleted, unless the text around it changed since. */
    async function undoDelete(): Promise<void> {
        const removed = deleted?.removed;
        const store = workspaceService("store");
        if (!removed || !store) return;
        deleted = { text: "Putting the task back…", removed: null };
        const outcome = await restoreTask(store, removed);
        deleted = outcome.ok ? { text: "Undone: the task is back where it was.", removed: null } : null;
        if (!outcome.ok) {
            notice =
                outcome.reason === "missing"
                    ? `"${removed.concept}" was renamed or deleted, so the task was not put back.`
                    : `The lines around the deleted task changed since, so it was not put back. Its text is still in the document's history.`;
        }
        announcement = deleted?.text ?? notice ?? "";
        retry();
    }

    async function focusCard(key: string, options?: { preventScroll: boolean }): Promise<void> {
        await tick();
        lanesEl?.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-key="${CSS.escape(key)}"]`)?.focus(options);
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
            void moveCard(card, from, over, "pointer");
            followMovedCard(card.key, over, "pointer");
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
        // The Task Detail and a Lane Filter's input have undo histories of their own.
        if (!boardEl || !focused || !boardEl.contains(focused) || focused.closest("[data-kanban-detail], [data-testid='kanban-lane-filter']")) return;
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
                if (found) editCard(found.card);
            },
            openBelow: (key) => {
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
                if (found) copyReference(found.card);
            },
            move: (key, to, source) => {
                const found = findCard(key);
                if (!found) return;
                void moveCard(found.card, found.cell, to, source);
                // The card is drawn anew in its new section, so the keyboard follows it there, and
                // the view with it only from a menu the keyboard opened. An archived card has left
                // the board, and the keyboard stays where it was.
                if (activeKey === key && to.status !== "archived") followMovedCard(key, to, source);
            },
            moveAll: (from, to) => void moveLane(from, to),
            copyLaneReference,
        }, {
            concept: boardConceptOf(view),
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
            filterSettled.cancel();
            endDrag();
            // A lane collapsed just before the tab closed is still remembered.
            boardState.flush();
        };
    });
</script>

<!-- A line saying what the board did. It floats over the foot of the lanes, above the Task Detail
     when that is open, rather than taking a row above them, so appearing never pushes the cards
     down under the pointer, and it stands clear of the edge below it. It is drawn in the theme's own
     surface and text, so it reads as part of the board in either theme rather than as an alert. -->
{#snippet statusLine(testid: string, text: string, undo: (() => unknown) | null, dismiss: () => void)}
    <div
        role="status"
        class="absolute inset-x-3 z-10 mx-auto flex w-fit items-center gap-3 rounded-lg border border-(--gk-border-soft) bg-(--gk-surface-2) px-3 py-2 text-sm text-(--gk-text-default) shadow-lg"
        style:bottom={detail === null ? "1.5rem" : `calc(${detailHeight * 100}% + 0.5rem + 1.5rem)`}
        data-testid={testid}
    >
        <span class="min-w-0 flex-1">{text}</span>
        {#if undo}
            <button
                type="button"
                onclick={() => void undo()}
                class="shrink-0 rounded-md border border-(--gk-control-border) px-2 py-1 font-medium hover:bg-(--gk-surface-0)"
                data-testid="{testid}-undo"
            >
                Undo
            </button>
        {/if}
        <button
            type="button"
            onclick={dismiss}
            class="shrink-0 rounded-md border border-(--gk-control-border) px-2 py-1 font-medium hover:bg-(--gk-surface-0)"
            data-testid="{testid}-dismiss"
        >
            Dismiss
        </button>
    </div>
{/snippet}

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
        data-concept={concept ?? undefined}
        data-whole={concept === null || undefined}
        aria-busy={loading}
    >
        <p id="{uid}-card-hint" class="sr-only">
            Arrow keys move between cards. Enter opens the task in the task editor. Alt with an arrow key moves the card to another
            lane or priority. Shift+F10 opens the card's menu.
        </p>
        <p class="sr-only" role="status" data-testid="kanban-announcement">{announcement}</p>
        {#if failed}
            <div
                role="alert"
                class="mx-3 mt-3 flex items-center gap-3 rounded-lg bg-(--gk-danger-surface) px-3 py-2 text-sm text-(--gk-text-danger)"
                data-testid="kanban-error"
            >
                <span class="min-w-0 flex-1">Couldn't read the task index, so the board may be out of date.</span>
                <!-- The banners' buttons take the banner's own colour, which no control class has. -->
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
        <!-- What the last move did, with Undo, or a task the Task Editor deleted, where a move's
             line, when there is one, is the one shown. -->
        {#if cascade}
            {@render statusLine("kanban-cascade", cascade.text, cascade.entry ? undoCascade : null, () => (cascade = null))}
        {:else if deleted}
            {@render statusLine("kanban-deleted", deleted.text, deleted.removed ? undoDelete : null, () => (deleted = null))}
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
        {#if agentHintShown}
            <p class="mx-3 mt-3 mb-0 flex items-center gap-2 text-sm text-(--gk-text-muted)" data-testid="kanban-agent-hint">
                <span class="min-w-0 flex-1">
                    An AI agent on your computer can work on these tasks through the EtherPK MCP server. Copy a card's reference to hand it
                    one.
                    <a
                        class="gk-link"
                        href="https://docs.etherpk.com/using-ai-agents-with-your-notes"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid="kanban-agent-hint-link">Set up an agent</a
                    >
                </span>
                <button
                    type="button"
                    onclick={() => {
                        agentHint.dismiss();
                        agentHintShown = false;
                    }}
                    class="gk-icon-button shrink-0"
                    aria-label="Dismiss the tip about agents"
                    title="Dismiss"
                    data-testid="kanban-agent-hint-dismiss"
                >
                    <!-- In-repo constant markup from the icon table, never user content. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                    {@html iconSvg("close")}
                </button>
            </p>
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
                        {@attach (node) => attachContextMenu(node, () => laneTarget(lane))}
                    >
                        <button
                            type="button"
                            onclick={() => toggleCollapsed(lane.status)}
                            onkeydown={(event) => onLaneHeaderKeydown(event, lane)}
                            class="flex min-h-0 flex-1 flex-col items-center gap-2 rounded-xl px-1 py-2.5 text-(--gk-text-muted) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)"
                            aria-label="Expand the {lane.label} lane, {lane.total} {lane.total === 1 ? 'task' : 'tasks'}"
                            data-testid="kanban-lane-expand"
                        >
                            <!-- In-repo constant markup from the icon table, never user content. -->
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
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
                        <!-- py-1 around EtherPK's 32px icon button keeps the header the height it was. -->
                        <!-- A right-click on the header, or Shift+F10 on its button, offers Copy lane reference and Move all to lane. -->
                        <header
                            class="flex items-center justify-between gap-2 border-b border-(--gk-border-soft) py-1 pl-3 pr-1.5"
                            data-testid="kanban-lane-header"
                            {@attach (node) => attachContextMenu(node, () => laneTarget(lane))}
                        >
                            <!-- The count follows the name, where its subtler text tells the two apart. -->
                            <span class="flex min-w-0 items-baseline gap-2">
                                <h2 id="{uid}-{lane.status}" class="m-0 text-sm font-semibold text-(--gk-text-strong)" data-testid="kanban-lane-label">
                                    {lane.label}
                                </h2>
                                {#if shown !== null}
                                    <span class="text-sm whitespace-nowrap text-(--gk-text-subtle)" data-testid="kanban-lane-count">{lane.filter === null ? lane.total : `${lane.total} of ${lane.unfiltered}`}</span>
                                {/if}
                            </span>
                            <span class="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    onclick={() => toggleLaneFilter(lane.status)}
                                    class="gk-icon-button"
                                    aria-label="Filter the {lane.label} lane by title or tag"
                                    aria-expanded={laneFilters.has(lane.status)}
                                    title="Filter the {lane.label} lane by title or tag"
                                    data-testid="kanban-lane-filter-toggle"
                                >
                                    <!-- In-repo constant markup from the icon table, never user content. -->
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                    {@html iconSvg("search")}
                                </button>
                                <!-- A new task in this lane, through the Task Editor (ADR 0170). -->
                                <button
                                    type="button"
                                    onclick={() => newTask(lane.status)}
                                    class="gk-icon-button"
                                    aria-label="Add a task to {lane.label}"
                                    title="Add a task to {lane.label}, in today's journal"
                                    data-testid="kanban-lane-add"
                                >
                                    <!-- In-repo constant markup from the icon table, never user content. -->
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                    {@html iconSvg("kanban.add-task")}
                                </button>
                                <button
                                    type="button"
                                    onclick={() => toggleCollapsed(lane.status)}
                                    onkeydown={(event) => onLaneHeaderKeydown(event, lane)}
                                    class="gk-icon-button"
                                    aria-label="Collapse the {lane.label} lane"
                                    title="Collapse the {lane.label} lane"
                                    data-testid="kanban-lane-collapse"
                                >
                                    <!-- In-repo constant markup from the icon table, never user content. -->
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                    {@html iconSvg("kanban.collapse-lane")}
                                </button>
                            </span>
                        </header>
                        {#if laneFilters.has(lane.status)}
                            <!-- Outside the lane's scroll, so it stays on screen beside the cards it narrows. -->
                            <div class="flex items-center gap-1 border-b border-(--gk-border-soft) py-1 pl-2 pr-1.5" data-testid="kanban-lane-filter">
                                <input
                                    type="text"
                                    class="gk-input min-w-0 flex-1"
                                    value={laneFilters.get(lane.status)}
                                    placeholder="Task title / #tag"
                                    aria-label="Filter the {lane.label} lane by title or tag"
                                    data-testid="kanban-lane-filter-input"
                                    oninput={(event) => onLaneFilterInput(lane.status, event.currentTarget.value)}
                                    onkeydown={(event) => {
                                        if (event.key !== "Escape") return;
                                        event.preventDefault();
                                        closeLaneFilter(lane.status);
                                    }}
                                    {@attach (node) => node.focus()}
                                />
                                <button
                                    type="button"
                                    onclick={() => closeLaneFilter(lane.status)}
                                    class="gk-icon-button"
                                    aria-label="Close the filter on the {lane.label} lane and show all its tasks"
                                    title="Close the filter and show all the tasks"
                                    data-testid="kanban-lane-filter-close"
                                >
                                    <!-- In-repo constant markup from the icon table, never user content. -->
                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                    {@html iconSvg("close")}
                                </button>
                            </div>
                        {/if}
                        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2" data-kanban-lane-body>
                            {#if lane.filter !== null && lane.total === 0}
                                <p class="m-0 px-1 pt-2 text-sm wrap-anywhere text-(--gk-text-subtle)" data-testid="kanban-lane-filter-empty">
                                    No tasks in {lane.label} match "{laneFilters.get(lane.status)?.trim()}". {lane.unfiltered === 1 ? "1 task is" : `${lane.unfiltered} tasks are`} hidden.
                                </p>
                            {/if}
                            {#if empty && lane.status === emptyNoticeLane}
                                <p class="m-0 px-1 pt-2 text-sm text-(--gk-text-subtle)" data-testid="kanban-empty">
                                    {#if concept === null}
                                        No tasks in this graph yet.
                                    {:else}
                                        No tasks belong to {concept} yet. Tasks on its page, or nested under a link to it, appear here.
                                    {/if}
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
                                                <li class="relative">
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
                                                            editCard(card);
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
                                                            <!-- A subtask with a card has a parent that is not on this board (ADR 0174); this keeps it tied to that task. -->
                                                            <span class="mt-1 block truncate text-sm text-(--gk-text-muted)" data-testid="kanban-card-parent">
                                                                in: <KanbanCardText text={card.parent} />
                                                            </span>
                                                        {:else if card.inConcept !== null}
                                                            <!-- Says which concept the task sits in, on a board for a concept further out. Styled as KanbanCardText draws a wikilink, without its brackets. -->
                                                            <span class="mt-1 block truncate text-sm text-(--gk-text-muted)" data-testid="kanban-card-concept">
                                                                in: <span class="text-(--gk-accent) underline">{card.inConcept}</span>
                                                            </span>
                                                        {/if}
                                                        <!-- Room on the right for the copy button, which sits over the card. -->
                                                        <span class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pr-7 text-sm">
                                                            <span class="min-w-0 truncate text-(--gk-text-subtle)" data-testid="kanban-card-document">{card.document}</span>
                                                            {#if card.subtasks.total > 0}
                                                                <!-- The board reaches a subtask through its parent's card (ADR 0174), so the card says how many it holds. -->
                                                                <span class="inline-flex items-center gap-0.5 text-(--gk-text-muted)" data-testid="kanban-card-subtasks">
                                                                    <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                                                    <span class="inline-flex size-3.5" aria-hidden="true">{@html iconSvg("check")}</span>
                                                                    <span aria-hidden="true">{card.subtasks.done}/{card.subtasks.total}</span>
                                                                    <span class="sr-only">{card.subtasks.done} of {card.subtasks.total} subtasks finished</span>
                                                                </span>
                                                            {/if}
                                                            {#if card.due !== null}
                                                                <span
                                                                    class={["rounded px-1.5 font-medium", DUE_CLASSES[card.dueState ?? "upcoming"]]}
                                                                    data-testid="kanban-card-due"
                                                                    data-due-state={card.dueState}
                                                                >
                                                                    {dueLabel(card)}
                                                                </span>
                                                            {/if}
                                                            <!-- The card's Free Tags, after its date, as the Tasks View draws them (ADR 0166). -->
                                                            {#each card.freeTags as freeTag (freeTag)}
                                                                <span class="rounded bg-(--gk-surface-2) px-1.5 font-medium text-(--gk-text-default)" data-testid="kanban-card-free-tag">{freeTag}</span>
                                                            {/each}
                                                        </span>
                                                    </button>
                                                    <!-- A sibling of the card, not inside it: a button cannot hold another. Out
                                                         of the Tab order, which moves card to card with the arrow keys; from the
                                                         keyboard, the card's menu (Shift+F10) has Copy task reference. -->
                                                    {#if !carried}
                                                        <button
                                                            type="button"
                                                            tabindex={-1}
                                                            onclick={() => copyReference(card)}
                                                            class="absolute right-1.5 bottom-1.5 inline-flex size-7 items-center justify-center rounded-md text-(--gk-text-subtle) hover:bg-(--gk-control-hover) hover:text-(--gk-text-default) focus-visible:outline-2 focus-visible:outline-(--gk-accent)"
                                                            aria-label="Copy task reference"
                                                            title="Copy task reference, to hand this task to an agent"
                                                            data-testid="kanban-card-copy-reference"
                                                        >
                                                            <!-- In-repo constant markup from the icon table, never user content. -->
                                                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                                                            {@html iconSvg("task-reference")}
                                                        </button>
                                                    {/if}
                                                </li>
                                            {/each}
                                        </ul>
                                        {#if section.hasMore}
                                            <button
                                                type="button"
                                                onclick={() => showMore(cell, section.cards.length)}
                                                class="gk-button gk-button--quiet mt-1 flex w-full items-baseline justify-between gap-2"
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
                <!-- py-0.5 around EtherPK's 32px icon button keeps the header the height it was. -->
                <header class="flex items-center gap-2 border-b border-(--gk-border-soft) bg-(--gk-surface-1) py-0.5 pl-3 pr-1.5">
                    <h2 id="{uid}-detail-title" class="m-0 flex min-w-0 flex-1 items-baseline gap-2 text-sm">
                        <span class="shrink-0 text-(--gk-text-muted)">Task Detail</span>
                        <span class="truncate font-semibold text-(--gk-text-strong)" data-testid="kanban-detail-document">{detail.document}</span>
                    </h2>
                    <button
                        type="button"
                        onclick={openDetailInTab}
                        class="gk-button gk-button--quiet shrink-0"
                        data-testid="kanban-detail-open"
                    >
                        Open in tab
                    </button>
                    <button
                        type="button"
                        onclick={closeDetail}
                        class="gk-icon-button"
                        aria-label="Close the Task Detail"
                        title="Close the Task Detail"
                        data-testid="kanban-detail-close"
                    >
                        <!-- In-repo constant markup from the icon table, never user content. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -- iconSvg returns trusted markup from the Client's icon table or the sanitized manifest icons (ADR 0130) -->
                        {@html iconSvg("close")}
                    </button>
                </header>
                <div class="min-h-0 flex-1 overflow-clip">
                    {#key detail.document}
                        <DocumentView
                            bind:this={detailView}
                            view={{ kind: "document", target: detail.document }}
                            {panelId}
                            {visibility}
                            embedded
                            revealAt={detail.line}
                        />
                    {/key}
                </div>
            </section>
        {/if}
        {#if taskEditor}
            <!-- On the page's body, not in the board: the board sits in a transformed pane, and a
                 fixed dialog inside one is placed, and clipped, by the pane. -->
            <div {@attach onBody}>
                <TaskEditor
                    {concept}
                    start={taskEditor}
                    {panelId}
                    {visibility}
                    onclose={taskEditorClosed}
                    onarchived={taskArchived}
                    ondeleted={taskDeleted}
                />
            </div>
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
