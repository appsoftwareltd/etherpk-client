/**
 * Printing from the app's own window (ADR 0207): what is to be printed goes into a container that
 * only print media shows, the rest of the page is hidden while it prints, and the browser's dialog
 * opens, where the person picks a printer or saves a PDF. No frame is used, as the Content Security
 * Policy refuses one and a sandboxed one cannot open the dialog (ADR 0055).
 *
 * A document, a drawing and a PDF all print through here.
 */
import './print.css'

/**
 * How long the browser may take to say the dialog has closed. Some never say: an installed web app
 * on iOS can print with no word back, and a page that waits for ever stays hidden behind its print.
 */
export const DIALOG_LIMIT_MS = 120_000

/** Said when the limit passes. The print may have finished: only the browser knows. */
export const PRINT_UNKNOWN = 'EtherPK could not tell whether the print finished. Check your printer or your downloads.'

export interface PrintJob {
    container: HTMLElement
    /** Rules of this print alone, such as its page size. */
    styles?: string
    /** The name a saved PDF is offered under, without `.pdf`. Absent: the page's own title. */
    title?: string
    /** Called just before the dialog opens, when nothing is left to prepare. */
    onReady?: () => void
}

/** `printed` once the dialog has closed, whatever was chosen there, `unknown` when the browser never said. */
export type PrintOutcome = 'printed' | 'unknown'

/** The parts of the window a print uses, so the wait can be tested without one. */
export interface PrintWindow {
    addEventListener(type: 'afterprint', listener: () => void): void
    removeEventListener(type: 'afterprint', listener: () => void): void
    print(): void
}

/** `print()` returns at once in some browsers and blocks in others. `afterprint` comes in both, or not at all. */
export function printAndWait(target: PrintWindow, limitMs: number = DIALOG_LIMIT_MS): Promise<PrintOutcome> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined = undefined
        const finish = (outcome: PrintOutcome) => {
            clearTimeout(timer)
            target.removeEventListener('afterprint', closed)
            resolve(outcome)
        }
        const closed = () => finish('printed')
        target.addEventListener('afterprint', closed)
        try {
            target.print()
        } catch (error) {
            target.removeEventListener('afterprint', closed)
            reject(error instanceof Error ? error : new Error(String(error)))
            return
        }
        // Counted from when the call returned: a browser whose call blocks has said by now.
        timer = setTimeout(() => finish('unknown'), limitMs)
    })
}

let printing = false

/** Whether a print is being shown to the browser now: a second one would hide the first's pages. */
export const isPrinting = (): boolean => printing

/** Show `job` to the browser's print dialog. Resolves when the dialog has closed, with the page as it was. */
export async function printContainer(job: PrintJob): Promise<PrintOutcome> {
    if (printing) throw new Error('Another print is open')
    printing = true
    const { container } = job
    const title = document.title
    const style = document.createElement('style')
    style.textContent = job.styles ?? ''
    try {
        container.classList.add('etherpk-print')
        container.setAttribute('aria-hidden', 'true')
        document.head.append(style)
        document.body.append(container)
        document.body.classList.add('etherpk-printing')
        document.documentElement.classList.add('etherpk-printing')
        // A picture that will not decode prints as a gap: its line says so before it gets here.
        await Promise.all([...container.querySelectorAll('img')].map((image) => image.decode().catch(() => {})))
        if (job.title !== undefined) document.title = job.title
        job.onReady?.()
        return await printAndWait(window)
    } finally {
        if (job.title !== undefined) document.title = title
        document.body.classList.remove('etherpk-printing')
        document.documentElement.classList.remove('etherpk-printing')
        container.remove()
        style.remove()
        printing = false
    }
}
