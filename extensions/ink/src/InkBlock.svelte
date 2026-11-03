<script lang="ts">
    /**
     * An Ink drawing's widget, as the Client draws it over the fence (`widget.svelte.ts`):
     *
     * - **in the document**, the drawing's picture, until it is pressed (or Enter or Space on it):
     *   on a desktop-like layout the board then opens in place, in the editor frame the Client
     *   draws (`setEditing`); on a phone the board opens over the whole window;
     * - **while edited in the document, in a tab or in the window**, the live board
     *   (`InkBoard.svelte`), or, where the document cannot be written, the board with only its view
     *   controls, to pan and zoom round the drawing;
     * - for a drawing **made by a newer version** of EtherPK, a note and Edit as text, and nothing
     *   that could write it in an older shape.
     *
     * Every change is one fence edit (`edits.ts`), which the editor's undo takes back; the board
     * draws what the body holds when it comes back.
     */
    import type { FenceContext, FenceEdit } from '@appsoftwareltd/etherpk-extension-api'

    import { planAddStroke, planErase, planHeader, planMove } from './edits'
    import { inkAlt, newDrawingId, readInk } from './format'
    import InkBoard from './InkBoard.svelte'
    import { svgElement } from './picture'
    import { fitPicture } from './sizes'
    import type { InkServices } from './services'
    import { inkPicture } from './svg'
    import './ink.css'


    let { context, services }: { context: FenceContext; services: InkServices } = $props()

    /** What a refused change says, over the board. */
    const REFUSED = "That change wasn't saved: the drawing changed, or the document can't be written now. Try again."

    const drawing = $derived(readInk(context.body))
    const showBoard = $derived(!drawing.newer && (context.presentation !== 'inline' || context.editing === true))
    /** A press on the picture does something: opens the board here, or over the window. */
    const pressable = $derived(context.writable || drawing.header.id !== null)

    let width = $state(0)
    let status = $state('')
    /** The board takes the keyboard when it opens: the person asked for it. */
    let focusNext = $state(false)
    let board = $state<ReturnType<typeof InkBoard> | null>(null)

    const fit = $derived.by(() => {
        const picture = inkPicture(drawing)
        return { picture, ...fitPicture(picture.width, picture.height, width) }
    })

    // The column's width decides the picture's height: once measured, the editor asks again.
    $effect(() => {
        if (width <= 0 || Math.abs(width - services.columnWidth) < 1) return
        services.columnWidth = width
        if (context.presentation !== 'inline' || context.editing) return
        // On the next frame, not inside the size observer's callback that measured the width:
        // the editor changes the layout as it measures again.
        const ask = context.resized
        const frame = requestAnimationFrame(() => ask())
        return () => cancelAnimationFrame(frame)
    })

    function write(edits: FenceEdit | FenceEdit[]): boolean {
        const done = context.edit(edits)
        status = done ? '' : REFUSED
        return done
    }

    /** Give a drawing with no id one (a header written by hand without it), so it can be edited. */
    function ensureId(): boolean {
        if (drawing.header.id !== null) return true
        const edit = planHeader(drawing, { id: newDrawingId })
        return edit !== null && write(edit)
    }

    /**
     * The person asked to draw: a press on the picture, `/ink` putting it in, or the Client handing
     * the widget the keyboard in a tab or the window.
     */
    export function activate() {
        if (drawing.newer) return
        if (showBoard) {
            board?.focus()
            return
        }
        if (context.writable && !ensureId()) return
        focusNext = true
        if (context.writable && services.isDesktop()) context.setEditing?.(true)
        else context.openWindow()
    }

    /**
     * The Undo and Redo buttons: the editor's history in the document, the widget's own edits in a
     * tab or the window. Whatever is being drawn is written first, so Undo takes back the newest.
     */
    function history(step: 'undo' | 'redo') {
        board?.flush()
        const done = step === 'undo' ? context.undo?.() : context.redo?.()
        status = done ? '' : step === 'undo' ? 'Nothing to undo here.' : 'Nothing to redo here.'
    }

    /** Write what the board holds, before the Client acts on the fence. */
    export function flush() {
        board?.flush()
    }

    function done() {
        if (context.presentation === 'inline') context.setEditing?.(false)
        else if (context.presentation === 'window') context.closeWindow()
    }

    function drawPicture(holder: HTMLElement) {
        const element = svgElement(fit.picture.root)
        element.setAttribute('width', String(fit.width))
        element.setAttribute('height', String(fit.height))
        element.setAttribute('aria-hidden', 'true')
        holder.replaceChildren(element)
    }

    const label = $derived(`${inkAlt(drawing)}. ${context.writable ? 'Press to draw.' : 'Press to look closer.'}`)
</script>

<div class="gk-ink-block" data-testid="ink-drawing" bind:clientWidth={width}>
    {#if drawing.newer}
        <div class="gk-ink-newer" data-testid="ink-newer">
            <p>This drawing was made by a newer version of EtherPK. Update EtherPK to edit it.</p>
            <button type="button" class="gk-button" onclick={() => context.editAsText()}>Edit as text</button>
        </div>
    {:else if showBoard}
        <InkBoard
            bind:this={board}
            {drawing}
            writable={context.writable}
            icons={services.icons}
            storage={services.storage}
            {status}
            focusOnMount={focusNext || context.presentation !== 'inline'}
            addStroke={(stroke) => write(planAddStroke(context.body, stroke))}
            erase={(ids) => write(planErase(drawing, ids))}
            move={(ids, dx, dy) => write(planMove(drawing, ids, dx, dy))}
            undo={context.undo ? () => history('undo') : undefined}
            redo={context.redo ? () => history('redo') : undefined}
            setPaper={(paper) => {
                const edit = planHeader(drawing, { paper, id: newDrawingId })
                return edit === null || write(edit)
            }}
            {done}
        />
    {:else if pressable}
        <button type="button" class="gk-ink-picture" style:height={`${fit.boxHeight}px`} aria-label={label} data-testid="ink-picture" onclick={activate}>
            {@render picture()}
        </button>
    {:else}
        <div class="gk-ink-picture" style:height={`${fit.boxHeight}px`} role="img" aria-label={inkAlt(drawing)} data-testid="ink-picture">
            {@render picture()}
        </div>
    {/if}
</div>

{#snippet picture()}
    {#if drawing.strokes.length === 0}
        <span class="gk-ink-empty">{context.writable ? 'Empty drawing. Press to draw.' : 'Empty drawing.'}</span>
    {:else}
        <span class="gk-ink-picture-art" {@attach drawPicture}></span>
    {/if}
{/snippet}
