<script lang="ts">
    /**
     * A reply's markdown drawn as DOM from the nodes `render/markdown.ts` reads (ADR 0147): no HTML
     * string is ever written, a wikilink opens its document, a web link opens in a new tab, and an
     * image is a link the person may choose to open, never loaded by the chat.
     */
    import type { BlockNode, InlineNode } from "../render/markdown";
    import { renderTree } from "../render/markdown";

    const { markdown, openDocument }: { markdown: string; openDocument: (name: string) => void } = $props();

    const blocks = $derived(renderTree(markdown));

    let copied = $state<number | null>(null);

    async function copy(text: string, index: number) {
        try {
            await navigator.clipboard.writeText(text);
            copied = index;
            setTimeout(() => {
                if (copied === index) copied = null;
            }, 1500);
        } catch {
            // A refused clipboard leaves the code where the person can select it.
        }
    }
</script>

{#snippet inline(nodes: InlineNode[])}
    {#each nodes as node, i (i)}
        {#if node.kind === "text"}{node.text}{:else if node.kind === "strong"}<strong>{@render inline(node.children)}</strong
            >{:else if node.kind === "em"}<em>{@render inline(node.children)}</em>{:else if node.kind === "del"}<del>{@render inline(node.children)}</del
            >{:else if node.kind === "code"}<code class="ac-code">{node.text}</code>{:else if node.kind === "break"}<br />{:else if node.kind === "wikilink"}<button
                type="button"
                class="ac-wikilink"
                onclick={() => openDocument(node.name)}
                data-testid="agent-chat-wikilink">{node.name}</button
            >{:else if node.kind === "link"}<a class="ac-link" href={node.href} target="_blank" rel="noopener noreferrer">{@render inline(node.children)}</a
            >{:else if node.kind === "image-link"}{#if node.href}<a class="ac-link" href={node.href} target="_blank" rel="noopener noreferrer" data-testid="agent-chat-image-link"
                    >Image: {node.alt || node.href}</a
                >{:else}Image: {node.alt}{/if}{/if}
    {/each}
{/snippet}

{#snippet block(nodes: BlockNode[])}
    {#each nodes as node, i (i)}
        {#if node.kind === "paragraph"}
            <p>{@render inline(node.children)}</p>
        {:else if node.kind === "heading"}
            <p class="ac-heading" role="heading" aria-level={Math.min(6, node.level + 2)}>{@render inline(node.children)}</p>
        {:else if node.kind === "list"}
            {#if node.ordered}
                <ol start={node.start}>
                    {#each node.items as item, j (j)}<li>{@render block(item)}</li>{/each}
                </ol>
            {:else}
                <ul>
                    {#each node.items as item, j (j)}<li>{@render block(item)}</li>{/each}
                </ul>
            {/if}
        {:else if node.kind === "codeblock"}
            <div class="ac-pre">
                <button type="button" class="gk-button gk-button--small gk-button--raised ac-copy" onclick={() => copy(node.text, i)} aria-label="Copy code">{copied === i ? "Copied" : "Copy"}</button>
                <pre><code>{node.text}</code></pre>
            </div>
        {:else if node.kind === "quote"}
            <blockquote>{@render block(node.children)}</blockquote>
        {:else if node.kind === "table"}
            <div class="ac-table">
                <table>
                    <thead><tr>{#each node.head as cell, j (j)}<th>{@render inline(cell)}</th>{/each}</tr></thead>
                    <tbody>
                        {#each node.rows as row, j (j)}<tr>{#each row as cell, k (k)}<td>{@render inline(cell)}</td>{/each}</tr>{/each}
                    </tbody>
                </table>
            </div>
        {:else if node.kind === "rule"}
            <hr />
        {/if}
    {/each}
{/snippet}

<div class="ac-markdown">{@render block(blocks)}</div>

<style>
    .ac-markdown {
        font-size: 0.9375rem;
        line-height: 1.55;
        color: var(--gk-text-default);
        overflow-wrap: anywhere;
    }
    .ac-markdown :global(p) {
        margin: 0 0 0.6em;
    }
    .ac-markdown :global(p:last-child) {
        margin-bottom: 0;
    }
    .ac-heading {
        font-weight: 600;
        color: var(--gk-text-strong);
    }
    .ac-markdown :global(ul),
    .ac-markdown :global(ol) {
        margin: 0 0 0.6em;
        padding-left: 1.4em;
    }
    .ac-markdown :global(ul) {
        list-style: disc;
    }
    .ac-markdown :global(ol) {
        list-style: decimal;
    }
    .ac-markdown :global(blockquote) {
        margin: 0 0 0.6em;
        padding-left: 0.75em;
        border-left: 3px solid var(--gk-border-strong);
        color: var(--gk-text-muted);
    }
    .ac-markdown :global(hr) {
        border: 0;
        border-top: 1px solid var(--gk-border-soft);
        margin: 0.8em 0;
    }
    .ac-code {
        font-family: var(--gk-mono);
        font-size: max(0.875rem, 0.9em);
        background: var(--gk-surface-2);
        border-radius: 0.25rem;
        padding: 0 0.25em;
    }
    .ac-pre {
        position: relative;
        margin: 0 0 0.6em;
    }
    .ac-pre pre {
        margin: 0;
        padding: 0.6em 0.75em;
        overflow-x: auto;
        background: var(--gk-surface-2);
        border-radius: 0.5rem;
        font-family: var(--gk-mono);
        font-size: 0.875rem;
        line-height: 1.5;
    }
    /*
     * EtherPK's small raised button (`gk-button--small gk-button--raised`) in the code block's
     * corner: a long line of code runs under it, so it has a solid face.
     */
    .ac-copy {
        position: absolute;
        top: 0.3rem;
        right: 0.3rem;
    }
    .ac-wikilink,
    .ac-link {
        color: var(--gk-accent);
        text-decoration: underline;
        text-underline-offset: 2px;
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        cursor: pointer;
    }
    .ac-wikilink:hover,
    .ac-link:hover {
        color: var(--gk-accent-hover);
    }
    .ac-table {
        overflow-x: auto;
        margin: 0 0 0.6em;
    }
    .ac-table table {
        border-collapse: collapse;
        font-size: 0.875rem;
    }
    .ac-table th,
    .ac-table td {
        border: 1px solid var(--gk-border-soft);
        padding: 0.25em 0.5em;
        text-align: left;
    }
</style>
