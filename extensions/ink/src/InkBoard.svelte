<script lang="ts">
    /**
     * The live board with its palette: the tools, the colours and widths, the paper, and the view's
     * zoom. The canvas and its pointer handling are `InkBoardCanvas` (board.ts); this component holds
     * what the person chose and hands each change to the drawing's widget (`InkBlock.svelte`), which
     * writes it to the fence.
     *
     * Keys on the board: H hand, P pen, M highlighter (marker), E eraser, L lasso, Delete or Backspace removes the
     * selection, Escape lets it go (or, with nothing selected, says the person is done), Space held
     * pans. Mod+Z and Mod+Y are left to the Client, as are the Undo and Redo buttons: the editor's
     * history in the document, and in a tab or the window the board's own changes made there.
     */
    import type { ExtensionIcons, ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'
    import { untrack } from 'svelte'

    import { InkBoardCanvas } from './board'
    import type { Camera } from './camera'
    import { HIGHLIGHTER_COLOURS, type InkDrawing, type InkPaper, type InkStroke, type InkTool, PAPERS, PEN_COLOURS, WIDTHS } from './format'
    import { type BoardTool, boardKey } from './input'
    import { type BrushChoices, rememberedBrushes } from './brushes'

    let {
        drawing,
        writable,
        icons,
        storage,
        status = '',
        focusOnMount = false,
        addStroke,
        erase,
        move,
        setPaper,
        undo,
        redo,
        done,
    }: {
        drawing: InkDrawing
        writable: boolean
        icons: ExtensionIcons
        storage: ExtensionStorage | null
        /** A short note about a change that was refused, shown over the canvas. */
        status?: string
        focusOnMount?: boolean
        addStroke(stroke: InkStroke): boolean
        erase(ids: ReadonlySet<string>): boolean
        move(ids: ReadonlySet<string>, dx: number, dy: number): boolean
        setPaper(paper: InkPaper): boolean
        /** Undo and Redo, where the Client offers them. */
        undo?: () => void
        redo?: () => void
        /** Escape with nothing selected: the person is done with the board. */
        done?: () => void
    } = $props()

    const TOOLS: { tool: BoardTool; label: string; key: string; icon: string }[] = [
        { tool: 'hand', label: 'Hand', key: 'H', icon: 'hand' },
        { tool: 'pen', label: 'Pen', key: 'P', icon: 'pen' },
        { tool: 'highlighter', label: 'Highlighter', key: 'M', icon: 'highlight' },
        { tool: 'eraser', label: 'Eraser', key: 'E', icon: 'eraser' },
        { tool: 'lasso', label: 'Lasso select', key: 'L', icon: 'lasso' },
    ]
    const WIDTH_NAMES = ['Thin', 'Medium', 'Thick'] as const
    const PAPER_NAMES: Record<InkPaper, string> = { plain: 'Plain', dots: 'Dots', lines: 'Lines' }

    let tool = $state<BoardTool>('pen')
    /** The drawing tool the colours and widths are for: the one chosen, or the last one chosen. */
    let inkTool = $state<InkTool>('pen')
    // Read once: the choices are this board's from here on, written back as they change.
    let brushes = $state<BrushChoices>(untrack(() => rememberedBrushes.read(storage)))
    let zoom = $state(1)
    let selected = $state(0)
    let board = $state.raw<InkBoardCanvas | null>(null)
    let canvas: HTMLCanvasElement | null = null

    const colours = $derived(inkTool === 'pen' ? PEN_COLOURS : HIGHLIGHTER_COLOURS)
    const brush = $derived(brushes[inkTool])

    function chooseTool(next: BoardTool) {
        tool = next
        if (next === 'pen' || next === 'highlighter') inkTool = next
        if (next !== 'lasso') board?.clearSelection()
    }

    function chooseColour(hex: string) {
        brushes[inkTool].colour = hex
        if (tool !== inkTool) tool = inkTool
        rememberedBrushes.write(storage, brushes)
    }

    function chooseWidth(index: number) {
        brushes[inkTool].width = index
        if (tool !== inkTool) tool = inkTool
        rememberedBrushes.write(storage, brushes)
    }

    function attachBoard(element: HTMLCanvasElement) {
        // Made once for the canvas: nothing read while it is made may make it again.
        return untrack(() => mountBoard(element))
    }

    function mountBoard(element: HTMLCanvasElement) {
        canvas = element
        const created = new InkBoardCanvas(element, {
            writable: () => writable,
            tool: () => tool,
            brush: (which) => ({ colour: brushes[which].colour, size: WIDTHS[which][brushes[which].width] }),
            addStroke: (stroke) => addStroke(stroke),
            erase: (ids) => erase(ids),
            move: (ids, dx, dy) => move(ids, dx, dy),
            selectionChanged: (count) => (selected = count),
            cameraChanged: (camera: Camera) => (zoom = camera.zoom),
        })
        board = created
        if (focusOnMount) element.focus({ preventScroll: true })
        return () => {
            created.destroy()
            board = null
            canvas = null
        }
    }

    // Draw the body as it now is: every change, this board's own included, comes back this way.
    $effect(() => {
        board?.setDrawing(drawing)
    })

    /** Give the board the keyboard. */
    export function focus() {
        canvas?.focus({ preventScroll: true })
    }

    /** Write what is being drawn now, before the Client acts on the fence. */
    export function flush() {
        board?.flush()
    }

    function onkeydown(event: KeyboardEvent) {
        const target = event.target as HTMLElement
        if (target.tagName === 'SELECT') return
        const onCanvas = target.tagName === 'CANVAS'
        if (event.key === ' ' && onCanvas) {
            event.preventDefault()
            board?.setSpaceHeld(true)
            return
        }
        const action = boardKey(event, writable)
        if (action === null) return
        if (action === 'delete-selection') {
            if (!onCanvas || !board?.deleteSelection()) return
        } else if (action === 'clear-selection') {
            if (!board?.clearSelection()) {
                if (!done) return
                done()
            }
        } else chooseTool(action.tool)
        event.preventDefault()
        event.stopPropagation()
    }

    function onkeyup(event: KeyboardEvent) {
        if (event.key === ' ') board?.setSpaceHeld(false)
    }
</script>

<!-- The keys are the board's own while the keyboard is in it: its canvas or its palette. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gk-ink-board" data-testid="ink-board" {onkeydown} {onkeyup}>
    <div class="gk-ink-palette" role="group" aria-label="Ink tools" data-testid="ink-palette">
        {#if writable}
            <div class="gk-ink-group">
                {#each TOOLS as item (item.tool)}
                    <button
                        type="button"
                        class="gk-icon-button"
                        aria-pressed={tool === item.tool}
                        aria-label={item.label}
                        aria-keyshortcuts={item.key}
                        title={`${item.label} (${item.key})`}
                        data-testid={`ink-tool-${item.tool}`}
                        onclick={() => chooseTool(item.tool)}
                    >
                        {@render icon(item.icon)}
                    </button>
                {/each}
            </div>
            <div class="gk-ink-group">
                <button type="button" class="gk-icon-button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!undo} data-testid="ink-undo" onclick={() => undo?.()}>
                    {@render icon('undo')}
                </button>
                <button type="button" class="gk-icon-button" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!redo} data-testid="ink-redo" onclick={() => redo?.()}>
                    {@render icon('redo')}
                </button>
            </div>
            <div class="gk-ink-group" role="group" aria-label={inkTool === 'pen' ? 'Pen colour' : 'Highlighter colour'}>
                {#each colours as colour (colour.hex)}
                    <button
                        type="button"
                        class="gk-icon-button gk-ink-swatch"
                        aria-pressed={brush.colour === colour.hex}
                        aria-label={colour.name}
                        title={colour.name}
                        data-testid="ink-colour"
                        onclick={() => chooseColour(colour.hex)}
                    >
                        <span class="gk-ink-swatch-dot" style:background={colour.hex}></span>
                    </button>
                {/each}
            </div>
            <div class="gk-ink-group" role="group" aria-label={inkTool === 'pen' ? 'Pen width' : 'Highlighter width'}>
                {#each WIDTH_NAMES as name, index (name)}
                    <button
                        type="button"
                        class="gk-icon-button"
                        aria-pressed={brush.width === index}
                        aria-label={name}
                        title={name}
                        data-testid="ink-width"
                        onclick={() => chooseWidth(index)}
                    >
                        <span class="gk-ink-width-dot" style:--gk-ink-dot={`${4 + index * 4}px`}></span>
                    </button>
                {/each}
            </div>
            <label class="gk-ink-paper">
                <span>Paper</span>
                <select class="gk-select" value={drawing.header.paper} data-testid="ink-paper" onchange={(event) => setPaper(event.currentTarget.value as InkPaper)}>
                    {#each PAPERS as paper (paper)}
                        <option value={paper}>{PAPER_NAMES[paper]}</option>
                    {/each}
                </select>
            </label>
        {/if}
        <div class="gk-ink-group gk-ink-view">
            {#if writable && selected > 0}
                <button type="button" class="gk-button gk-button--danger gk-button--small" data-testid="ink-delete-selection" onclick={() => board?.deleteSelection()}>
                    Delete {selected === 1 ? 'stroke' : `${selected} strokes`}
                </button>
            {/if}
            <button type="button" class="gk-icon-button" aria-label="Zoom out" title="Zoom out" onclick={() => board?.zoomBy(1 / 1.25)}>
                {@render icon('zoom-out')}
            </button>
            <span class="gk-ink-zoom" data-testid="ink-zoom">{Math.round(zoom * 100)}%</span>
            <button type="button" class="gk-icon-button" aria-label="Zoom in" title="Zoom in" onclick={() => board?.zoomBy(1.25)}>
                {@render icon('zoom-in')}
            </button>
            <button type="button" class="gk-icon-button" aria-label="Fit the drawing" title="Fit the drawing" data-testid="ink-fit" onclick={() => board?.fit()}>
                {@render icon('fit')}
            </button>
        </div>
    </div>
    <div class="gk-ink-surface">
        <canvas
            class={['gk-ink-canvas', tool === 'eraser' && 'gk-ink-canvas--erase', tool === 'hand' && 'gk-ink-canvas--hand']}
            tabindex="0"
            aria-label={writable ? 'Drawing. H hand, P pen, M highlighter, E eraser, L lasso select.' : 'Drawing. Drag to move around, pinch or Ctrl and scroll to zoom.'}
            data-testid="ink-canvas"
            {@attach attachBoard}
        ></canvas>
        <!-- Always in the page, so a note that appears in it is read out. -->
        <p class={['gk-ink-status', !status && 'gk-ink-status--empty']} role="status" data-testid="ink-status">{status}</p>
    </div>
</div>

{#snippet icon(name: string)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- markup the Client made (context.icons), from its icon table or this extension's manifest, never content -->
    {@html icons.svg(name, { size: 16 })}
{/snippet}
