<script lang="ts">
    /**
     * "File under": the concepts a [[Quick Note]] can be filed under, which are the person's
     * [[Favourite]]s (ADR 0186, `quick-note-filing.ts`). One row that scrolls sideways, so its
     * height is the same with three favourites as with thirty and nothing below it moves. One
     * concept at a time, and pressing the chosen one clears it. Nothing is drawn with no
     * favourites to offer.
     */
    let {
        choices,
        selected = $bindable(null),
        testid,
        roomy = false,
    }: {
        choices: readonly string[];
        selected?: string | null;
        testid: string;
        /** The share page's size: taller chips, for a thumb. */
        roomy?: boolean;
    } = $props();

    const labelId = $derived(`${testid}-label`);
</script>

{#if choices.length > 0}
    <div data-testid={testid}>
        <p id={labelId} class="mb-1.5 text-sm font-medium text-(--gk-text-muted)">Link to Favourite</p>
        <div role="group" aria-labelledby={labelId} class="-mx-1 flex gap-2 overflow-x-auto px-1 py-1">
            {#each choices as choice (choice)}
                <button
                    type="button"
                    aria-pressed={choice === selected}
                    onclick={() => (selected = choice === selected ? null : choice)}
                    data-testid="{testid}-choice"
                    class={[
                        "max-w-56 shrink-0 truncate rounded-full border text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--gk-accent)",
                        roomy ? "px-4 py-1.5" : "px-3 py-0.5",
                        "pointer-coarse:min-h-11",
                        choice === selected
                            ? "border-(--gk-accent) bg-(--gk-selection) font-medium text-(--gk-text-strong)"
                            : "border-(--gk-border-strong) text-(--gk-text-default) hover:bg-(--gk-surface-2)",
                    ]}
                >
                    {choice}
                </button>
            {/each}
        </div>
    </div>
{/if}
