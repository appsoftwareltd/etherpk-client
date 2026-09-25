<script lang="ts">
    /**
     * The [[Journal Calendar]]: the [[Sidebar]]'s month grid for walking between
     * [[Journal Entry]]s (`CONTEXT.md`, ADR 0056).
     *
     * A surface over **days, not documents**. Every day of the month is a target whether or not
     * anything was written on it; picking one opens it, and a day with nothing behind it opens a
     * [[Draft]] like any other unwritten [[Concept]] — browsing here creates nothing. Days
     * something already resolves to are bold, which is what makes a graph's written history
     * legible at a glance.
     *
     * The grid itself is the shared framework-free renderer the Command Menu's pick-a-date
     * popover also paints (`../calendar/month-grid.ts`), attached rather than templated, the same
     * way the context menu attaches itself. What lives here is everything the popover cannot
     * share: real DOM focus (a roving tabindex, because forty-two tab stops between [[Quick
     * Find]] and [[Favourite]]s would be impassable) and following the active document.
     */
    import {
        formatISODate,
        msUntilNextLocalMidnight,
        parseISODate,
        shiftDate,
        shiftMonth,
        shiftYear,
    } from "../calendar/month-grid-core";
    import {
        createMonthGrid,
        type MonthGridMode,
    } from "../calendar/month-grid";

    const {
        hasEntry,
        onPick,
        activeConcept,
    }: {
        /** True when a [[Document]] resolves to that day — the day renders bold. */
        hasEntry: (iso: string) => boolean;
        /** Open that day. Written or not: the caller decides nothing, it just navigates. */
        onPick: (iso: string) => void;
        /**
         * The document currently showing in the main region, so the calendar can follow it.
         * Anything that is not a day leaves the month where the user put it.
         */
        activeConcept?: string | null;
    } = $props();

    let focused = $state(new Date());
    let mode = $state<MonthGridMode>("days");
    /**
     * Bumped at each local midnight so the grid repaints and its "today" ring moves on. The
     * renderer reads the clock on every paint; this is what makes a paint happen when nothing
     * else in the Sidebar has changed, which is exactly the tab left open overnight.
     */
    let dayTick = $state(0);
    $effect(() => {
        let timer: ReturnType<typeof setTimeout>;
        const arm = () => {
            timer = setTimeout(() => {
                dayTick += 1;
                arm();
            }, msUntilNextLocalMidnight());
        };
        arm();
        return () => clearTimeout(timer);
    });
    /** Set while a keystroke moved the selection, so focus follows the repaint. */
    let refocus = false;

    /**
     * Follow the active document, but only when it is a day.
     *
     * Unlike the [[Tasks View]], which is deliberately pinned, this is a mirror of where you are:
     * arriving at an entry from a [[Backlink]] or [[Quick Find]] should leave the calendar
     * showing the month you are now reading. Opening a page moves nothing — most navigation is
     * not to a journal entry, and yanking the month about for it would make the grid unusable.
     */
    $effect(() => {
        const day = activeConcept ? parseISODate(activeConcept) : null;
        if (day) focused = day;
    });

    function pick(iso: string) {
        const day = parseISODate(iso);
        if (day) focused = day; // an adjacent-month day pages the grid onto its own month
        onPick(iso);
    }

    /**
     * Arrow keys move the selection; Enter/Space opens it. The renderer owns no keyboard — the
     * popover's model is a CodeMirror keymap over a grid that must never take focus, and the two
     * cannot be one handler — so this is the Sidebar's half, thin over the shared date maths.
     */
    function onKeydown(event: KeyboardEvent) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const move = (fn: (d: Date) => Date) => {
            event.preventDefault();
            focused = fn(focused);
            refocus = true;
        };
        switch (event.key) {
            case "ArrowRight":
                return move((d) => (mode === "days" ? shiftDate(d, 1) : shiftMonth(d, 1)));
            case "ArrowLeft":
                return move((d) => (mode === "days" ? shiftDate(d, -1) : shiftMonth(d, -1)));
            case "ArrowDown":
                return move((d) => (mode === "days" ? shiftDate(d, 7) : shiftMonth(d, 3)));
            case "ArrowUp":
                return move((d) => (mode === "days" ? shiftDate(d, -7) : shiftMonth(d, -3)));
            case "PageDown":
                return move((d) => (mode === "days" ? shiftMonth(d, 1) : shiftYear(d, 1)));
            case "PageUp":
                return move((d) => (mode === "days" ? shiftMonth(d, -1) : shiftYear(d, -1)));
            case "Home":
                return move((d) => shiftDate(d, -(((d.getDay() + 6) % 7))));
            case "End":
                return move((d) => shiftDate(d, 6 - ((d.getDay() + 6) % 7)));
            case "Enter":
            case " ":
                event.preventDefault();
                if (mode === "months") {
                    mode = "days";
                    refocus = true;
                } else pick(formatISODate(focused));
                return;
            case "Escape":
                if (mode === "months") {
                    event.preventDefault();
                    mode = "days";
                    refocus = true;
                }
                return;
        }
    }

    /**
     * Mount the shared renderer and keep it painted. Repainting rebuilds the grid's elements, so
     * a key-driven move has to put DOM focus back on the newly selected cell — that is the other
     * half of the roving tabindex, and without it the first arrow press would drop focus to the
     * document body.
     */
    function grid(node: HTMLElement) {
        const instance = createMonthGrid({
            hasEntry,
            focusable: true,
            allowYearView: true,
            testId: "journal-calendar",
            onPick: pick,
            onPage: (delta) => {
                focused = mode === "days" ? shiftMonth(focused, delta) : shiftYear(focused, delta);
            },
            onPickMonth: (year, month) => {
                focused = new Date(year, month, Math.min(focused.getDate(), 28));
                mode = "days";
            },
            onToggleMode: () => (mode = mode === "days" ? "months" : "days"),
        });
        node.appendChild(instance.dom);
        // Listened for on the grid itself rather than on a wrapper: the cells are the
        // interactive things (the renderer gives them grid/gridcell roles), and hanging keys off
        // a non-interactive div would mean claiming `role="application"`, which switches a
        // screen reader out of the browse mode this grid is perfectly navigable in.
        instance.dom.addEventListener('keydown', onKeydown);

        // Reading `focused`/`mode`/`hasEntry` here is what subscribes the repaint to them; the
        // marks must also refresh when the graph gains a document, which is why `hasEntry` is
        // called through on every paint rather than snapshotted.
        $effect(() => {
            void dayTick;
            instance.render({ focused, mode });
            if (refocus) {
                refocus = false;
                instance.focusSelected();
            }
        });

        return () => {
            instance.dom.removeEventListener('keydown', onKeydown);
            instance.destroy();
            instance.dom.remove();
        };
    }
</script>

<div class="px-1" aria-label="Journal calendar" {@attach grid}></div>
