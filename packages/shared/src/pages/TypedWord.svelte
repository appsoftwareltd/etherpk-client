<script lang="ts">
    import { onMount } from "svelte";
    import { typewriterFrames, type TypewriterTiming } from "./typewriter";

    /**
     * A word that is typed over, as at a terminal, by each of `words` in turn, behind an
     * underscore caret, and then settles back on the first word. It plays once per page load.
     *
     * The first word is the only one the server renders, the one a visitor with reduced motion
     * sees, and the one screen readers read throughout: while the animation runs, they get it
     * from a copy only they can see and skip the moving one. Before and after, the visible word is
     * the only copy, so the page's text never carries the word twice when nothing is moving.
     *
     * The component is a block of its own, one line high whatever it shows, so nothing below it
     * moves as words come and go. Every word must fit on one line at the narrowest width.
     */
    let {
        words,
        timing = { holdMs: 1000, deleteMs: 40, typeMs: 75 },
        testId,
    }: {
        words: readonly string[];
        timing?: TypewriterTiming;
        /** Marks the visible word, for end-to-end tests. */
        testId?: string;
    } = $props();

    // How long the caret keeps blinking on the settled word before it goes.
    const SETTLE_MS = 2000;

    // "still": as rendered on the server. "reduced": the visitor asked for less motion.
    let phase = $state<"still" | "reduced" | "typing" | "done">("still");
    let typed = $state<string | null>(null);
    let holding = $state(true);

    const shown = $derived(typed ?? words[0]);

    onMount(() => {
        const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
        if (reducedMotion.matches) {
            phase = "reduced";
            return;
        }
        const frames = typewriterFrames(words, timing);
        if (frames.length < 2) return;

        let timer: ReturnType<typeof setTimeout> | undefined;
        let index = 0;
        const settle = (to: typeof phase) => {
            clearTimeout(timer);
            typed = null;
            phase = to;
        };
        const step = () => {
            const frame = frames[index++];
            typed = frame.text;
            holding = frame.holding;
            timer = index < frames.length ? setTimeout(step, frame.waitMs) : setTimeout(() => settle("done"), SETTLE_MS);
        };
        // Turning reduced motion on part-way through stops the animation on the first word.
        const onMotionChange = () => {
            if (reducedMotion.matches) settle("reduced");
        };

        phase = "typing";
        reducedMotion.addEventListener("change", onMotionChange);
        step();
        return () => {
            clearTimeout(timer);
            reducedMotion.removeEventListener("change", onMotionChange);
        };
    });
</script>

<span class="block whitespace-nowrap" data-typewriter={phase}>
    {#if phase === "typing"}<span class="sr-only">{words[0]}</span>{/if}
    <!-- The caret is absolutely placed with no offsets, so it sits where it would in the text but
         takes no width: the word stays centred, and an empty word leaves the caret in the middle. -->
    <span class="relative" aria-hidden={phase === "typing" ? "true" : undefined}
        ><span data-testid={testId}>{shown || "​"}</span
        >{#if phase === "typing"}<span class={["absolute", { blink: holding }]}>_</span>{/if}</span
    >
</span>

<style>
    /* A terminal's caret: solid while it types, blinking while it waits. */
    .blink {
        animation: caret-blink 1s step-end infinite;
    }

    @keyframes caret-blink {
        50% {
            visibility: hidden;
        }
    }
</style>
