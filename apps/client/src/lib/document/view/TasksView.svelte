<script lang="ts">
    /**
     * The [[Tasks View]]: every [[Task]] in the graph, narrowed by a [[Name Filter]] and by
     * the states and dates its [[Task Tag]]s carry.
     *
     * Deliberately NOT a Backlinks View for tasks. Backlinks follows the active document;
     * this pins its filter, because the moment you click a result the main region navigates —
     * and a list that retargets itself out from under you is useless for working down. The
     * "Use <name>" link is the pinned alternative: one press to hop to wherever you now are.
     *
     * Mounted through the dockview adapter, so it reads its services via module accessors
     * rather than Svelte context (a separate Svelte root has none to inherit).
     */
    import { onDestroy, onMount } from "svelte";

    import {
        getActiveGraphIndex,
        type TaskGroupBy,
        type TaskHit,
        type TaskPriorityFilter,
        type TaskQuery,
        type TaskStatus,
        taskDateKey,
    } from "../backlinks";
    import type { ViewRef } from "$lib/layout";
    import { tryGetActiveEventBus } from "$lib/surface";
    import { workspaceService } from "$lib/workspace/workspace-services";

    import { getActiveDocument } from "../active-document";
    import { conceptIsMissing, openConcept, openConceptAtLine } from "../open-concept";
    import { quickFindKey } from "../quick-find";
    import { createSettleScheduler } from "../settle-scheduler";
    import { defaultTaskFilter, type TaskFilterState } from "../task-filter-store";
    import { parseTaskTags } from "../task-tags";
    import { toggleIndexedTask } from "../task-toggle";
    import { matchScore } from "./augmentations/wikilink-complete-core";
    import { wikilinkSegmentsInSource } from "../wikilink";

    const { view: _view }: { view: ViewRef } = $props();

    /** Rows fetched per "Show more". The list grows by raising the limit, never by
        stitching pages together — one request always returns one consistently ordered list. */
    const PAGE_SIZE = 100;
    /** Enough to choose from without turning the sidebar into a list of the whole graph. */
    const MAX_SUGGESTIONS = 8;

    const store = workspaceService("taskFilter");
    /** The persisted filter this View opened with — also what seeds the Name Filter box. */
    const restored = store?.get() ?? defaultTaskFilter();

    let filter = $state<TaskFilterState>(restored);
    let pages = $state(1);
    let hits = $state.raw<TaskHit[]>([]);
    let total = $state(0);
    /** How many rows the LAST QUERY returned — excludes held ticked rows. */
    let loaded = $state(0);
    let hasMore = $state(false);
    let loading = $state(true);
    let activeConcept = $state<string | null>(null);
    let staleNotice = $state<string | null>(null);
    /** The last query failed outright — distinct from having matched nothing. */
    let failed = $state(false);

    /**
     * Tasks ticked in this session, each with the row it was and where it sat.
     *
     * A ticked task usually stops matching the filter, and a list that reflows under your
     * finger after every tick makes the NEXT row the one you mis-click. So a ticked row holds
     * its place, struck through, until the query is asked a genuinely different question.
     *
     * The whole row is kept, not merely its key: ticking writes to the document, which the
     * index picks up, which re-queries — and the re-query no longer returns the row. Keeping
     * the key alone would strike a row through for the half-second before the ingest landed
     * and then drop it anyway, which is the reflow this exists to prevent.
     *
     * The hold records the state the tick ASKED FOR, and a row is shown in that state only
     * while the index has yet to agree. It used to show the *inverse of whatever row was
     * rendered* — right for the stale snapshot, wrong the moment the index caught up and
     * still returned the row (the Done chip on, say): that fresh row already said done, so
     * inverting it showed the task open again while the document said `[x]`. Reported from
     * live testing as the sidebar "not synchronising" with the document.
     */
    interface HeldRow {
        hit: TaskHit;
        /** Where it sat in the list when it was ticked, so it goes back in the same place. */
        index: number;
        /** The state the tick asked for — what to show until the index says the same. */
        done: boolean;
    }
    let held = $state.raw<ReadonlyMap<string, HeldRow>>(new Map());

    /**
     * A row's identity is WHERE THE TASK LIVES — the document and the line — which is also
     * what ticking it addresses. Not the index's page id: a Filesystem Backend save reaches
     * the index as an unnamed change, which re-derives the whole graph into a fresh generation
     * with fresh page ids, so a key built on one stopped matching after the very tick that
     * created the hold and the held snapshot was re-inserted beside the fresh row.
     */
    const hitKey = (hit: TaskHit) => `${hit.concept}:${hit.line}`;

    // ── The Name Filter ────────────────────────────────────────────────────
    // Seeded from the RESTORED filter, not empty. The filter survives a reload deliberately,
    // and an empty box beside a filtered list is a list that looks unfiltered — the same way
    // showing the name as a placeholder did.
    let nameQuery = $state(restored.concept ?? "");
    let nameFocused = $state(false);
    /** Highlighted suggestion row. Focus stays in the input; the arrows move this. */
    let nameSelected = $state(0);

    /**
     * Quick Find's MATCHING, not Quick Find: names and aliases, case-insensitive, a
     * [[Scoped Concept]]'s brackets read as spaces. It never navigates and never opens a
     * [[Draft]] — naming something here is a question about tasks, not a request to go there.
     * [[Pageless Concept]]s are offered too: a wikilink is enough to give a concept tasks.
     */
    const suggestions = $derived.by(() => {
        const q = quickFindKey(nameQuery);
        if (q === "") return [];
        const all = getActiveGraphIndex()?.allConcepts() ?? [];
        return all
            .map((candidate) => ({ candidate, score: matchScore(quickFindKey(candidate.display), q) }))
            .filter((m): m is { candidate: (typeof all)[number]; score: number } => m.score !== null)
            .sort((a, b) => b.score - a.score || a.candidate.display.localeCompare(b.candidate.display))
            .slice(0, MAX_SUGGESTIONS);
    });

    function update(next: Partial<TaskFilterState>): void {
        filter = { ...filter, ...next };
        store?.set(filter);
        // A different question starts from the first page.
        pages = 1;
        refresh();
    }

    /**
     * Ask the index again, now, with the filter as it stands. A filter change comes through
     * here, and so does the Refresh button, which exists because toggling a chip off and on
     * was the only other way to get a fresh list.
     *
     * Both let go of the ticked rows being held in place: whoever asks for the list again
     * wants the answer the query gives, not rows it has stopped returning. The pages already
     * shown are kept, so a refresh after "Show more" does not collapse the list.
     */
    function refresh(): void {
        held = new Map();
        staleNotice = null;
        // The user just acted: answer now, and drop any settling index refresh behind it.
        indexRefresh.cancel();
        void recompute();
    }

    let refreshIcon = $state<SVGSVGElement>();

    /**
     * The Refresh button. A half turn of its icon acknowledges the press: the answer usually
     * lands within milliseconds and often matches what was already on screen, and a press
     * that visibly changes nothing reads as one that did nothing. Half a turn because the
     * glyph's two arrows land back on themselves; no turn at all under reduced motion.
     */
    function onRefreshPress(): void {
        refresh();
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        refreshIcon?.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(180deg)" }], {
            duration: 200,
            easing: "ease-out",
        });
    }

    /**
     * Apply a name (or clear it), leaving the box showing what is applied.
     *
     * The chosen name becomes the input's VALUE, not its placeholder. Showing it as a
     * placeholder rendered the active filter in grey — indistinguishable from an empty box,
     * so a filter that had applied perfectly well read as one that had not.
     */
    function selectName(concept: string | null): void {
        nameQuery = concept ?? "";
        nameFocused = false;
        nameSelected = 0;
        update({ concept });
    }

    /**
     * Emptying the box clears the filter, so backspace is the way out and the box never
     * claims to be filtering by nothing. Editing it into some *other* text leaves the applied
     * filter alone until a name is actually chosen — a half-typed name is not a selection.
     */
    function onNameInput(): void {
        nameFocused = true;
        if (nameQuery === "" && filter.concept !== null) update({ concept: null });
    }

    const suggestionsOpen = $derived(nameFocused && suggestions.length > 0);

    /**
     * Arrow keys drive the list while focus stays in the input — so nothing scrolls on its
     * own, and an effect below has to bring the highlighted row into view itself.
     *
     * CLAMPED at both ends rather than wrapped, matching [[Search]]: holding ArrowDown to
     * reach the last row and being thrown back to the top is disorienting, and the keys are
     * how you get *out* of the input, not a carousel.
     */
    function onNameKeydown(event: KeyboardEvent): void {
        if (event.key === "Escape") {
            // Close the list but keep what was typed — the same key does not also clear.
            if (!suggestionsOpen) return;
            event.preventDefault();
            nameFocused = false;
            return;
        }
        if (!suggestionsOpen) return;
        if (event.key === "ArrowDown") {
            event.preventDefault();
            nameSelected = Math.min(nameSelected + 1, suggestions.length - 1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            nameSelected = Math.max(nameSelected - 1, 0);
        } else if (event.key === "Enter") {
            event.preventDefault();
            const chosen = suggestions[nameSelected]?.candidate;
            if (chosen) selectName(chosen.display);
        }
    }

    let suggestionsEl = $state<HTMLElement>();

    // Typing re-ranks the list, so a highlight left further down would point at something
    // the user never chose. Back to the best match on every keystroke.
    $effect(() => {
        void nameQuery;
        nameSelected = 0;
    });

    // Keep the highlighted row in view. Focus never leaves the input, so the list does not
    // scroll on its own and the selection would otherwise walk off the bottom unseen.
    $effect(() => {
        void nameSelected;
        suggestionsEl
            ?.querySelector('[data-testid="tasks-name-suggestion"][data-selected="true"]')
            ?.scrollIntoView({ block: "nearest" });
    });

    // ── The query ──────────────────────────────────────────────────────────
    /**
     * The day the rows on screen were asked about: what "Overdue", "Today" and the due-date
     * windows are measured from. Read from the clock as each query is sent and kept only once
     * its answer lands, so the grouping always agrees with the rows. It used to be derived
     * from the filter, which froze it at the last filter change: a tab left open overnight
     * went on filing today's tasks under their date until a chip was toggled.
     */
    let today = $state(taskDateKey(new Date()));

    /**
     * The index lives in a worker (ADR 0041), so this is a round trip. `wanted` guards against
     * a slow answer for an old filter overwriting a newer one — the user changes chips faster
     * than the worker replies.
     */
    let wanted = 0;
    async function recompute(): Promise<void> {
        const index = getActiveGraphIndex();
        const ticket = ++wanted;
        if (!index) {
            hits = [];
            total = 0;
            loading = false;
            return;
        }
        loading = true;
        // $state.snapshot is not decoration: `filter` is deeply proxied by $state, and a
        // Proxy cannot be structured-cloned. Handing it straight to postMessage throws
        // DataCloneError — which, being caught below, would look exactly like a graph with
        // no tasks in it.
        const query: TaskQuery = { ...$state.snapshot(filter), today: taskDateKey(new Date()) };
        try {
            const page = await index.tasks(query, 0, PAGE_SIZE * pages);
            if (ticket !== wanted) return;
            today = query.today;
            releaseAgreedHolds(page.hits);
            hits = withHeldRows(page.hits);
            // Counted from the QUERY, not from `hits`: a held row is one the query no longer
            // returns, so counting the rendered list would report "2 of 1".
            loaded = page.hits.length;
            total = page.total;
            hasMore = page.hasMore;
            failed = false;
        } catch {
            // Say so rather than rendering an empty list: "no tasks match" and "the query
            // never ran" look identical to a user, and only one of them is worth acting on.
            if (ticket !== wanted) return;
            hits = [];
            total = 0;
            hasMore = false;
            failed = true;
        } finally {
            if (ticket === wanted) loading = false;
        }
    }

    /**
     * A hold ends when the index agrees with it AND still returns the row — the row is then
     * exactly what the query says, in the place the query puts it, so there is nothing left
     * to hold and nothing that would reflow. Held until then: a query answered before the
     * ingest landed still returns the row in its OLD state, and releasing on that would flip
     * the checkbox back for the half-second before the row vanished.
     */
    function releaseAgreedHolds(fresh: TaskHit[]): void {
        if (held.size === 0) return;
        let next: Map<string, HeldRow> | undefined;
        for (const hit of fresh) {
            const row = held.get(hitKey(hit));
            if (row && row.done === hit.done) (next ??= new Map(held)).delete(hitKey(hit));
        }
        if (next) held = next;
    }

    /**
     * Put back any ticked row the query has since stopped returning, at the position it held.
     * Rows the query still returns are left to the query — it is the newer truth.
     */
    function withHeldRows(fresh: TaskHit[]): TaskHit[] {
        if (held.size === 0) return fresh;
        const present = new Set(fresh.map(hitKey));
        const merged = [...fresh];
        // Ascending, so each splice lands before the later ones shift anything.
        for (const [key, row] of [...held].sort((a, b) => a[1].index - b[1].index)) {
            if (present.has(key)) continue;
            merged.splice(Math.min(row.index, merged.length), 0, row.hit);
        }
        return merged;
    }

    /**
     * The index updates on every ingest — every ~150ms while someone types — and re-querying
     * that often makes the list visibly churn while its answer is stale before it renders.
     * So an index update is a *signal*, not a command: the re-query waits for typing to settle
     * and, if it never does, runs at the cap anyway so the list cannot freeze mid-session.
     *
     * A filter change is different and never comes through here: the user just acted, so
     * `update()` re-queries at once.
     */
    const REFRESH_SETTLE_MS = 600;
    const REFRESH_MAX_WAIT_MS = 2000;
    const indexRefresh = createSettleScheduler(() => void recompute(), {
        settleMs: REFRESH_SETTLE_MS,
        maxWaitMs: REFRESH_MAX_WAIT_MS,
    });

    function showMore(): void {
        pages += 1;
        indexRefresh.cancel();
        void recompute();
    }

    // ── Grouping ───────────────────────────────────────────────────────────
    const PRIORITY_LABELS: Record<number, string> = { 1: "P1", 2: "P2", 3: "P3" };

    function groupLabel(hit: TaskHit, groupBy: TaskGroupBy, today: string): string {
        if (groupBy === "document") return hit.concept;
        if (groupBy === "priority") return hit.priority === null ? "No priority" : PRIORITY_LABELS[hit.priority];
        if (hit.due === null) return "No due date";
        if (hit.due < today) return "Overdue";
        if (hit.due === today) return "Today";
        return hit.due;
    }

    /**
     * Rows arrive already ordered by their group key, so grouping is a walk, never a re-sort.
     * That is also what lets a group straddle a page boundary and simply continue.
     */
    const groups = $derived.by(() => {
        const out: Array<{ label: string; hits: TaskHit[] }> = [];
        for (const hit of hits) {
            const label = groupLabel(hit, filter.groupBy, today);
            const last = out[out.length - 1];
            if (last && last.label === label) last.hits.push(hit);
            else out.push({ label, hits: [hit] });
        }
        return out;
    });

    // ── Rows ───────────────────────────────────────────────────────────────
    interface LinkPart {
        text: string;
        concept: string | null;
    }

    /**
     * Split a label into plain runs and wikilink segments, reusing the editor's segmenter.
     * A link keeps its source text, brackets and all: the row is showing the task as it is
     * written, and `[[Kanban]]` is what marks the word as a link rather than a word.
     */
    function linkParts(text: string): LinkPart[] {
        const out: LinkPart[] = [];
        let pos = 0;
        for (const seg of wikilinkSegmentsInSource(text)) {
            if (seg.start > pos) out.push({ text: text.slice(pos, seg.start), concept: null });
            out.push({ text: text.slice(seg.start, seg.end), concept: seg.wikilink.concept });
            pos = seg.end;
        }
        if (pos < text.length) out.push({ text: text.slice(pos), concept: null });
        return out;
    }

    /**
     * An ancestor's label for the breadcrumb. An ancestor is often itself a [[Task]], whose
     * label carries its own [[Task Tag]] run — and a breadcrumb reading
     * "#C-2026-09-01 Reviewed the redlines" is showing the reader syntax, not context.
     * Stripped the same way a row's own text is.
     */
    function crumbText(label: string): string {
        return parseTaskTags(label).text || label;
    }

    /** Open the document at the task's line: the same landing a reference makes in the Backlinks View. */
    function open(hit: TaskHit): void {
        openConceptAtLine(hit.concept, hit.line);
    }

    /**
     * Tick a task where it lives. The write is refused rather than risked when the indexed
     * line has moved — see task-toggle.ts — and a refusal opens the document at the task so
     * the user sees reality instead of an edit that silently went somewhere else.
     */
    async function toggle(hit: TaskHit): Promise<void> {
        const documents = workspaceService("store");
        if (!documents) return;
        const done = !isDone(hit);
        const result = await toggleIndexedTask(documents, { concept: hit.concept, line: hit.line, text: hit.text }, done);
        if (!result.ok) {
            staleNotice = "That task has moved since it was indexed — opening it instead.";
            open(hit);
            return;
        }
        staleNotice = null;
        const next = new Map(held);
        // Back to the state the row itself records: nothing to hold on to any more.
        if (done === hit.done) next.delete(hitKey(hit));
        else next.set(hitKey(hit), { hit, index: Math.max(0, hits.indexOf(hit)), done });
        held = next;
    }

    /** A row's displayed state: what the index says, unless a tick is still waiting on it. */
    function isDone(hit: TaskHit): boolean {
        return held.get(hitKey(hit))?.done ?? hit.done;
    }

    // ── Chips ──────────────────────────────────────────────────────────────
    const STATUS_CHIPS: Array<{ value: TaskStatus; label: string }> = [
        { value: "open", label: "Open" },
        { value: "doing", label: "Doing" },
        { value: "waiting", label: "Waiting" },
        { value: "done", label: "Done" },
        { value: "cancelled", label: "Cancelled" },
    ];

    const PRIORITY_CHIPS: Array<{ value: TaskPriorityFilter; label: string }> = [
        { value: 1, label: "P1" },
        { value: 2, label: "P2" },
        { value: 3, label: "P3" },
        { value: null, label: "None" },
    ];

    function toggleStatus(value: TaskStatus): void {
        const on = filter.statuses.includes(value);
        update({ statuses: on ? filter.statuses.filter((s) => s !== value) : [...filter.statuses, value] });
    }

    function togglePriority(value: TaskPriorityFilter): void {
        const on = filter.priorities.includes(value);
        update({ priorities: on ? filter.priorities.filter((p) => p !== value) : [...filter.priorities, value] });
    }

    /**
     * Whether the filter is the one a fresh graph starts with. Chip sets compare as sets:
     * turning a chip off and on again leaves it at the end of the array, and that ordering
     * is not a different filter. Governs the reset control, which is offered only while
     * there is something to reset — a "Reset" beside an already-default filter would be a
     * button that visibly does nothing.
     */
    const isDefaultFilter = $derived.by(() => {
        const base = defaultTaskFilter();
        const same = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x) => b.includes(x));
        return (
            filter.concept === base.concept &&
            filter.due === base.due &&
            filter.groupBy === base.groupBy &&
            same(filter.statuses, base.statuses) &&
            same(filter.priorities, base.priorities)
        );
    });

    /** Every control back to its starting state, the Name Filter's box included. */
    function resetFilters(): void {
        nameQuery = "";
        nameFocused = false;
        nameSelected = 0;
        update(defaultTaskFilter());
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────
    let unsubActive: (() => void) | undefined;
    let unsubIndex: (() => void) | undefined;
    onMount(() => {
        // The bus has no replay: read what is active NOW, then follow. Following only
        // relabels the link — the filter itself never moves without a press.
        activeConcept = getActiveDocument();
        unsubActive = tryGetActiveEventBus()?.on("document:active-changed", ({ documentId }) => {
            activeConcept = documentId;
        });
        unsubIndex = getActiveGraphIndex()?.onUpdated(() => indexRefresh.schedule());
        void recompute();
    });
    onDestroy(() => {
        unsubActive?.();
        unsubIndex?.();
        indexRefresh.cancel();
        store?.flush();
    });
</script>

{#snippet chip(label: string, on: boolean, onclick: () => void, testid: string)}
    <button
        type="button"
        data-testid={testid}
        aria-pressed={on}
        {onclick}
        class="rounded-full border px-2 py-0.5 text-sm transition-colors {on
            ? 'border-transparent bg-(--gk-accent,#2563eb) text-white'
            : 'border-(--gk-border-soft) text-(--gk-text-subtle) hover:bg-(--gk-surface-2)'}"
    >
        {label}
    </button>
{/snippet}

<div class="flex h-full flex-col overflow-hidden text-(--gk-text-default)" data-testid="tasks-view">
    <div class="flex flex-col gap-2 border-b border-(--gk-border-soft) p-3">
        <div class="flex items-baseline gap-2">
            <h3 class="m-0 text-sm font-normal uppercase tracking-[0.04em] opacity-70">Tasks</h3>
            {#if !isDefaultFilter}
                <button
                    type="button"
                    data-testid="tasks-reset-filters"
                    title="Back to every unfinished task, every priority, any date, grouped by priority"
                    onclick={resetFilters}
                    class="ml-auto shrink-0 text-sm text-(--gk-accent,#2563eb) hover:underline"
                >
                    Reset filters
                </button>
            {/if}
            <span class="shrink-0 text-sm text-(--gk-text-subtle) {isDefaultFilter ? 'ml-auto' : ''}" data-testid="tasks-count">
                {loaded === total ? total : `${loaded} of ${total}`}
            </span>
        </div>

        <!-- The Name Filter. Typing offers concepts; selecting one pins the filter. -->
        <div class="relative">
            <!-- oninput as well as onfocus: selecting a name and pressing Escape both close
                 the list while focus STAYS in the input, so onfocus alone would never fire
                 again and the box would look dead until it was blurred and refocused. -->
            <div class="flex items-center gap-1">
                <input
                    data-testid="tasks-name-filter"
                    placeholder="Any name…"
                    aria-label="Filter tasks by name"
                    autocomplete="off"
                    bind:value={nameQuery}
                    role="combobox"
                    aria-expanded={suggestionsOpen}
                    aria-controls="tasks-name-suggestions"
                    aria-activedescendant={suggestionsOpen ? `tasks-name-suggestion-${nameSelected}` : undefined}
                    onfocus={() => (nameFocused = true)}
                    onblur={() => setTimeout(() => (nameFocused = false), 150)}
                    onkeydown={onNameKeydown}
                    oninput={onNameInput}
                    class="min-w-0 flex-1 rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-2 py-1.5 text-sm text-(--gk-text-strong) placeholder:text-(--gk-text-subtle) focus:border-(--gk-border-strong) focus:outline-none"
                />
                {#if filter.concept !== null}
                    <!-- self-stretch: the row is items-center, and a button sized by its own
                         (smaller) text sat shorter than the input beside it. Stretching pins it
                         to the input's height whatever either font does. -->
                    <button
                        type="button"
                        title="Clear the name filter"
                        aria-label="Clear the name filter"
                        data-testid="tasks-name-clear"
                        onclick={() => selectName(null)}
                        class="inline-flex shrink-0 items-center justify-center self-stretch rounded-md border border-(--gk-border-soft) px-2 text-(--gk-text-subtle) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong)"
                    >
                        <!-- heroicons/outline x-mark -->
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
                        </svg>
                    </button>
                {/if}
            </div>

            {#if suggestionsOpen}
                <ul
                    id="tasks-name-suggestions"
                    role="listbox"
                    bind:this={suggestionsEl}
                    data-testid="tasks-name-suggestions"
                    class="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) shadow-lg"
                >
                    {#each suggestions as { candidate }, i (candidate.key)}
                        <li>
                            <button
                                type="button"
                                id="tasks-name-suggestion-{i}"
                                role="option"
                                aria-selected={i === nameSelected}
                                data-testid="tasks-name-suggestion"
                                data-selected={i === nameSelected ? "true" : undefined}
                                onclick={() => selectName(candidate.display)}
                                onmousemove={() => (nameSelected = i)}
                                class="flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-sm {i === nameSelected
                                    ? 'bg-(--gk-surface-2)'
                                    : ''}"
                            >
                                <span class="min-w-0 flex-1 truncate">{candidate.display}</span>
                                <span class="shrink-0 text-sm uppercase text-(--gk-text-subtle)">
                                    {candidate.kind === "alias" ? `alias of ${candidate.canonical}` : candidate.kind}
                                </span>
                            </button>
                        </li>
                    {/each}
                </ul>
            {/if}
        </div>

        <!-- One press to ask about wherever the user now is. Named, so the press is
             predictable before it is made; hidden when no document is focused. -->
        {#if activeConcept !== null && activeConcept !== filter.concept}
            <button
                type="button"
                data-testid="tasks-use-active"
                onclick={() => selectName(activeConcept)}
                class="self-start text-left text-sm text-(--gk-accent,#2563eb) hover:underline"
            >
                ↳ Use {activeConcept}
            </button>
        {/if}

        <div class="flex flex-wrap gap-1" data-testid="tasks-status-chips">
            {#each STATUS_CHIPS as { value, label } (value)}
                {@render chip(label, filter.statuses.includes(value), () => toggleStatus(value), "tasks-status-chip")}
            {/each}
        </div>

        <div class="flex flex-wrap items-center gap-1">
            <div class="flex gap-1" data-testid="tasks-priority-chips">
                {#each PRIORITY_CHIPS as { value, label } (label)}
                    {@render chip(label, filter.priorities.includes(value), () => togglePriority(value), "tasks-priority-chip")}
                {/each}
            </div>
            <!-- One flex item, so a narrow side view wraps both selects together onto the next line. -->
            <div class="ml-auto flex gap-1" data-testid="tasks-select-group">
                <select
                    data-testid="tasks-due"
                    aria-label="Filter by due date"
                    value={filter.due}
                    onchange={(e) => update({ due: e.currentTarget.value as TaskFilterState["due"] })}
                    class="rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-1.5 py-1 text-sm"
                >
                    <option value="any">Any date</option>
                    <option value="overdue">Overdue</option>
                    <option value="today">Due today</option>
                    <option value="next7">Next 7 days</option>
                </select>
                <select
                    data-testid="tasks-group-by"
                    aria-label="Group tasks by"
                    value={filter.groupBy}
                    onchange={(e) => update({ groupBy: e.currentTarget.value as TaskGroupBy })}
                    class="rounded-md border border-(--gk-border-soft) bg-(--gk-surface-1) px-1.5 py-1 text-sm"
                >
                    <option value="priority">By priority</option>
                    <option value="document">By document</option>
                    <option value="due">By due date</option>
                </select>
            </div>
        </div>
    </div>

    {#if staleNotice}
        <p class="m-0 border-b border-(--gk-border-soft) px-3 py-2 text-sm text-(--gk-text-subtle)" data-testid="tasks-stale">
            {staleNotice}
        </p>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="tasks-list">
        <!-- Refresh, in the list's top-right corner, over the right end of the first group
             heading where there is otherwise nothing. A zero-height sticky row: it takes no
             space, so nothing below it moves, and it pins to the top as the list scrolls, the
             way the headings do (z-20 keeps it above them). Inside the scroller rather than
             over it, so it never sits on the scrollbar. The headings and messages below carry
             pr-8 so no text runs under it.
             -top-2 here and on the headings cancels the list's py-2: sticky insets are measured
             inside the scroller's padding, so top-0 pinned them 8px below the list's edge and
             rows scrolled visibly through the gap above them. -->
        <div class="sticky -top-2 z-20 flex h-0 justify-end">
            <button
                type="button"
                data-testid="tasks-refresh"
                title="Refresh tasks"
                aria-label="Refresh tasks"
                onclick={onRefreshPress}
                class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-(--gk-surface-0) text-(--gk-text-subtle) hover:bg-(--gk-surface-2) hover:text-(--gk-text-strong)"
            >
                <!-- heroicons/outline arrow-path -->
                <svg bind:this={refreshIcon} class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"
                    />
                </svg>
            </button>
        </div>
        {#if loading && hits.length === 0}
            <p class="m-0 py-2 pr-8 text-sm text-(--gk-text-subtle)">Loading…</p>
        {:else if groups.length === 0}
            <p class="m-0 py-2 pr-8 text-sm text-(--gk-text-subtle)" data-testid="tasks-empty">
                {failed
                    ? "Couldn't read the task index. Refresh to try again."
                    : filter.statuses.length === 0 || filter.priorities.length === 0
                      ? "Nothing selected — turn a chip back on."
                      : filter.concept === null
                        ? "No tasks match these filters."
                        : `No tasks for "${filter.concept}".`}
            </p>
        {:else}
            {#each groups as group, g (group.label + g)}
                <section data-testid="tasks-group">
                    <h4
                        class="sticky -top-2 m-0 bg-(--gk-surface-0) py-1 pr-8 text-sm font-semibold uppercase tracking-[0.04em] text-(--gk-text-subtle)"
                        data-testid="tasks-group-label"
                    >
                        {group.label}
                    </h4>
                    <ul class="m-0 list-none p-0">
                        {#each group.hits as hit (hitKey(hit))}
                            {@const tags = parseTaskTags(hit.text)}
                            <li class="rounded-md py-1 hover:bg-(--gk-surface-2)" data-testid="tasks-row">
                                <div class="flex items-start gap-2 px-1">
                                    <!-- mt-1.5 rather than mt-1: the row is items-start, and at
                                         mt-1 the box's centre sat 2px above the first line of
                                         the task's text. -->
                                    <input
                                        type="checkbox"
                                        data-testid="tasks-checkbox"
                                        checked={isDone(hit)}
                                        aria-label="Toggle {tags.text}"
                                        onchange={() => void toggle(hit)}
                                        class="mt-1.5 shrink-0"
                                    />
                                    <button
                                        type="button"
                                        data-testid="tasks-row-open"
                                        onclick={() => open(hit)}
                                        class="min-w-0 flex-1 text-left"
                                    >
                                        <span class="text-sm" class:line-through={isDone(hit)} class:opacity-60={isDone(hit)}>
                                            <!-- A wikilink in the text opens ITS document, as it does in
                                                 the editor and the Backlinks View. It used to pin the Name
                                                 Filter to that concept instead, which read as a link that
                                                 went nowhere; narrowing to a name is the box's job. A
                                                 concept with no page yet is dashed, as the editor draws it. -->
                                            {#each linkParts(tags.text) as part, i (i)}
                                                {#if part.concept !== null}
                                                    <span
                                                        role="button"
                                                        tabindex="0"
                                                        data-testid="tasks-row-wikilink"
                                                        data-concept={part.concept}
                                                        class="cursor-pointer text-(--gk-accent,#2563eb) underline"
                                                        class:decoration-dashed={conceptIsMissing(part.concept)}
                                                        onclick={(e) => {
                                                            e.stopPropagation();
                                                            openConcept(part.concept!);
                                                        }}
                                                        onkeydown={(e) => {
                                                            if (e.key === "Enter" || e.key === " ") {
                                                                e.stopPropagation();
                                                                e.preventDefault();
                                                                openConcept(part.concept!);
                                                            }
                                                        }}>{part.text}</span
                                                    >
                                                {:else}{part.text}{/if}
                                            {/each}
                                        </span>
                                        <span class="ml-1 inline-flex flex-wrap gap-1 align-middle">
                                            {#if tags.priority !== null}
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold" data-testid="tasks-badge-priority">
                                                    P{tags.priority}
                                                </span>
                                            {/if}
                                            {#if tags.waiting}
                                                <!-- Spelled out, like Doing and Cancelled: the tag is `#W`
                                                     in the document, the state is Waiting in the list. -->
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold">Waiting</span>
                                            {/if}
                                            {#if tags.doing}
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold">Doing</span>
                                            {/if}
                                            {#if tags.cancelled}
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold">Cancelled</span>
                                            {/if}
                                            {#if tags.scheduled !== null}
                                                <!-- Named rather than iconised: "start thinking about it then" and
                                                     "must be done by then" are not distinguishable from two glyphs. -->
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold" data-testid="tasks-badge-scheduled">
                                                    Scheduled {tags.scheduled}
                                                </span>
                                            {/if}
                                            {#if tags.due !== null}
                                                <span class="rounded bg-(--gk-surface-2) px-1 text-sm font-semibold" data-testid="tasks-badge-due">
                                                    Due {tags.due}
                                                </span>
                                            {/if}
                                        </span>
                                        <!-- Why this row matched. Under ADR 0051 a task can answer to a
                                             concept through a distant ancestor, so without the chain a
                                             legitimately matching row reads as a bug. -->
                                        <span class="mt-0.5 block truncate text-sm text-(--gk-text-subtle)" data-testid="tasks-row-chain">
                                            {[hit.concept, ...hit.breadcrumb.map(crumbText)].join(" › ")}
                                        </span>
                                    </button>
                                </div>
                            </li>
                        {/each}
                    </ul>
                </section>
            {/each}

            {#if hasMore}
                <button
                    type="button"
                    data-testid="tasks-show-more"
                    onclick={showMore}
                    class="mt-2 w-full rounded-md border border-(--gk-border-soft) py-1.5 text-sm hover:bg-(--gk-surface-2)"
                >
                    Show more
                </button>
            {/if}
        {/if}
    </div>
</div>
