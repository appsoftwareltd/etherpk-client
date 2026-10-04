<script lang="ts">
    /**
     * One rename in a rename dialog (ADR 0065): the old and new names, a tick when the rename can be
     * left out, how its run went, why it failed or is refused, and its impact with the choice of
     * keeping the old name or updating the links. Shared by the rows of the dialog a link edit
     * opens and by a page's own dialog, where the page's row has no tick (the page always takes the
     * name typed) and each scope the new name renames has one (ADR 0065, amended 2026-10-04).
     */
    import type { RenameLinkStrategy, RenamePlan } from "$lib/storage/rename";

    import RenameImpact from "./RenameImpact.svelte";

    let {
        before,
        after,
        plan,
        pageless,
        testIdPrefix,
        label,
        tick = null,
        status = null,
        problem = null,
        problemId,
        showImpact,
        showNames = true,
        framed = true,
        strategy = $bindable("rewrite"),
        busy = false,
    }: {
        before: string;
        after: string;
        /** What the rename will do as the dialog previews it, or null while it is computed. */
        plan: RenamePlan | null;
        /** The concept has no document, so there is no alias arm (ADR 0064). */
        pageless: boolean;
        /** Test ids are `<prefix>-row`, `-tick`, `-status` and `-error`. */
        testIdPrefix: string;
        /** What the row does, read before the names: shown, or for screen readers only. */
        label: { text: string; visible: boolean };
        /** The row's tick, or null for a rename that always runs. */
        tick?: {
            checked: boolean;
            /** Refused, done, or unticked once a run started: it cannot change. */
            locked: boolean;
            autofocus: boolean;
            ontoggle: (checked: boolean) => void;
        } | null;
        /** "Renamed", "Not started" and the like, or null. */
        status?: string | null;
        /** Why the rename failed or is refused, or null. */
        problem?: string | null;
        /** The id the problem's text carries, so the tick can point to it. */
        problemId: string;
        showImpact: boolean;
        /**
         * Whether the names are shown: a page's plain Rename… has its name field just above, and
         * reads as it always has, with the impact alone.
         */
        showNames?: boolean;
        /** Drawn as a box among other rows; a lone row is not. */
        framed?: boolean;
        strategy?: RenameLinkStrategy;
        busy?: boolean;
    } = $props();
</script>

{#snippet names()}
    {#if label.visible}
        <span class="text-gray-600 dark:text-gray-400">{label.text}</span>
    {:else}
        <span class="sr-only">{label.text}</span>
    {/if}
    <span class="font-mono break-words">"{before}"</span>
    <span aria-hidden="true">→</span><span class="sr-only">to</span>
    <span class="font-mono break-words">"{after}"</span>
    {#if status}
        <span class="ml-1 text-gray-500 dark:text-gray-400" data-testid="{testIdPrefix}-status">{status}</span>
    {/if}
{/snippet}

<div class={["space-y-2", framed && "rounded-lg border border-gray-200 dark:border-gray-700 p-3"]} data-testid="{testIdPrefix}-row" data-before={before} data-after={after}>
    {#if tick}
        <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
            <input
                type="checkbox"
                class="mt-1 shrink-0"
                checked={tick.checked}
                disabled={busy}
                aria-disabled={tick.locked ? "true" : undefined}
                data-autofocus={tick.autofocus ? "" : undefined}
                onclick={(e) => {
                    // Focusable and readable, but not changeable (rule 7): the reason sits beside it.
                    if (tick?.locked) e.preventDefault();
                }}
                onchange={(e) => tick?.ontoggle((e.currentTarget as HTMLInputElement).checked)}
                aria-describedby={problem ? problemId : undefined}
                data-testid="{testIdPrefix}-tick"
            />
            <span class="min-w-0">{@render names()}</span>
        </label>
    {:else if showNames}
        <p class="min-w-0 text-sm text-gray-950 dark:text-gray-100">{@render names()}</p>
    {/if}
    {#if problem}
        <p id={problemId} role="alert" class="text-sm text-red-600" data-testid="{testIdPrefix}-error">{problem}</p>
    {/if}
    {#if showImpact}
        <RenameImpact concept={before} {plan} {pageless} bind:strategy disabled={busy} />
    {/if}
</div>
