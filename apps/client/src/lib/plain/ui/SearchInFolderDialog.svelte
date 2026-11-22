<script lang="ts">
    /**
     * **Search in folder**: find text in the files of a [[Plain Folder]], with the matches shown
     * as they are found.
     *
     * There is no index, so each search reads the folder's text files (folder-search.ts). Typing
     * again stops the search under way and starts the next after a short pause. What was found for
     * the last query stays on screen, marked as out of date, until the new matches begin to arrive.
     */
    import { onDestroy } from 'svelte'

    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import { type SearchMatch, searchFolder } from '../folder-search'
    import type { FolderTreeAdapter } from '../folder-tree-adapter'

    let {
        tree,
        files,
        onopen,
        onclose,
    }: {
        tree: Pick<FolderTreeAdapter, 'read'>
        /** Every file found so far (folder-index.ts). */
        files: readonly string[]
        onopen: (path: string, line: number) => void
        onclose: () => void
    } = $props()

    let query = $state('')
    let matches = $state.raw<SearchMatch[]>([])
    /** What `matches` answers: while it differs from the box, the list is the last query's. */
    let answered = $state('')
    let phase = $state<'idle' | 'searching' | 'done'>('idle')
    let truncated = $state(false)
    let filesRead = $state(0)

    let running: AbortController | undefined
    let pause: ReturnType<typeof setTimeout> | undefined

    function type(text: string): void {
        query = text
        running?.abort()
        clearTimeout(pause)
        if (text.trim() === '') {
            matches = []
            answered = ''
            phase = 'idle'
            return
        }
        phase = 'searching'
        pause = setTimeout(() => void run(text), 200)
    }

    async function run(text: string): Promise<void> {
        const control = new AbortController()
        running = control
        let found: SearchMatch[] = []
        let first = true
        const outcome = await searchFolder(tree, files, text, {
            signal: control.signal,
            onMatch(match) {
                found = [...found, match]
                // The last query's list gives way at the first new match, not before: no blank in between.
                if (first || found.length % 20 === 0) {
                    matches = found
                    answered = text
                    first = false
                }
            },
        })
        if (control.signal.aborted || outcome.aborted) return
        matches = found
        answered = text
        truncated = outcome.truncated
        filesRead = outcome.filesRead
        phase = 'done'
    }

    onDestroy(() => {
        running?.abort()
        clearTimeout(pause)
    })

    /** The matches grouped by file, in the order the files were read. */
    const groups = $derived.by(() => {
        const out: Array<{ path: string; matches: SearchMatch[] }> = []
        for (const match of matches) {
            const last = out.at(-1)
            if (last?.path === match.path) last.matches.push(match)
            else out.push({ path: match.path, matches: [match] })
        }
        return out
    })
    const stale = $derived(answered !== query)

    function go(match: SearchMatch): void {
        onopen(match.path, match.line)
        onclose()
    }
</script>

<Dialog open title="Search in folder" testId="search-in-folder" size="lg" placement="top" {onclose}>
    {#snippet body()}
        <div class="gk-field">
            <label class="gk-label" for="search-in-folder-query">Text to find</label>
            <input
                id="search-in-folder-query"
                class="gk-input"
                type="search"
                autocomplete="off"
                spellcheck="false"
                data-testid="search-in-folder-query"
                value={query}
                oninput={(event) => type(event.currentTarget.value)}
            />
            <p class="gk-hint">Looks in the folder’s text files, ignoring case.</p>
        </div>
        <p class="status" role="status" data-testid="search-in-folder-status">
            {#if phase === 'searching'}
                Searching…
            {:else if phase === 'done' && matches.length === 0}
                Nothing in {filesRead} {filesRead === 1 ? 'file' : 'files'} matches “{query}”.
            {:else if phase === 'done'}
                {truncated ? 'The first ' : ''}{matches.length} {matches.length === 1 ? 'line' : 'lines'} in {groups.length} {groups.length === 1 ? 'file' : 'files'}{truncated ? '. Type more to narrow it.' : '.'}
            {/if}
        </p>
        {#if groups.length > 0}
            <div class="results" class:stale data-testid="search-in-folder-results">
                {#each groups as group (group.path)}
                    <section aria-label={group.path}>
                        <h3 class="file">{group.path}</h3>
                        <ul>
                            {#each group.matches as match (match.line)}
                                <li>
                                    <button type="button" class="match" data-own-button-style="a row of search results" data-testid="search-in-folder-row" onclick={() => go(match)}>
                                        <span class="line">{match.line + 1}</span>
                                        <span class="text">{match.text.slice(0, match.from)}<mark>{match.text.slice(match.from, match.to)}</mark>{match.text.slice(match.to)}</span>
                                    </button>
                                </li>
                            {/each}
                        </ul>
                    </section>
                {/each}
            </div>
        {/if}
    {/snippet}
</Dialog>

<style>
    .status {
        min-height: 1.25rem;
        margin: 0 0 0.5rem;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .results {
        max-height: 26rem;
        overflow-y: auto;
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    /* The last query's matches, still shown while the new ones are found: they recede by colour. */
    .results.stale .text,
    .results.stale .file {
        color: var(--gk-text-subtle);
    }
    .file {
        margin: 0.75rem 0 0.25rem;
        color: var(--gk-text-strong);
        font-size: 0.875rem;
        font-weight: 600;
    }
    section:first-child .file {
        margin-top: 0;
    }
    ul {
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .match {
        display: flex;
        gap: 0.75rem;
        width: 100%;
        min-height: 1.75rem;
        padding: 0.25rem 0.5rem;
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: var(--gk-text-default);
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .match:hover {
        background: var(--gk-menu-hover);
    }
    .match:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    .line {
        flex: none;
        min-width: 2.5rem;
        color: var(--gk-text-muted);
        font-variant-numeric: tabular-nums;
        text-align: right;
    }
    .text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    mark {
        border-radius: 0.125rem;
        background: var(--gk-find-match);
        color: inherit;
    }
    @media (pointer: coarse) {
        .match {
            min-height: 2.75rem;
            align-items: center;
        }
    }
</style>
