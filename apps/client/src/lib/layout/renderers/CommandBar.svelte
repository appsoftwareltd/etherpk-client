<script lang="ts">
    /**
     * The **Command Bar** (CONTEXT.md → **Command Bar**): a mobile-only, icon-only row of
     * buttons fixed to the bottom of the viewport, each invoking a [[Command]]. Fed by the
     * `command-bar` Contribution kind; a dumb renderer over the registry.
     *
     * Layout: a scrollable strip of `align:'start'` buttons (the slash trigger + the outliner
     * block-ops) with an {@link HScrollbar} beneath, and a pinned `align:'end'` group (the zoom
     * controls) that never scrolls away. Outliner-only buttons are disabled (greyed) when the
     * caret is not in an outliner block, read reactively from `editorContext`. A button in a
     * **Contextual Group** (the table group) is present only while the caret is on what its
     * Command acts on - it appears beside the slash button inside a table and is absent otherwise.
     *
     * Buttons never steal focus from the editor (tabindex=-1 + preventDefault on pointerdown),
     * so the soft keyboard stays up and the active editor keeps its selection. Riding above the
     * keyboard is handled by {@link MobilePresenter} shrinking the surface to the visual viewport.
     */
    import { editorContext } from '$lib/document'
    import {
        type CommandBarItem,
        listCommandBarItems,
        tryGetActiveCommandRegistry,
        tryGetActiveContributionRegistry,
    } from '$lib/surface'

    import { iconSvg } from '$lib/surface/icons'

    import HScrollbar from './HScrollbar.svelte'

    // The button set is registered once at the composition root before this mounts, so a
    // single read is enough (the Contribution registry is not reactive).
    const items: CommandBarItem[] = (() => {
        const reg = tryGetActiveContributionRegistry()
        return reg ? listCommandBarItems(reg) : []
    })()
    /** A contextual group's buttons exist only while the caret is on their subject. */
    function shown(item: CommandBarItem): boolean {
        if (item.contextualGroup === 'table') return editorContext.table !== null
        if (item.contextualGroup === 'spelling') return editorContext.misspelling
        return true
    }
    const startItems = $derived(items.filter((i) => (i.align ?? 'start') === 'start' && shown(i)))
    const endItems = items.filter((i) => i.align === 'end')

    let stripEl = $state<HTMLDivElement>()

    /**
     * Disabled when the button's gate says its command would do nothing here: outliner-only
     * buttons off a bullet, the task toggle on a heading / in code / in frontmatter, undo and
     * redo on an empty history stack, and every editing button on a locked Protected Document.
     */
    function disabled(item: CommandBarItem): boolean {
        if (item.writableOnly && !editorContext.bodyWritable) return true
        if ((item.taskToggleOnly || item.convertibleOnly) && !editorContext.taskToggleable) return true
        if (item.tableInsertOnly && !editorContext.tableInsertable) return true
        if (item.tableRowOnly && !(editorContext.table && editorContext.table.bodyRow >= 0)) return true
        if (item.tableMultiColumnOnly && !(editorContext.table && editorContext.table.columns > 1)) return true
        if (item.undoOnly && !editorContext.canUndo) return true
        if (item.redoOnly && !editorContext.canRedo) return true
        return !!item.outlinerOnly && !editorContext.inOutlinerBlock
    }

    function run(item: CommandBarItem) {
        const reg = tryGetActiveCommandRegistry()
        if (reg?.has(item.command)) void reg.execute(item.command, item.args)
    }

    // The icon table is shared with the slash menu and the asset action icons (surface/icons.ts).
    const svg = (name: string) => iconSvg(name, { size: 18 })
</script>

<div class="command-bar" data-testid="command-bar">
    <div class="command-bar__row">
        <div class="command-bar__buttons" bind:this={stripEl}>
            {#each startItems as item (item.id)}
                <button
                    class="command-bar__btn"
                    class:slash={item.icon === 'slash'}
                    data-testid="command-bar-button"
                    data-command={item.command}
                    tabindex={-1}
                    disabled={disabled(item)}
                    title={item.label}
                    aria-label={item.label}
                    onpointerdown={(e) => e.preventDefault()}
                    onclick={() => run(item)}
                >
                    <!-- Icon markup from the in-repo icon table, never user or document content. -->
                    <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                    {@html svg(item.icon)}
                </button>
            {/each}
        </div>
        {#if endItems.length}
            <div class="command-bar__zoom">
                {#each endItems as item (item.id)}
                    <button
                        class="command-bar__btn"
                        data-testid="command-bar-button"
                        data-command={item.command}
                        tabindex={-1}
                        disabled={disabled(item)}
                        title={item.label}
                        aria-label={item.label}
                        onpointerdown={(e) => e.preventDefault()}
                        onclick={() => run(item)}
                    >
                        <!-- Icon markup from the in-repo icon table, never user content. -->
                        <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                        {@html svg(item.icon)}
                    </button>
                {/each}
            </div>
        {/if}
    </div>
    <HScrollbar target={stripEl} testid="command-bar-scroll" />
</div>

<style>
    .command-bar {
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-1);
        border-top: 1px solid var(--gk-border-soft);
    }
    .command-bar__row {
        display: flex;
        align-items: center;
        min-width: 0;
    }
    .command-bar__buttons {
        display: flex;
        gap: 0.4rem;
        padding: 0.35rem 0.5rem;
        flex: 1;
        overflow-x: auto;
        min-width: 0;
        /* Hide the native scrollbar — the dedicated HScrollbar replaces it. */
        scrollbar-width: none;
    }
    .command-bar__buttons::-webkit-scrollbar {
        display: none;
    }
    /* The zoom group is pinned to the right and never scrolls away. */
    .command-bar__zoom {
        display: flex;
        gap: 0.4rem;
        flex: none;
        padding: 0.35rem 0.5rem;
        border-left: 1px solid var(--gk-border-soft);
    }
    .command-bar__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        box-sizing: border-box;
        width: 2.4rem;
        height: 2.2rem;
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        /* Buttons must not consume the touch as a scroll/zoom gesture. */
        touch-action: manipulation;
    }
    .command-bar__btn:active:not(:disabled) {
        background: var(--gk-surface-2);
    }
    .command-bar__btn:disabled {
        opacity: 0.35;
        cursor: default;
    }
    /* The slash button leads and is visually primary (it opens the Command Menu). */
    .command-bar__btn.slash {
        font-weight: 600;
        border-color: var(--gk-border-strong, var(--gk-border-soft));
    }
    .command-bar__btn :global(svg) {
        display: block;
    }
</style>
