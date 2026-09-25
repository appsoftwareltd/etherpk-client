/**
 * The inline **action cluster** inside the editor: the row of small icon buttons that follows an
 * [[Asset Reference]] (`asset-link.ts`, `image-embed.ts`) or a [[File Link]] (`markdown-link.ts`).
 * One builder and one theme, so the two clusters look and behave the same; which actions each
 * holds is its affordances module's business (`asset-affordances.ts`, `link-affordances.ts`),
 * because the read-only rows show the same list with no CodeMirror anywhere near it
 * (`InlineActions.svelte`).
 *
 * Every button resolves its target **at click time** through the caller's `resolveTarget`,
 * never from a position baked in when it was built: CodeMirror reuses widget DOM across edits,
 * so a stored offset goes stale the moment text above it changes.
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { iconSvg } from '$lib/surface/icons'

import type { InlineAction } from '../../inline-action'

/** How long an action's confirmation (the tick after a copy) stands in for its icon. */
const CONFIRM_MS = 1500

export interface ActionClusterOptions<T> {
    /** Class on the container, for the surface's own styling. */
    className: string
    /** Class on each button; `${buttonClass}--done` marks the confirmation moment. */
    buttonClass: string
    /** The data attribute each button carries with its Command id (`data-asset-action`), which tests and the theme key on. */
    actionAttr: string
    /** What the buttons act on, read after the label: "Download q3-report.pdf", "Copy path /home/g/x". */
    name: string
    actions: InlineAction[]
    /** Icon size in px. */
    size: number
    /** The target for a click, resolved live; null means the click does nothing rather than acting on a guess. */
    resolveTarget: () => T | null
    /** Run the Command; resolves true when it did its work, which is what shows the action's `confirm`. */
    run: (command: string, target: T) => Promise<boolean>
}

/** What a button was painted with, so a confirmation can be shown on it from outside the cluster. */
interface Painted {
    action: InlineAction
    name: string
    size: number
    buttonClass: string
}

const painted = new WeakMap<HTMLButtonElement, Painted>()
/** The confirmation currently showing on each button; weak, so a button CodeMirror drops goes with it. */
const confirmTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>()

/**
 * Build the cluster. The editor is focused before a Command runs: a Command that edits acts on
 * whichever editor is ACTIVE, and with two documents open in split panes a click in the
 * unfocused one would otherwise be applied to the other.
 */
export function buildActionCluster<T>(view: EditorView, options: ActionClusterOptions<T>): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = options.className
    for (const action of options.actions) {
        const button = wrap.appendChild(document.createElement('button'))
        button.type = 'button'
        button.className = options.buttonClass
        button.title = action.label
        button.setAttribute('aria-label', `${action.label} ${options.name}`)
        button.setAttribute(options.actionAttr, action.command)
        // The icon markup is in-repo constant text (surface/icons.ts), never document content.
        button.innerHTML = iconSvg(action.icon, { size: options.size })
        painted.set(button, { action, name: options.name, size: options.size, buttonClass: options.buttonClass })
        // mousedown, not click: the editor's own handlers act on mousedown, and letting one
        // through would place the caret (or pin the image open) behind the dialog.
        button.addEventListener('mousedown', (event) => {
            event.preventDefault()
            event.stopPropagation()
            const target = options.resolveTarget()
            if (!target) return
            view.focus()
            const run = options.run(action.command, target)
            if (action.confirm) void run.then((done) => done && showConfirmation(button))
        })
    }
    return wrap
}

/**
 * Stand the action's confirmation in for its icon for a moment - the tick after a copy - then
 * put the icon back. The button itself stays: swapping elements under a pointer that is still
 * over it would drop the hover, and with it the overlay. A button CodeMirror has rebuilt in the
 * meantime is detached, and painting it is harmless.
 */
export function showConfirmation(button: HTMLButtonElement): void {
    const state = painted.get(button)
    const confirm = state?.action.confirm
    if (!state || !confirm) return
    const paint = (icon: string, label: string, done: boolean) => {
        button.innerHTML = iconSvg(icon, { size: state.size })
        button.title = label
        button.setAttribute('aria-label', `${label} ${state.name}`)
        button.classList.toggle(`${state.buttonClass}--done`, done)
    }
    paint(confirm.icon, confirm.label, true)
    // A second copy inside the window restarts it, rather than the first timer cutting it short.
    const pending = confirmTimers.get(button)
    if (pending) clearTimeout(pending)
    confirmTimers.set(
        button,
        setTimeout(() => {
            confirmTimers.delete(button)
            paint(state.action.icon, state.action.label, false)
        }, CONFIRM_MS),
    )
}

/**
 * Show the confirmation on the cluster's button for `command` when something outside the cluster
 * ran it: a click on the link text a cluster follows shares the button's tick, so the copy is
 * confirmed in place whichever was clicked.
 */
export function confirmClusterAction(wrap: Element, command: string): void {
    for (const button of wrap.querySelectorAll('button')) {
        if (painted.get(button)?.action.command === command) showConfirmation(button)
    }
}

/**
 * The theme every cluster shares. Quiet until wanted: the icons sit at low opacity and come up
 * when the pointer is over the line, the cluster, or one of them has keyboard focus; always
 * visible, since there is no hover on touch and this is the only affordance the link has. The
 * tick after a copy takes the accent so it reads as an outcome, not as another button.
 */
export function actionClusterTheme(className: string, buttonClass: string): Extension {
    return EditorView.baseTheme({
        [`.${className}`]: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '2px',
            marginLeft: '4px',
            verticalAlign: 'baseline',
            opacity: '0.45',
            transition: 'opacity 120ms ease',
        },
        [`.${className}:hover, .${className}:focus-within`]: { opacity: '1' },
        [`.cm-line:hover .${className}`]: { opacity: '0.8' },
        [`.${buttonClass}`]: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '3px',
            border: 'none',
            borderRadius: '4px',
            background: 'transparent',
            color: 'var(--gk-text-muted, currentColor)',
            cursor: 'pointer',
            lineHeight: '0',
        },
        [`.${buttonClass}:hover`]: {
            background: 'var(--gk-surface-2, rgba(127,127,127,0.15))',
            color: 'var(--gk-text-default, currentColor)',
        },
        [`.${buttonClass}--done, .${buttonClass}--done:hover`]: { color: 'var(--gk-accent, #007ACC)' },
        // No hover to wait for on touch: fully visible there, as the read-only cluster is.
        '@media (hover: none)': {
            [`.${className}`]: { opacity: '1' },
        },
        '@media (prefers-reduced-motion: reduce)': {
            [`.${className}`]: { transition: 'none' },
        },
    })
}
