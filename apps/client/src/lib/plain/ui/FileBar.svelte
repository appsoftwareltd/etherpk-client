<script lang="ts">
    /**
     * The bar above a text file of a [[Plain Folder]]: where the file is, the headings the caret is
     * under, and the editor it is open in (ADR 0204).
     *
     * Each part of the path is a way there: a directory shows it in Files, the file's name and a
     * heading show that line. The headings are a markdown file's, in either editor, and follow the
     * caret. The button at the end names the editor and opens the menu of editors. A file with one
     * editor has no button.
     *
     * Too narrow for all of it (a phone, a split pane), the bar keeps the file's name and the
     * nearest heading, each cut short with an ellipsis, so nothing scrolls sideways.
     */
    import { createSubscriber } from 'svelte/reactivity'

    import { revealDocumentLine } from '#lib/document/reveal.js'
    import { openContextMenu } from '#lib/surface/context-menu-store.js'
    import { withChord } from '#lib/surface/control-help.js'
    import { iconSvg } from '#lib/surface/icons.js'

    import { FILE_EDITOR_NAMES } from '../file-editors'
    import { fileKindOf } from '../file-kind'
    import { ancestorsOf } from '../file-tree'
    import { type OutlineHeading, headingTrail, watchHeadings } from '../outline'
    import { baseName } from '../plain-path'
    import { plainSession } from '../plain-session.svelte'

    let {
        path,
        line,
        switchChord = null,
    }: {
        path: string
        /** The caret's line, 0-based from the top of the file. */
        line: number
        /** The key that switches the editor, for the button's tooltip. */
        switchChord?: string | null
    } = $props()

    const session = $derived(plainSession.current)
    const directories = $derived(ancestorsOf(path))
    const markdown = $derived(fileKindOf(path) === 'markdown')

    const editors = $derived(session?.editors)
    const watchEditors = $derived.by(() => {
        const followed = editors
        return createSubscriber((update) => followed?.subscribe(update))
    })
    const editor = $derived.by(() => {
        watchEditors()
        return editors?.editorOf(path) ?? 'text'
    })
    const hasChoice = $derived((editors?.choices(path).length ?? 1) > 1)

    let headings = $state.raw<OutlineHeading[]>([])
    $effect(() => {
        const store = session?.store
        if (!store || !markdown) {
            headings = []
            return
        }
        return watchHeadings(store, path, (read) => (headings = read))
    })
    const trail = $derived(headingTrail(headings, line))

    async function goTo(at: number): Promise<void> {
        await session?.openFile(path)
        revealDocumentLine(path, at)
    }

    /** The menu hangs from the button, which is at the pane's right edge: the menu is kept on screen. */
    function openMenu(event: MouseEvent & { currentTarget: HTMLElement }): void {
        const box = event.currentTarget.getBoundingClientRect()
        openContextMenu({ kind: 'plain-editor', path }, box.left, box.bottom + 2)
    }
</script>

{#snippet chevron()}
    <!-- In-repo constant markup from the icon table. -->
    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
    <span class="chevron" aria-hidden="true">{@html iconSvg('tree-closed', { size: 14 })}</span>
{/snippet}

<div class="file-bar" data-testid="file-bar">
    <div class="row">
        <nav class="trail" aria-label="Breadcrumb">
            <ol>
                {#each directories as directory (directory)}
                    <li class="directory">
                        <button type="button" data-own-button-style="a crumb of the file bar" data-testid="file-crumb" data-tooltip="Show in Files" aria-description="Show in Files" onclick={() => session?.showInTree(directory)}>{baseName(directory)}</button>
                        {@render chevron()}
                    </li>
                {/each}
                <li class="file">
                    <button type="button" data-own-button-style="a crumb of the file bar" data-testid="file-crumb" aria-current={trail.length === 0 ? 'location' : undefined} onclick={() => void goTo(0)}>{baseName(path)}</button>
                </li>
                {#each trail as heading, index (heading.line)}
                    <li class="heading">
                        {@render chevron()}
                        <button
                            type="button"
                            data-own-button-style="a crumb of the file bar"
                            data-testid="file-crumb"
                            aria-current={index === trail.length - 1 ? 'location' : undefined}
                            onclick={() => void goTo(heading.line)}>{heading.text}</button
                        >
                    </li>
                {/each}
            </ol>
        </nav>
        {#if hasChoice}
            <button
                type="button"
                class="gk-button gk-button--quiet gk-button--small"
                aria-haspopup="menu"
                aria-label={`Editor: ${FILE_EDITOR_NAMES[editor]}`}
                data-testid="file-editor"
                data-editor={editor}
                data-tooltip={withChord('Change editor', switchChord)}
                aria-description={withChord('Change editor', switchChord)}
                onclick={openMenu}
            >
                {FILE_EDITOR_NAMES[editor]}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -- in-repo constant markup from the icon table -->
                <span class="chevron down" aria-hidden="true">{@html iconSvg('tree-closed', { size: 14 })}</span>
            </button>
        {/if}
    </div>
</div>

<style>
    /* No background of its own: it is part of the file, on the editor's surface. */
    .file-bar {
        flex: none;
        container-type: inline-size;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-0);
        color: var(--gk-text-muted);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-height: 2.25rem;
        padding: 0.125rem 0.5rem 0.125rem 0.75rem;
    }
    .trail {
        flex: 1 1 0;
        min-width: 0;
    }
    ol {
        display: flex;
        align-items: center;
        min-width: 0;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    li {
        display: flex;
        flex: 0 2 auto;
        align-items: center;
        min-width: 0;
    }
    /* The file's own name is the last to be cut short. */
    li.file {
        flex-shrink: 1;
    }
    li button {
        overflow: hidden;
        min-width: 0;
        padding: 0.125rem 0.25rem;
        border: 0;
        border-radius: 0.25rem;
        background: transparent;
        color: inherit;
        font: inherit;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }
    li button:hover {
        background: var(--gk-menu-hover);
        color: var(--gk-text-strong);
    }
    li button:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: -2px;
    }
    li button[aria-current] {
        color: var(--gk-text-strong);
    }
    .chevron {
        display: grid;
        flex: none;
        place-items: center;
        color: var(--gk-text-subtle);
    }
    .chevron.down {
        rotate: 90deg;
        color: inherit;
    }
    /* Narrow: the file and the heading the caret is under, and the button. */
    @container (max-width: 36rem) {
        li.directory,
        li.heading:not(:last-child) {
            display: none;
        }
    }
    @media (pointer: coarse) {
        li button {
            min-height: 2.75rem;
        }
    }
</style>
