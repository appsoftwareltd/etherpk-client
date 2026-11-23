<script lang="ts">
    /**
     * The Outline of the file in front: its headings, in order, each a way to that line. The right
     * Sidebar's resident in a [[Plain Folder]], where a graph has Backlinks.
     *
     * It follows the text as it is typed. A file with no headings, or one that is not markdown,
     * says so in a sentence where the list would be.
     */
    import type { ViewRef } from '#lib/layout/index.js'
    import { revealDocumentLine } from '#lib/document/reveal.js'

    import { fileKindOf } from '../file-kind'
    import { type OutlineHeading, watchHeadings } from '../outline'
    import { baseName } from '../plain-path'
    import { plainSession } from '../plain-session.svelte'

    // Every View is handed its ViewRef; the Outline follows the file in front, not a target.
    let { view: _view }: { view: ViewRef } = $props()

    const session = $derived(plainSession.current)
    const path = $derived(session?.activePath ?? null)
    const markdown = $derived(path !== null && fileKindOf(path) === 'markdown')

    let headings = $state.raw<OutlineHeading[]>([])

    // The file's text lives in the store, outside Svelte: followed for the file in front.
    $effect(() => {
        const store = session?.store
        const at = path
        if (!store || at === null || !markdown) {
            headings = []
            return
        }
        return watchHeadings(store, at, (read) => (headings = read))
    })

    const shallowest = $derived(Math.min(...headings.map((heading) => heading.level)))

    async function go(heading: OutlineHeading): Promise<void> {
        if (path === null) return
        await session?.openFile(path)
        revealDocumentLine(path, heading.line)
    }
</script>

<div class="outline" data-testid="outline-view">
    <div class="heading"><span class="label" id="outline-label">Outline</span></div>
    {#if path === null}
        <p class="note">Open a file to see its headings here.</p>
    {:else if !markdown}
        <p class="note" data-testid="outline-none">{baseName(path)} is not a markdown file, so it has no headings to list.</p>
    {:else if headings.length === 0}
        <p class="note" data-testid="outline-none">{baseName(path)} has no headings yet. A line that starts with # is one.</p>
    {:else}
        <ul class="rows" aria-labelledby="outline-label">
            {#each headings as heading (heading.line)}
                <li>
                    <button type="button" class="row" data-own-button-style="a row of the outline" data-testid="outline-row" style:--depth={heading.level - shallowest} onclick={() => go(heading)}>
                        {heading.text}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
</div>

<style>
    /* No background of its own: a pane's view is drawn on the pane's surface, which is its tab's. */
    .outline {
        height: 100%;
        overflow: auto;
        padding: 0.5rem 0.5rem 1rem;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .heading {
        display: flex;
        align-items: center;
        height: 1.75rem;
        padding-left: 0.375rem;
        margin-bottom: 0.25rem;
    }
    .label {
        color: var(--gk-text-muted);
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .note {
        margin: 0;
        padding: 0.25rem 0.375rem;
        color: var(--gk-text-muted);
    }
    .rows {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .row {
        display: block;
        width: 100%;
        min-height: 1.75rem;
        padding: 0.25rem 0.375rem 0.25rem calc(0.375rem + var(--depth) * 1rem);
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .row:hover {
        background: var(--gk-menu-hover);
        color: var(--gk-text-strong);
    }
    .row:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    @media (pointer: coarse) {
        .row {
            min-height: 2.75rem;
        }
    }
</style>
