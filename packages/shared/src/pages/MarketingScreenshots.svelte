<script lang="ts">
    import { onMount } from "svelte";

    /**
     * The landing page's screenshots of the app: the demo graph in four views, one at a time, in a
     * carousel that moves on by itself. It follows the WAI-ARIA tabbed carousel pattern: a row of
     * tabs names each screenshot, and a button before them starts and stops the turns (WCAG 2.2.2
     * asks for one on anything that moves for more than five seconds).
     *
     * The turns stop when the visitor takes over: choosing a tab, focusing one from the keyboard,
     * or swiping. They pause, and carry on where they left off, while the mouse is over the
     * carousel (so nothing changes under a pointer about to click) or the page is hidden. A visitor
     * who asks for reduced motion gets the first screenshot, still, and can press play. The server
     * renders the first screenshot with the turns stopped, and they start once the page runs.
     *
     * Every screenshot has the same pixel size, declared on each image so the page reserves the
     * space before the bytes arrive. They are stacked in one grid cell and fade into one another,
     * so the frame never changes size. Each app serves the files from `static/marketing/`, which
     * `pnpm marketing:images` fills.
     */

    type Screenshot = {
        id: string;
        /** The tab's label. One short word, so the four tabs fit on one row on a phone. */
        label: string;
        src: string;
        alt: string;
        caption: string;
    };

    // The pixel size every screenshot is shot at (scripts/marketing-screenshot.mjs and
    // scripts/readme-screenshots.mjs: a 1655x935 window at device scale 1.4).
    const WIDTH = 2317;
    const HEIGHT = 1309;

    /** How long each screenshot stays before the next takes its place: long enough to read it. */
    const TURN_MS = 7000;

    /** How far a finger has to travel sideways before a touch counts as a swipe. */
    const SWIPE_PX = 40;

    // The alt text and the caption describe what is in shot, so re-read them after a re-shoot.
    const SCREENSHOTS: Screenshot[] = [
        {
            id: "graph",
            label: "Graph",
            src: "/marketing/graph-view-dark.webp",
            alt: "The EtherPK Client in the dark theme, showing the demo graph in the whole Graph View: each page is a dot, each wikilink a line, and each cluster of closely linked pages has its own colour, with place names drawn as rings. Beside it is the list of Hubs, and the Backlinks pane on the right lists everything that mentions the Plant page.",
            caption:
                "The Graph View: every page in the demo graph and the wikilinks between them.",
        },
        {
            id: "editor",
            label: "Editor",
            src: "/marketing/editor-dark.webp",
            alt: "The EtherPK Client in the dark theme, showing the Plant page of the demo graph in the editor: its frontmatter, paragraphs of prose under a heading, then an outline of nested bullets full of wikilinks. The Backlinks pane on the right lists the journal entries that mention the page.",
            caption:
                "The editor: prose and outliner blocks in one document, with the page's backlinks beside it.",
        },
        {
            id: "kanban",
            label: "Kanban",
            src: "/marketing/kanban-board-dark.webp",
            alt: "The EtherPK Client in the dark theme, showing a Kanban board of the tasks about the Monstera page, gathered from journal entries and pages across the demo graph into Open, Doing and Waiting columns grouped by priority. The chosen task is shown in its journal entry below the board.",
            caption:
                "A Kanban board of the tasks about one page, gathered from across the graph.",
        },
        {
            id: "maps",
            label: "Maps",
            src: "/marketing/map-view-dark.webp",
            alt: "The EtherPK Client in the dark theme, showing a Map View of the botanical gardens noted under the Where to Learn About Plants page across the demo graph: pins on a world map, with a list beside it grouped by the document each place was noted in.",
            caption:
                "A Map View of the places noted under one page, gathered from across the graph.",
        },
    ];

    const uid = $props.id();
    const tabId = (shot: Screenshot) => `${uid}-tab-${shot.id}`;
    const panelId = (shot: Screenshot) => `${uid}-panel-${shot.id}`;

    /** The screenshot in view. */
    let current = $state(0);
    /** Whether the screenshots take turns. The play and pause button shows and sets it. */
    let rotating = $state(false);
    let pointerOver = $state(false);
    let pageHidden = $state(false);
    /** Whether the clock is running on the current turn: rotating, and nothing pausing it. */
    const turning = $derived(rotating && !pointerOver && !pageHidden);

    // What is left of the screenshot's turn, kept across a pause so the turn carries on where it
    // stopped, as the progress bar does. Only the timer reads it, so it is not reactive.
    let turn = { index: 0, remainingMs: TURN_MS };

    $effect(() => {
        if (!turning) return;
        const index = current;
        if (turn.index !== index) turn = { index, remainingMs: TURN_MS };
        const startedAt = performance.now();
        const timer = setTimeout(() => show(index + 1), turn.remainingMs);
        return () => {
            clearTimeout(timer);
            // Only a pause lands here with the same screenshot in view; after a change of
            // screenshot the next run starts a whole turn for the new one.
            if (turn.index === index) {
                turn.remainingMs = Math.max(
                    0,
                    turn.remainingMs - (performance.now() - startedAt),
                );
            }
        };
    });

    onMount(() => {
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
        if (!reducedMotion.matches) play();
        // Turning reduced motion on part-way through stops the turns where they are.
        const onMotionChange = () => {
            if (reducedMotion.matches) rotating = false;
        };
        reducedMotion.addEventListener("change", onMotionChange);
        return () =>
            reducedMotion.removeEventListener("change", onMotionChange);
    });

    function show(index: number) {
        const count = SCREENSHOTS.length;
        current = ((index % count) + count) % count;
    }

    /** Starts the turns with a whole turn for the screenshot in view, as the progress bar starts. */
    function play() {
        turn = { index: current, remainingMs: TURN_MS };
        rotating = true;
    }

    /** The visitor has chosen what to look at, so the screenshots stop taking turns. */
    function takeOver() {
        rotating = false;
    }

    function onTabKeydown(event: KeyboardEvent, index: number) {
        let target: number;
        switch (event.key) {
            case "ArrowRight":
                target = index + 1;
                break;
            case "ArrowLeft":
                target = index - 1;
                break;
            case "Home":
                target = 0;
                break;
            case "End":
                target = SCREENSHOTS.length - 1;
                break;
            default:
                return;
        }
        event.preventDefault();
        show(target);
        // Automatic activation: the focused tab is the chosen one, so focus follows the choice.
        document.getElementById(tabId(SCREENSHOTS[current]))?.focus();
    }

    // A swipe is a touch or pen stroke that travels mostly sideways. A mouse drag is not one: on
    // a desktop it selects or drags the image, as it would anywhere else.
    let swipeStart: { x: number; y: number; pointerId: number } | null = null;

    function onSwipeStart(event: PointerEvent) {
        if (event.pointerType === "mouse" || !event.isPrimary) return;
        swipeStart = {
            x: event.clientX,
            y: event.clientY,
            pointerId: event.pointerId,
        };
    }

    function onSwipeEnd(event: PointerEvent) {
        if (!swipeStart || event.pointerId !== swipeStart.pointerId) return;
        const dx = event.clientX - swipeStart.x;
        const dy = event.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5)
            return;
        takeOver();
        // Leftwards brings the next screenshot in from the right, as on any phone.
        show(current + (dx < 0 ? 1 : -1));
    }

    // A touch fires pointerenter and pointerleave too, so only the mouse counts as pointing.
    function onPointerEnter(event: PointerEvent) {
        if (event.pointerType === "mouse") pointerOver = true;
    }

    function onPointerLeave(event: PointerEvent) {
        if (event.pointerType === "mouse") pointerOver = false;
    }
</script>

<svelte:document onvisibilitychange={() => (pageHidden = document.hidden)} />

<section
    aria-roledescription="carousel"
    aria-label="EtherPK screenshots"
    class="mx-auto mt-14 max-w-6xl px-4 sm:mt-20 sm:px-6"
    onpointerenter={onPointerEnter}
    onpointerleave={onPointerLeave}
>
    <div
        class="overflow-hidden rounded-xl bg-gray-950 shadow-2xl shadow-gray-950/15 ring-1 ring-gray-950/10 sm:rounded-2xl dark:shadow-black/40 dark:ring-white/10"
    >
        <!-- One grid cell holds every screenshot, so the frame is the size of one. The screenshot
             coming in fades in on top, and the one going out stays whole beneath it until it is
             covered, so the frame never dims between the two. A live region only while the
             turns are stopped: a change the visitor asked for is announced, a timed one is not.
             Vertical panning and pinch zoom stay with the browser, sideways strokes are swipes.
             A swipe is only a shortcut for the tabs below, which are the keyboard path. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
            data-testid="marketing-screenshot-slides"
            class="grid touch-pan-y touch-pinch-zoom"
            aria-live={rotating ? "off" : "polite"}
            onpointerdown={onSwipeStart}
            onpointerup={onSwipeEnd}
            onpointercancel={() => (swipeStart = null)}
        >
            {#each SCREENSHOTS as shot, index (shot.id)}
                <div
                    id={panelId(shot)}
                    role="tabpanel"
                    aria-roledescription="slide"
                    aria-labelledby={tabId(shot)}
                    class={[
                        "col-start-1 row-start-1 transition-[opacity,visibility] duration-200 ease-out motion-reduce:transition-none",
                        index === current
                            ? "visible z-10 opacity-100"
                            : "invisible opacity-0 delay-200",
                    ]}
                >
                    <img
                        src={shot.src}
                        width={WIDTH}
                        height={HEIGHT}
                        alt={shot.alt}
                        fetchpriority={index === 0 ? "high" : "low"}
                        loading={index === 0 ? "eager" : "lazy"}
                        decoding="async"
                        class="block h-auto w-full"
                    />
                </div>
            {/each}
        </div>
    </div>

    <div class="mt-5 flex items-center justify-center gap-2">
        <button
            type="button"
            aria-label={rotating ? "Pause slideshow" : "Play slideshow"}
            title={rotating ? "Pause slideshow" : "Play slideshow"}
            class="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-gray-700 ring-1 ring-gray-950/10 transition-colors ring-inset hover:bg-gray-950/5 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 dark:text-gray-300 dark:ring-white/15 dark:hover:bg-white/10 dark:hover:text-white dark:focus-visible:outline-white"
            onclick={() => (rotating ? takeOver() : play())}
        >
            <!-- The icons ignore the pointer, so the node under it is always the button. Chrome
                 can miss the pointerleave of a node swapped out from under the pointer, and the
                 carousel would then think it is still pointed at and never move again. -->
            {#if rotating}
                <svg
                    class="pointer-events-none size-4"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <rect x="3.5" y="2.5" width="3" height="11" rx="1" />
                    <rect x="9.5" y="2.5" width="3" height="11" rx="1" />
                </svg>
            {:else}
                <svg
                    class="pointer-events-none size-4"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    aria-hidden="true"
                >
                    <path
                        d="M4.5 3.13a1 1 0 0 1 1.5-.87l7.5 4.37a1 1 0 0 1 0 1.74L6 12.74a1 1 0 0 1-1.5-.87V3.13Z"
                    />
                </svg>
            {/if}
        </button>

        <!-- One tab stop for the row: the chosen tab. The arrow keys, Home and End choose among them. -->
        <div
            role="tablist"
            aria-label="Screenshots"
            class="inline-flex items-center gap-0.5 rounded-full bg-gray-950/5 p-1 ring-1 ring-gray-950/5 ring-inset dark:bg-white/5 dark:ring-white/10"
        >
            {#each SCREENSHOTS as shot, index (shot.id)}
                <button
                    type="button"
                    role="tab"
                    id={tabId(shot)}
                    aria-controls={panelId(shot)}
                    aria-selected={index === current}
                    tabindex={index === current ? 0 : -1}
                    class={[
                        "relative h-8 overflow-hidden rounded-full px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-950 sm:px-4 dark:focus-visible:outline-white",
                        index === current
                            ? "bg-white text-gray-950 shadow-sm dark:bg-white/15 dark:text-white"
                            : "text-gray-600 hover:text-gray-950 dark:text-gray-300 dark:hover:text-white",
                    ]}
                    onfocus={takeOver}
                    onclick={() => {
                        takeOver();
                        show(index);
                    }}
                    onkeydown={(event) => onTabKeydown(event, index)}
                >
                    {shot.label}
                    <!-- How long the screenshot has left. It freezes when the turns pause and is
                         created afresh with each turn, so it starts as the timer does. -->
                    {#if rotating && index === current}
                        <span
                            aria-hidden="true"
                            class="turn-progress pointer-events-none absolute inset-x-3 bottom-1 h-0.5 origin-left rounded-full bg-gray-950/30 motion-reduce:hidden dark:bg-white/40"
                            style:animation-duration="{TURN_MS}ms"
                            style:animation-play-state={turning
                                ? "running"
                                : "paused"}
                        ></span>
                    {/if}
                </button>
            {/each}
        </div>
    </div>

    <!-- Every caption takes the same grid cell, so the space below is the longest caption's and
         nothing under it moves when the screenshot changes. -->
    <div
        class="mx-auto mt-4 grid max-w-3xl text-center text-sm leading-6 text-gray-500 dark:text-gray-400"
    >
        {#each SCREENSHOTS as shot, index (shot.id)}
            <p
                data-testid="marketing-screenshot-caption"
                class={[
                    "col-start-1 row-start-1 text-pretty",
                    index !== current && "invisible",
                ]}
            >
                {shot.caption}
            </p>
        {/each}
    </div>
</section>

<style>
    .turn-progress {
        animation-name: turn-progress;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
    }

    @keyframes turn-progress {
        from {
            transform: scaleX(0);
        }
        to {
            transform: scaleX(1);
        }
    }
</style>
