<script lang="ts">
    /**
     * A Document Version's changes against the version before it, as a unified diff in the manner
     * of `git diff` (ADR 0184): removed lines then added lines, three unchanged lines either side,
     * the unchanged runs between left out with their length, and both versions' line numbers in the
     * gutter. Lines wrap, since a document's lines are paragraphs. The sign column says "added" or
     * "removed" to a screen reader, so colour is never the only cue.
     */
    import { diffVersions, type VersionDiffRow } from "#lib/sync/version-history/version-diff.js";
    import { changeSummary } from "#lib/sync/version-history/version-history-copy.js";

    const { before, after, beforeMoment }: { before: string; after: string; beforeMoment: string } = $props();

    const diff = $derived(diffVersions(before, after));

    const SIGN: Record<VersionDiffRow["kind"], string> = { context: "", removed: "−", added: "+" };
    const SPOKEN: Record<VersionDiffRow["kind"], string> = { context: "", removed: "removed", added: "added" };
    const ROW: Record<VersionDiffRow["kind"], string> = {
        context: "",
        removed: "bg-red-50 dark:bg-red-950/40",
        added: "bg-green-50 dark:bg-green-950/40",
    };
    const SIGN_INK: Record<VersionDiffRow["kind"], string> = {
        context: "",
        removed: "text-red-700 dark:text-red-300",
        added: "text-green-700 dark:text-green-300",
    };

    function unchanged(n: number): string {
        return `${n} unchanged ${n === 1 ? "line" : "lines"}`;
    }
</script>

{#snippet skipped(n: number)}
    <tr>
        <td colspan="4" class="bg-(--gk-surface-1) px-3 py-1 font-sans text-sm text-(--gk-text-muted)" data-testid="version-diff-skipped">{unchanged(n)}</td>
    </tr>
{/snippet}

<p class="border-b border-(--gk-border-soft) px-4 py-2 text-sm text-(--gk-text-muted)" data-testid="version-diff-summary">
    {changeSummary(diff, beforeMoment)}
</p>
{#if diff.hunks.length > 0}
    <!-- The diff scrolls, and a keyboard has to reach it to scroll it. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="min-h-0 flex-1 overflow-auto" tabindex="0" aria-label="Changes in this version" data-testid="version-history-diff">
        <table class="w-full border-collapse font-mono text-sm [tab-size:4]">
            <tbody>
                {#each diff.hunks as hunk (hunk.rows[0].key)}
                    {#if hunk.skippedBefore > 0}{@render skipped(hunk.skippedBefore)}{/if}
                    {#each hunk.rows as row (row.key)}
                        <tr class={ROW[row.kind]} data-kind={row.kind}>
                            <td class="w-px select-none whitespace-nowrap py-px pl-3 pr-1 text-right align-top text-neutral-600 tabular-nums dark:text-neutral-400">{row.oldLine ?? ""}</td>
                            <td class="w-px select-none whitespace-nowrap px-1 py-px text-right align-top text-neutral-600 tabular-nums dark:text-neutral-400">{row.newLine ?? ""}</td>
                            <td class={["w-px select-none px-1 py-px align-top", SIGN_INK[row.kind]]}
                                ><span aria-hidden="true">{SIGN[row.kind]}</span>{#if row.kind !== "context"}<span class="sr-only">{SPOKEN[row.kind]}</span>{/if}</td
                            >
                            <!-- One line: the cell keeps its whitespace, so a newline here would draw. -->
                            <td class="whitespace-pre-wrap py-px pr-3 pl-1 align-top text-(--gk-text-default) [overflow-wrap:anywhere]" data-testid="version-diff-text">{row.text}</td>
                        </tr>
                    {/each}
                {/each}
                {#if diff.skippedAfter > 0}{@render skipped(diff.skippedAfter)}{/if}
            </tbody>
        </table>
    </div>
{/if}
