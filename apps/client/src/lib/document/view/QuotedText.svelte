<script lang="ts">
    /**
     * A block of another document's text, quoted read-only and drawn as the editor draws it with
     * the caret elsewhere: its lines through `InlineMarkdown`, headings at their size, a quote on
     * its panel, a rule, a table as the editor's grid, and fenced code on its code panel (or drawn
     * by its renderer, a `mermaid` or `math` fence). What the Backlinks panel shows for a
     * reference's body. The reading is `quote-segments.ts`; this is only the markup and the styles,
     * which mirror the editor's value for value (markdown-format.ts, markdown-table.ts).
     *
     * Each line is its own element, read on its own as the editor reads it (a line holding only an
     * image is a picture). Nothing here uses `white-space: pre-wrap`: it would also keep the
     * formatting whitespace inside what a line renders, which moved a picture's overlay off its
     * corner.
     */
    import { type QuoteLine, quoteSegments } from "../quote-segments";
    import InlineMarkdown from "./InlineMarkdown.svelte";
    import QuotedCode from "./QuotedCode.svelte";
    import RenderedSource from "./RenderedSource.svelte";

    let {
        text,
        /** Passed through to `InlineMarkdown`: the concept the host is emphasising, if any. */
        matches,
    }: {
        text: string;
        matches?: (concept: string) => boolean;
    } = $props();

    const segments = $derived(quoteSegments(text));
</script>

{#snippet line(quoted: QuoteLine)}
    {#if quoted.heading}
        <div class="quoted-line quoted-h{quoted.heading}" data-testid="reference-heading" data-level={quoted.heading}>
            <InlineMarkdown text={quoted.text} {matches} />
        </div>
    {:else}
        <div class="quoted-line"><InlineMarkdown text={quoted.text} {matches} /></div>
    {/if}
{/snippet}

<!-- Keyed on position (and kind), as InlineMarkdown keys its parts: a positional split of one
     string has no other identity. -->
{#each segments as segment, i (`${i}-${segment.kind}`)}
    {#if segment.kind === "code"}
        <RenderedSource info={segment.lang} source={segment.code}>
            <QuotedCode lang={segment.lang} code={segment.code} />
        </RenderedSource>
    {:else if segment.kind === "quote"}
        <div class="quoted-quote" data-testid="reference-quote">
            {#each segment.lines as quoted, j (j)}{@render line(quoted)}{/each}
        </div>
    {:else if segment.kind === "rule"}
        <hr class="quoted-rule" data-testid="reference-rule" />
    {:else if segment.kind === "table"}
        <!-- Cells as text, as the editor's grid shows them (markdown-table.ts). -->
        <div class="quoted-table" data-testid="reference-table">
            <table>
                <thead>
                    <tr>
                        {#each segment.header as cell, c (c)}
                            <th style:text-align={segment.align[c] ?? undefined}>{cell}</th>
                        {/each}
                    </tr>
                </thead>
                <tbody>
                    {#each segment.rows as row, r (r)}
                        <tr>
                            {#each row as cell, c (c)}
                                <td style:text-align={segment.align[c] ?? undefined}>{cell}</td>
                            {/each}
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {:else}
        {@render line(segment)}
    {/if}
{/each}

<style>
    /* Headings, value for value as markdown-format.ts styles `.cm-md-h1` to `.cm-md-h6`. */
    .quoted-h1 {
        font-size: 1.6em;
        font-weight: 700;
        line-height: 1.3;
    }
    .quoted-h2 {
        font-size: 1.4em;
        font-weight: 700;
        line-height: 1.3;
    }
    .quoted-h3 {
        font-size: 1.2em;
        font-weight: 700;
    }
    .quoted-h4 {
        font-size: 1.1em;
        font-weight: 700;
    }
    .quoted-h5 {
        font-weight: 700;
    }
    .quoted-h6 {
        font-weight: 700;
        opacity: 0.85;
    }
    /* The quote panel (markdown-format.ts, `.gk-quote-line`): muted text on a translucent shade
       with a 3px left rule, the text 0.9em in from the rule (content-clamp.ts's QUOTE_PAD), 0.4em
       clear above and 0.5em below. */
    .quoted-quote {
        margin: 0.4em 0 0.5em;
        padding: 0.45em 0.8em 0.45em 0.9em;
        border-left: 3px solid var(--gk-border-strong, rgba(127, 127, 127, 0.4));
        border-radius: 0 4px 4px 0;
        background: var(--gk-quote-bg, rgba(127, 127, 127, 0.1));
        color: var(--gk-text-muted, #6b7280);
    }
    /* A thematic break: the editor's 2px rule in the strong border colour, centred on a row. */
    .quoted-rule {
        height: 2px;
        margin: 0.7em 0;
        border: 0;
        background: var(--gk-border-strong, rgba(127, 127, 127, 0.4));
    }
    /* The editor's table grid (markdown-table.ts). The header's shade is the code panel's
       translucent grey: `--gk-surface-2` is the reference card's own background here. */
    .quoted-table {
        margin: 0.2em 0;
        overflow-x: auto;
    }
    table {
        width: 100%;
        border-collapse: collapse;
    }
    th,
    td {
        padding: 2px 8px;
        border: 1px solid var(--gk-border-soft, rgba(0, 0, 0, 0.2));
    }
    th {
        background: var(--gk-code-bg, rgba(127, 127, 127, 0.1));
        font-weight: 700;
    }
</style>
