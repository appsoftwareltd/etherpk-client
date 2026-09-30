<script lang="ts">
    /**
     * A card's text: the editor's own reading of one line (`inline-parts.ts`), drawn as styled
     * text. Nothing in it is a control, because the whole card is the one thing to click, and a
     * link inside a button is a control the keyboard cannot reach. A wikilink looks like a link
     * and opens nothing; the card opens the task.
     */
    import { type InlineMark, inlineParts } from "$lib/document/inline-parts";

    const { text }: { text: string } = $props();

    const parts = $derived(inlineParts(text));

    const MARK_CLASSES: Record<InlineMark, string> = {
        strong: "font-semibold",
        em: "italic",
        code: "rounded bg-(--gk-surface-2) px-0.5 font-mono",
        strike: "line-through",
        highlight: "rounded-sm bg-(--gk-highlight-bg)",
    };

    function markClasses(marks: readonly InlineMark[] | undefined): string {
        return marks?.map((mark) => MARK_CLASSES[mark]).join(" ") ?? "";
    }
</script>

<!-- Every part on one line: whitespace between the spans would put spaces into the text. -->
{#each parts as part, i (i)}{#if part.kind === "wikilink" || part.kind === "link" || part.kind === "file-link" || part.kind === "asset"}<span class={["text-(--gk-accent) underline", markClasses(part.marks)]}>{part.text}</span>{:else if part.kind === "image"}<span class={["italic", markClasses(part.marks)]}>{part.alt || "image"}</span>{:else if part.kind === "math"}<span class={["font-mono", markClasses(part.marks)]}>{part.text}</span>{:else}<span class={markClasses(part.marks)}>{part.text}</span>{/if}{/each}
