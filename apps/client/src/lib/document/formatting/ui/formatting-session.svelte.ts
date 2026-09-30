/**
 * The open graph's [[Formatting Scan]] session (ADR 0109): the last scan's results, and the scan
 * and the approvals as reactive state the Maintenance tab reads.
 *
 * The workspace owns one per open graph, so results survive closing Settings and go when the
 * graph closes. The scan runs as an Activity, which keeps it going with Settings closed and
 * reports it in the Activity toast; approvals run outside it, one compare-and-set each.
 *
 * Everything worth testing is one layer down, in `scan.ts`; this is plumbing.
 */

import { cancelActivity, dismissActivity, runActivity, type ActivityOutcome } from '$lib/activity/store'

import { isBackupConfirmation } from '../backup-confirmation'
import type { FormattingCheckId } from '../checks'
import { approveAll, approveIssue, type FormattingIssue, type FormattingSource, type ScanReport, scanGraph } from '../scan'

export interface FormattingSessionOptions {
    source: FormattingSource
    /** The graph's name as the person knows it, for the toast. */
    graphName: () => string
    /** Opens Settings on the Maintenance tab: the finished toast's follow-on. */
    review: () => void
}

/** The result of the last Approve all, shown under its group. */
export interface ApproveAllTally {
    check: FormattingCheckId
    total: number
    fixed: number
    changed: number
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The toast's last word on a scan. */
function outcomeOf(report: ScanReport, review: () => void): ActivityOutcome {
    const pages = new Set(report.issues.map((issue) => issue.document.key)).size
    const found = `${plural(report.issues.length, 'issue', 'issues')} on ${plural(pages, 'page', 'pages')}`
    const action = { label: 'Review', run: review }
    if (report.stopped) {
        return { state: 'partial', title: 'Formatting scan stopped', detail: `Stopped after ${report.checked} of ${plural(report.total, 'page', 'pages')}, with ${found} so far.`, action }
    }
    if (report.issues.length === 0) return { title: 'Formatting scan finished', detail: `No formatting issues in ${plural(report.checked, 'page', 'pages')}.` }
    return { title: 'Formatting scan finished', detail: `${found}.`, action }
}

export class FormattingScanSession {
    /** `done` includes a scan Cancel stopped; the report says so. */
    phase = $state<'idle' | 'scanning' | 'done' | 'failed'>('idle')
    done = $state(0)
    total = $state(0)
    report = $state<ScanReport | null>(null)
    /** Why the last scan failed, while `phase` is `failed`. */
    error = $state<string | null>(null)
    /** Checks with a diff the person has opened: what enables their Approve all. */
    reviewed = $state<Partial<Record<FormattingCheckId, true>>>({})
    /** The check whose Approve all is running. */
    approvingAll = $state<FormattingCheckId | null>(null)
    lastApproveAll = $state<ApproveAllTally | null>(null)
    /**
     * What the person has typed to say they exported the graph and checked the export. A scan
     * waits for the phrase (`backup-confirmation.ts`). It is kept with the results, so closing
     * Settings does not lose it and a second scan while the graph is open does not ask again.
     */
    backupConfirmation = $state('')

    #options: FormattingSessionOptions
    /** The last scan's Activity, running or finished: what Cancel stops and closing the graph clears. */
    #activityId: string | null = null
    #disposed = false

    constructor(options: FormattingSessionOptions) {
        this.#options = options
    }

    /** Whether any approval is writing: a new scan waits for them, so their results are not lost. */
    get busy(): boolean {
        return this.phase === 'scanning' || this.approvingAll !== null || (this.report?.issues.some((issue) => issue.status === 'applying') ?? false)
    }

    /** Whether the confirmation phrase has been typed, which is what lets a scan start. */
    get backupConfirmed(): boolean {
        return isBackupConfirmation(this.backupConfirmation)
    }

    async scan(): Promise<void> {
        // Checked here as well as on the buttons, so no way of starting a scan skips the confirmation.
        if (this.busy || this.#disposed || !this.backupConfirmed) return
        // The last scan's toast speaks for results this scan replaces.
        if (this.#activityId) dismissActivity(this.#activityId)
        this.phase = 'scanning'
        this.error = null
        this.done = 0
        this.total = 0
        this.lastApproveAll = null
        const name = this.#options.graphName()
        // Assigned inside the run; declared through `as` so the checks after it are not narrowed to null.
        let report = null as ScanReport | null
        let failure: unknown = null
        await runActivity({
            kind: 'formatting-scan',
            title: `Checking formatting in “${name}”`,
            failureTitle: `Formatting scan of “${name}” did not finish`,
            phases: [{ label: 'Checking pages', unit: 'items' }],
            cancellable: true,
            run: async (activity) => {
                this.#activityId = activity.id
                try {
                    report = await scanGraph(this.#options.source, {
                        signal: activity.signal,
                        onProgress: (done, total) => {
                            this.done = done
                            this.total = total
                            activity.report({ phase: 0, done, total })
                        },
                    })
                } catch (error) {
                    failure = error
                    throw error
                }
                // Closed with the graph: nothing to review, and no action pointing at a workspace that has gone.
                if (this.#disposed) return { state: 'partial', title: 'Formatting scan stopped', detail: 'The graph was closed.', dismissal: 'auto' }
                return outcomeOf(report, this.#options.review)
            },
        })
        if (this.#disposed) return
        if (report) {
            this.report = report
            this.reviewed = {}
            this.phase = 'done'
        } else {
            this.error = failure instanceof Error ? failure.message : String(failure)
            this.phase = 'failed'
        }
    }

    /** Stop the scan at its next chunk; what was checked is kept. */
    cancel(): void {
        if (this.#activityId) cancelActivity(this.#activityId)
    }

    async approve(issue: FormattingIssue): Promise<void> {
        if (!this.report) return
        await approveIssue(this.#options.source, this.report.issues, issue)
    }

    async approveAll(check: FormattingCheckId): Promise<void> {
        if (!this.report || this.approvingAll !== null) return
        this.approvingAll = check
        this.lastApproveAll = null
        try {
            const tally = await approveAll(this.#options.source, this.report.issues, check)
            this.lastApproveAll = { check, ...tally }
        } finally {
            this.approvingAll = null
        }
    }

    /** Skipping only hides the issue: nothing is written, and Show again brings it back. */
    skip(issue: FormattingIssue): void {
        if (issue.status === 'pending' || issue.status === 'changed' || issue.status === 'unconfirmed' || issue.status === 'failed') issue.status = 'skipped'
    }

    showAgain(issue: FormattingIssue): void {
        if (issue.status === 'skipped') issue.status = 'pending'
    }

    markReviewed(check: FormattingCheckId): void {
        if (!this.reviewed[check]) this.reviewed[check] = true
    }

    /**
     * The graph is closing: stop a running scan, and take down a finished one's toast, whose Review
     * would open Settings on a graph that is no longer open.
     */
    dispose(): void {
        this.#disposed = true
        if (!this.#activityId) return
        cancelActivity(this.#activityId)
        dismissActivity(this.#activityId)
    }
}
