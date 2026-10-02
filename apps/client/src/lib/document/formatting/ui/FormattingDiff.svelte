<script lang="ts">
    /**
     * One Formatting Issue's fix as a unified diff (ADR 0109): each changed line as a removed row
     * then an added row, an inserted line as an added row, three lines of context around each run
     * of changes, a gutter of the page's line numbers (blank for an inserted line, which the page
     * does not have yet), and the characters nobody can see drawn as stand-ins (`line-diff.ts`).
     * Code font, no wrapping: a long line scrolls sideways inside the diff rather than widening the
     * dialog.
     */
    import { type DiffRow, diffHunks, INVISIBLE_GLYPHS, type Invisible } from "../line-diff";

    let { id, before, after }: { id: string; before: string; after: string } = $props();

    const hunks = $derived(diffHunks(before, after));

    /** What a screen reader says for each stand-in: the glyph alone would be read as an arrow or a dot. */
    const SPOKEN: Record<Invisible, string> = {
        tab: "tab",
        space: "space",
        "special-space": "special space",
        "carriage-return": "carriage return",
    };
    const SPOKEN_KIND: Record<DiffRow["kind"], string> = {
        context: "unchanged",
        removed: "removed",
        added: "added",
    };
    const SIGN: Record<DiffRow["kind"], string> = { context: "", removed: "−", added: "+" };
</script>

<div {id} class="space-y-2" data-testid="formatting-diff">
    {#each hunks as hunk (hunk.first)}
        <div class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-800">
            <p class="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-white/5 px-3 py-1 text-sm text-gray-600 dark:text-gray-300">
                Lines {hunk.first + 1} to {hunk.last + 1}
            </p>
            <table class="w-max min-w-full border-collapse font-mono text-sm [tab-size:4]">
                <tbody>
                    {#each hunk.rows as row (row.key)}
                        <tr
                            data-kind={row.kind}
                            class={row.kind === "removed"
                                ? "bg-red-50 dark:bg-red-950/40"
                                : row.kind === "added"
                                  ? "bg-green-50 dark:bg-green-950/40"
                                  : ""}
                        >
                            <td class="w-px select-none whitespace-nowrap px-2 text-right align-top text-gray-600 dark:text-gray-400">{row.line === null ? "" : row.line + 1}</td>
                            <td
                                class="w-px select-none px-1 align-top {row.kind === 'removed'
                                    ? 'text-red-700 dark:text-red-300'
                                    : 'text-green-700 dark:text-green-300'}"
                                ><span aria-hidden="true">{SIGN[row.kind]}</span><span class="sr-only">{SPOKEN_KIND[row.kind]}</span></td
                            >
                            <!-- One line: the cell keeps its whitespace, so a newline here would draw. -->
                            <td class="whitespace-pre px-2 align-top text-gray-950 dark:text-gray-100" data-testid="formatting-diff-text">{#each row.segments as segment (segment.at)}{#if segment.invisible}<span class="text-gray-600 dark:text-gray-400" aria-hidden="true">{INVISIBLE_GLYPHS[segment.invisible]}</span><span class="sr-only">{SPOKEN[segment.invisible]}</span>{:else}{segment.text}{/if}{/each}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/each}
    <!-- For sighted readers: each row already names its stand-ins to a screen reader. -->
    <p class="text-sm text-gray-500 dark:text-gray-400" aria-hidden="true">
        In the changed lines, {INVISIBLE_GLYPHS.tab} is a tab, {INVISIBLE_GLYPHS.space} is a space in the indentation,
        {INVISIBLE_GLYPHS["special-space"]} is a no-break or other special space, and {INVISIBLE_GLYPHS["carriage-return"]}
        is a carriage return.
    </p>
</div>
