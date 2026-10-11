<script lang="ts">
    /**
     * The [[Journal Roll]] beneath a journal tab's entry and its backlinks (ADR 0136): the older
     * written days, newest first, each loaded only when asked for, each an editor at its natural
     * height with its own backlinks, under a bar that names it. The state (which day is next, the
     * cap, hiding) is `journal-roll.ts`; this draws it and listens for the reader asking.
     *
     * **Asking for a day.** The trailing bar loads its day when the reader scrolls or swipes down
     * while the bar is wholly in view (a downward wheel or swipe counts even when nothing can
     * scroll, as on a short entry), or selects it. Nothing loads when the tab opens. A bar just
     * hidden does not load again until it has left the view, and a load is followed by a short pause,
     * so one flick of a trackpad does not load a week.
     *
     * **Keeping the reading point still** while a day above the reader, or the tab's backlinks,
     * changes height is `reading-point.ts`.
     *
     * DocumentView mounts this once for the tab's life into a holder of its own after the backlinks
     * holder, and hands it each editor's scroller as the editor is built (`attach`).
     */
    import { type Component, onDestroy, onMount, tick, untrack } from "svelte";

    import type { ViewRef, ViewVisibility } from "$lib/layout";
    import { tryGetActiveEventBus } from "$lib/surface";

    import { getActiveDocument, setActiveDocument } from "../active-document";
    import { getActiveDocumentStore } from "../active-store";
    import { createJournalRoll, type JournalRollState } from "../journal-roll";
    import { openConcept } from "../open-concept";
    import { CONTENT_PAD_X } from "./cm-document";
    import { DOCUMENT_BACKLINKS_ATTRIBUTE } from "./document-backlinks";
    import { registerJournalRoll } from "./journal-roll-dom";
    import { keepReadingPoint } from "./reading-point";
    import JournalRollBar from "./JournalRollBar.svelte";

    /** What a loaded day is drawn with: DocumentView, handed in to keep the two modules apart. */
    type DayView = Component<{ view: ViewRef; rolled?: boolean; panelId?: string; visibility?: ViewVisibility }>;

    let {
        anchor,
        day: Day,
        panelId,
        visibility,
        ondrawnchange,
    }: {
        /** The tab's own entry: the roll starts below it and never goes newer. */
        anchor: string;
        day: DayView;
        panelId?: string;
        visibility?: ViewVisibility;
        /** Told when the roll starts or stops drawing anything. */
        ondrawnchange?: (drawn: boolean) => void;
    } = $props();

    /** The registry's concepts as they are now: what the Journal Calendar marks as written. */
    function registryConcepts(): string[] {
        const store = getActiveDocumentStore() as { listDocuments?: () => { concept: string }[] };
        return store.listDocuments?.().map((entry) => entry.concept) ?? [];
    }

    const roll = createJournalRoll({
        anchor: untrack(() => anchor),
        entries: registryConcepts,
        onChange(next) {
            rollState = next;
            report(next);
        },
    });
    let rollState = $state.raw<JournalRollState>(roll.state());
    /** Loaded days whose entry has gone from the graph since they loaded. */
    let gone = $state.raw<ReadonlySet<string>>(new Set());

    let drawn = false;
    function report(next: JournalRollState) {
        const nowDrawn = next.next !== null || next.loaded.length > 0;
        if (nowDrawn === drawn) return;
        drawn = nowDrawn;
        ondrawnchange?.(nowDrawn);
    }
    report(roll.state());

    // ---- Asking for a day --------------------------------------------------------------------
    /** The scroller the roll is in: the tab's editor's, handed over with each editor (`attach`). */
    let scroller = $state.raw<HTMLElement | null>(null);
    /** The bar after the last loaded day, while there is one. */
    let trailing = $state<HTMLElement>();
    let wholeInView = false;
    /** Off once a bar is hidden, until it has left the view. */
    let armed = true;
    /** No scroll load before this time: one flick of a trackpad is a stream of wheel events. */
    let pausedUntil = 0;
    const PAUSE_AFTER_LOAD_MS = 600;
    /** A swipe this far up, in px, is a scroll down. */
    const SWIPE_PX = 24;

    /** Take the tab's scroller: the roll's root has just been put into a new editor's. */
    export function attach(next: HTMLElement): void {
        scroller = next;
        keeper.setScroller(next);
    }

    $effect(() => {
        const root = scroller;
        const bar = trailing;
        if (!root || !bar || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            ([entry]) => {
                wholeInView = entry.intersectionRatio >= 0.98;
                if (!entry.isIntersecting) armed = true;
            },
            { root, threshold: [0, 0.98] },
        );
        observer.observe(bar);
        return () => {
            observer.disconnect();
            wholeInView = false;
        };
    });

    $effect(() => {
        const root = scroller;
        if (!root) return;
        let touchY: number | null = null;
        // Not a pinch (a wheel with Ctrl), and not a popover's own list scrolling inside an editor.
        const onWheel = (event: WheelEvent) => {
            if (event.ctrlKey || (event.target instanceof Element && event.target.closest(".cm-tooltip"))) return;
            if (event.deltaY > 0) scrolledDown();
        };
        const onTouchStart = (event: TouchEvent) => {
            touchY = event.touches[0]?.clientY ?? null;
        };
        const onTouchMove = (event: TouchEvent) => {
            const y = event.touches[0]?.clientY;
            if (touchY === null || y === undefined || touchY - y < SWIPE_PX) return;
            touchY = y;
            scrolledDown();
        };
        root.addEventListener("wheel", onWheel, { passive: true });
        root.addEventListener("touchstart", onTouchStart, { passive: true });
        root.addEventListener("touchmove", onTouchMove, { passive: true });
        return () => {
            root.removeEventListener("wheel", onWheel);
            root.removeEventListener("touchstart", onTouchStart);
            root.removeEventListener("touchmove", onTouchMove);
        };
    });

    function scrolledDown(): void {
        if (!armed || !wholeInView || performance.now() < pausedUntil) return;
        void loadNext({ focus: false });
    }

    /** Load the next older day; with `focus`, hand the focus to its bar (a selection, a Command). */
    async function loadNext({ focus }: { focus: boolean }): Promise<boolean> {
        const day = roll.load();
        if (day === null) return false;
        pausedUntil = performance.now() + PAUSE_AFTER_LOAD_MS;
        await tick();
        if (focus) barFor(day)?.focus();
        keeper.remember();
        return true;
    }

    /** Unload `day` and every older day, and give the focus back to its bar. */
    async function hide(day: string): Promise<void> {
        const hidden = rollState.loaded.slice(rollState.loaded.indexOf(day));
        roll.hideFrom(day);
        armed = false;
        // The Backlinks panel and the Command Bar followed a day that is no longer on screen.
        const active = getActiveDocument();
        if (active !== null && hidden.includes(active)) setActiveDocument(untrack(() => anchor));
        await tick();
        trailing?.focus();
        keeper.remember();
    }

    function open(day: string): void {
        openConcept(day, panelId);
    }

    let root = $state<HTMLElement>();
    function barFor(day: string): HTMLElement | null {
        return root?.querySelector<HTMLElement>(`[data-testid="journal-roll-bar"][data-state="loaded"][data-day="${day}"]`) ?? null;
    }

    // ---- Keeping the reading point still ------------------------------------------------------
    const keeper = keepReadingPoint(
        () => root?.querySelectorAll<HTMLElement>(':scope > [data-testid="journal-roll-day"], :scope > .journal-roll__bar--trailing') ?? [],
        (tabScroller) => tabScroller.querySelector<HTMLElement>(`:scope > div > [${DOCUMENT_BACKLINKS_ATTRIBUTE}]`),
    );

    /** Watch a loaded day's size for the reading point (an attachment). */
    function measured(block: HTMLElement) {
        return keeper.watch(block);
    }

    // ---- Registry changes, and the Command ------------------------------------------------------
    function registryChanged(): void {
        roll.refresh();
        const written = new Set(registryConcepts());
        const missing = rollState.loaded.filter((day) => !written.has(day));
        if (missing.length !== gone.size || missing.some((day) => !gone.has(day))) gone = new Set(missing);
    }

    function register(element: HTMLElement) {
        return registerJournalRoll(element, {
            canLoad: () => !rollState.atCap && rollState.next !== null,
            loadAndFocus: () => loadNext({ focus: true }),
        });
    }

    let detachBus: (() => void) | undefined;
    onMount(() => {
        detachBus = tryGetActiveEventBus()?.on("documents:changed", registryChanged);
    });
    onDestroy(() => {
        detachBus?.();
        keeper.destroy();
    });
</script>

<!-- Only while there is something to draw: an empty row in CodeMirror's flex row, which DocumentView
     wraps only while something is drawn, would take the width and squeeze the text to nothing. -->
{#if rollState.next !== null || rollState.loaded.length > 0}
<div
    bind:this={root}
    class="journal-roll"
    style:--content-pad-x={CONTENT_PAD_X}
    data-journal-roll
    data-testid="journal-roll"
    {@attach register}
>
    {#each rollState.loaded as day (day)}
        <section class="journal-roll__day" data-testid="journal-roll-day" data-day={day} aria-label={day} {@attach measured}>
            <div class="journal-roll__bar">
                <JournalRollBar mode="loaded" {day} onhide={() => void hide(day)} onopen={() => open(day)} />
            </div>
            {#if gone.has(day)}
                <p class="journal-roll__gone" data-testid="journal-roll-gone">This entry is no longer in the graph.</p>
            {:else}
                <Day view={{ kind: "document", target: day }} rolled {panelId} {visibility} />
            {/if}
        </section>
    {/each}
    {#if rollState.next !== null}
        <div class="journal-roll__bar journal-roll__bar--trailing" {@attach measured}>
            <JournalRollBar
                bind:element={trailing}
                mode={rollState.atCap ? "open" : "unloaded"}
                day={rollState.next}
                onload={() => void loadNext({ focus: true })}
                onopen={() => open(rollState.next!)}
            />
        </div>
    {/if}
</div>
{/if}

<style>
    /* A row of its own in the tab's scroller, which CodeMirror lays out as a flex row and
       DocumentView wraps while anything is drawn beneath the text. */
    .journal-roll {
        flex: 0 0 100%;
        min-width: 0;
    }
    /* The bars line up with the text above them (CONTENT_PAD_X). A loaded day's bar and the bar
       that offered it sit the same distance below what is above them, so loading swaps one for
       the other in place. */
    .journal-roll__bar {
        margin: 0.5rem var(--content-pad-x) 0;
    }
    .journal-roll__bar--trailing {
        margin-bottom: 1.5rem;
    }
    .journal-roll__gone {
        margin: 0.75rem var(--content-pad-x) 1.5rem;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
    }
</style>
