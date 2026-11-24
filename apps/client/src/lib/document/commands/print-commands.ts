/**
 * **Print or save as PDF…** (ADR 0207): the row on a document's menus and on a drawing's tab, the row
 * in the Command Menu, and the Command behind them and behind Mod+P. The workspace says what can be
 * printed and prints it. This module decides where the row is offered and what is said.
 */
import { dismissNotice, showNotice } from '#lib/activity/notices.js'
import {
    type CommandRegistry,
    type ContextMenuTarget,
    type ContributionRegistry,
    isDocumentTarget,
    registerCommandMenuItem,
    registerContextMenuItem,
} from '#lib/surface/index.js'

import { ProtectedPrintError } from '../print/print-text'
import { isPrinting, PRINT_UNKNOWN, type PrintOutcome } from '../print/print-window'

export const DOCUMENT_PRINT = 'document.print'
export const PRINT_LABEL = 'Print or save as PDF…'
export const PROTECTED_NOT_PRINTED = 'A Protected Document cannot be printed.'
/** A browser that never says its dialog closed has one print open for two minutes. */
export const PRINT_OPEN = 'Another print is open. Close its dialog, and then print again.'
const PRINT_NOTICE = 'print'

/** What a print is of: a document by its concept (in a Plain Folder, its path), or a fence's own tab by its View target. */
export type PrintSubject = { kind: 'document'; target: string } | { kind: 'fence'; target: string }

/** Whether a subject can be printed: `protected` says so when asked by key, and `no` leaves the key to the browser. */
export type Printable = 'yes' | 'protected' | 'no'

export interface PrintCommandDeps {
    /** Whether the subject can be printed now. */
    printable(subject: PrintSubject): Printable
    /** What the subject is called. */
    nameOf(subject: PrintSubject): string
    /** What is in front in the main region, or null for a View that does not print. */
    active(): PrintSubject | null
    /** Print it, calling `onReady` as the dialog is about to open. */
    print(subject: PrintSubject, onReady: () => void): Promise<PrintOutcome>
}

/** What a menu's target would print, or null. */
export function printSubjectOf(target: ContextMenuTarget): PrintSubject | null {
    if (isDocumentTarget(target)) return { kind: 'document', target: target.concept }
    if (target.kind !== 'tab' || !target.view) return null
    // A Plain Folder's file is a document by its path, whatever its tab's target looks like.
    if (target.view.kind === 'document' || target.view.kind === 'fence') return { kind: target.view.kind, target: target.view.target }
    return null
}

/** A menu hands its target, the Command Menu its editor's context, and a key nothing. */
const isMenuTarget = (arg: unknown): arg is ContextMenuTarget => typeof (arg as { kind?: unknown } | null | undefined)?.kind === 'string'

/** Whether what is in front can be asked for by key, as the open workspace answers. */
let answersKey: (() => boolean) | null = null

/**
 * Whether Mod+P is the app's just now: a document or a drawing is in front, and no dialog is open over
 * it. A Protected Document is asked for too, and answered with why not. Elsewhere the key is the
 * browser's, and a PDF's tab has its own.
 */
export function printKeyAvailable(): boolean {
    if (typeof document === 'undefined' || document.querySelector('[aria-modal="true"]')) return false
    return answersKey?.() ?? false
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim().replace(/([^.!?])$/, '$1.')

export function registerPrintCommands(commands: CommandRegistry, contributions: ContributionRegistry, deps: PrintCommandDeps): () => void {
    /** A print is being prepared: a second press waits for nothing and does nothing. */
    let preparing = false

    async function print(subject: PrintSubject): Promise<void> {
        if (preparing) return
        if (isPrinting()) return showNotice({ id: PRINT_NOTICE, tone: 'info', text: PRINT_OPEN })
        const name = deps.nameOf(subject)
        const printable = deps.printable(subject)
        if (printable === 'protected') return showNotice({ id: PRINT_NOTICE, tone: 'info', text: PROTECTED_NOT_PRINTED })
        if (printable === 'no') return
        preparing = true
        // Said only where preparing takes long enough to wonder at.
        const slow = setTimeout(() => showNotice({ id: PRINT_NOTICE, tone: 'info', dismissal: 'manual', text: `Preparing "${name}" to print…` }), 300)
        const settled = () => {
            clearTimeout(slow)
            dismissNotice(PRINT_NOTICE)
        }
        try {
            const outcome = await deps.print(subject, settled)
            settled()
            if (outcome === 'unknown') showNotice({ id: PRINT_NOTICE, tone: 'info', text: PRINT_UNKNOWN })
        } catch (error) {
            settled()
            // Protected while the print was being prepared, which the menu could not know.
            if (error instanceof ProtectedPrintError) showNotice({ id: PRINT_NOTICE, tone: 'info', text: PROTECTED_NOT_PRINTED })
            else showNotice({ id: PRINT_NOTICE, tone: 'error', text: `"${name}" could not be printed. ${reasonOf(error)}` })
        } finally {
            preparing = false
        }
    }

    const offered = (target: ContextMenuTarget) => {
        const subject = printSubjectOf(target)
        return subject !== null && deps.printable(subject) === 'yes'
    }

    const inFront = () => {
        const subject = deps.active()
        return subject !== null && deps.printable(subject) !== 'no'
    }
    answersKey = inFront

    const disposers = [
        // With no menu's target (the key, the Command Menu), what is in front.
        commands.register(DOCUMENT_PRINT, (arg) => {
            const subject = isMenuTarget(arg) ? printSubjectOf(arg) : deps.active()
            return subject ? print(subject) : undefined
        }),
        registerContextMenuItem(contributions, { id: DOCUMENT_PRINT, label: PRINT_LABEL, command: DOCUMENT_PRINT, order: 25, when: offered }),
        registerCommandMenuItem(contributions, {
            id: DOCUMENT_PRINT,
            title: PRINT_LABEL,
            icon: 'pdf-print',
            group: 'Go to',
            order: 160,
            keywords: ['print', 'pdf', 'save', 'download', 'export', 'paper'],
            command: DOCUMENT_PRINT,
            when: () => {
                const subject = deps.active()
                return subject !== null && deps.printable(subject) === 'yes'
            },
        }),
    ]
    return () => {
        for (const dispose of disposers) dispose()
        if (answersKey === inFront) answersKey = null
    }
}
