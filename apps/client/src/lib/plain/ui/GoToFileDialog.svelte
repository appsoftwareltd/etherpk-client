<script lang="ts">
    /**
     * **Go to file**: find a file of the [[Plain Folder]] by typing part of its name, and open it.
     *
     * A graph is searched through its index. A Plain Folder has none, so this looks through the
     * list of its files read in the background (folder-index.ts). The field is a combobox: Up and
     * Down move through the files, Enter opens the one marked, and Mod+Enter opens it beside the
     * file in front.
     */
    import { tick } from 'svelte'

    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import { iconSvg } from '#lib/surface/icons.js'

    import { fileIconOf } from '../file-kind'
    import { matchFiles } from '../file-match'
    import { baseName, dirOf } from '../plain-path'
    import type { LinkPlacement } from '../plain-profile'

    let {
        files,
        truncated = false,
        reading = false,
        onopen,
        onclose,
    }: {
        /** Every file found so far. */
        files: readonly string[]
        /** The list stopped at its limit: some files are not in it. */
        truncated?: boolean
        /** The folder is still being read for the first time. */
        reading?: boolean
        onopen: (path: string, placement: LinkPlacement) => void
        onclose: () => void
    } = $props()

    const SHOWN = 12

    let query = $state('')
    let marked = $state(0)
    let list = $state<HTMLElement>()

    const matches = $derived(matchFiles(files, query, SHOWN))

    function type(text: string): void {
        query = text
        marked = 0
    }

    async function mark(index: number): Promise<void> {
        if (matches.length === 0) return
        marked = (index + matches.length) % matches.length
        await tick()
        list?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    }

    function open(index: number, placement: LinkPlacement): void {
        const match = matches[index]
        if (!match) return
        onopen(match.path, placement)
        onclose()
    }

    function onkeydown(event: KeyboardEvent): void {
        if (event.key === 'ArrowDown') {
            event.preventDefault()
            void mark(marked + 1)
        } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            void mark(marked - 1)
        } else if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            open(marked, event.metaKey || event.ctrlKey ? 'right' : 'tab')
        }
    }
</script>

<Dialog open title="Go to file" testId="go-to-file" placement="top" {onclose}>
    {#snippet body()}
        <div class="gk-field">
            <label class="gk-label" for="go-to-file-query">File name</label>
            <input
                id="go-to-file-query"
                class="gk-input"
                type="text"
                role="combobox"
                aria-expanded={matches.length > 0}
                aria-controls="go-to-file-list"
                aria-activedescendant={matches.length > 0 ? `go-to-file-${marked}` : undefined}
                aria-autocomplete="list"
                autocomplete="off"
                spellcheck="false"
                data-testid="go-to-file-query"
                value={query}
                oninput={(event) => type(event.currentTarget.value)}
                {onkeydown}
            />
            <p class="gk-hint">Enter opens the file. Ctrl+Enter, or ⌘+Enter on a Mac, opens it beside the one in front.</p>
        </div>
        {#if matches.length > 0}
            <ul id="go-to-file-list" class="matches" role="listbox" aria-label="Files" bind:this={list}>
                {#each matches as match, index (match.path)}
                    <!-- svelte-ignore a11y_click_events_have_key_events (the field has the keys: Up, Down and Enter act on the marked row) -->
                    <li
                        id={`go-to-file-${index}`}
                        role="option"
                        class="match"
                        data-own-button-style="a row of the file list"
                        data-testid="go-to-file-row"
                        data-path={match.path}
                        aria-selected={index === marked}
                        onmousemove={() => (marked = index)}
                        onclick={(event) => open(index, event.metaKey || event.ctrlKey ? 'right' : 'tab')}
                    >
                        <span class="icon" aria-hidden="true">
                            <!-- eslint-disable-next-line svelte/no-at-html-tags -- the icon table's own constant markup -->
                            {@html iconSvg(fileIconOf(match.path))}
                        </span>
                        <span class="name">{baseName(match.path)}</span>
                        <span class="where">{dirOf(match.path)}</span>
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="none" role="status" data-testid="go-to-file-none">
                {reading ? 'Reading the folder…' : files.length === 0 ? 'This folder has no files yet.' : `No file matches “${query}”.`}
            </p>
        {/if}
        {#if truncated}
            <p class="gk-hint">This folder has more files than EtherPK lists. Open a file further in from the tree.</p>
        {/if}
    {/snippet}
</Dialog>

<style>
    .matches {
        max-height: 22rem;
        margin: 0;
        padding: 0;
        overflow-y: auto;
        list-style: none;
    }
    .match {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-height: 2rem;
        padding: 0 0.5rem;
        border-radius: 0.25rem;
        font-size: 0.875rem;
        line-height: 1.25rem;
        white-space: nowrap;
        cursor: pointer;
    }
    .match[aria-selected='true'] {
        background: var(--gk-surface-2);
        color: var(--gk-text-strong);
    }
    .icon {
        display: inline-flex;
        flex: none;
        color: var(--gk-text-muted);
    }
    .name {
        flex: none;
        color: var(--gk-text-strong);
    }
    .where {
        overflow: hidden;
        color: var(--gk-text-muted);
        text-overflow: ellipsis;
    }
    .none {
        margin: 0;
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    @media (pointer: coarse) {
        .match {
            min-height: 2.75rem;
        }
    }
</style>
