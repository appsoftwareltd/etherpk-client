<script lang="ts">
    /**
     * The Formatting section of Settings → Maintenance (ADR 0109): the [[Formatting Scan]]'s
     * controls, its results grouped by [[Formatting Check]], and each [[Formatting Issue]]'s diff
     * and decision.
     *
     * Everything that must outlive the dialog is the workspace's session, so closing and
     * reopening Settings keeps the results. What belongs to this view alone (which diffs are open,
     * an Approve all waiting to be confirmed) is local.
     *
     * The section renders inside the Settings form: every button declares `type="button"`, or it
     * would submit the form (dialog-button-type.test.ts).
     */
    import { tick } from "svelte";

    import { BACKUP_CONFIRMATION_PHRASE } from "../backup-confirmation";
    import { FORMATTING_CHECKS, type FormattingCheckId } from "../checks";
    import { type FormattingIssue, type IssueStatus, revealLineOf } from "../scan";
    import FormattingDiff from "./FormattingDiff.svelte";
    import type { FormattingSectionProps } from "./formatting-section";

    let { session, backup, onopenpage, onexport = null }: FormattingSectionProps & { onexport?: (() => void) | null } = $props();

    const uid = $props.id();
    let root = $state<HTMLElement>();

    /** Diffs open in this view, by issue id. */
    let expanded = $state<Record<string, boolean>>({});
    /** The check whose Approve all is waiting for its confirmation. */
    let confirming = $state<FormattingCheckId | null>(null);

    const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

    /** Statuses still asking something of the person. */
    const OPEN: ReadonlySet<IssueStatus> = new Set(["pending", "applying", "changed", "unconfirmed", "failed"]);

    const report = $derived(session.report);

    const groups = $derived(
        report
            ? FORMATTING_CHECKS.map((check) => ({
                  check,
                  issues: report.issues.filter((issue) => issue.check === check.id),
              })).filter((group) => group.issues.length > 0)
            : [],
    );

    const summary = $derived.by(() => {
        if (!report) return "";
        const checked = plural(report.checked, "page", "pages");
        if (report.issues.length === 0) return `No formatting issues in ${checked}.`;
        const open = report.issues.filter((issue) => OPEN.has(issue.status));
        if (open.length === 0) return `No issues left to review (${checked} checked).`;
        const pages = new Set(open.map((issue) => issue.document.key)).size;
        return `${plural(open.length, "issue", "issues")} on ${plural(pages, "page", "pages")} (${checked} checked).`;
    });

    const syncing = $derived(report?.unread.filter((entry) => entry.reason === "syncing") ?? []);
    const unreadable = $derived(report?.unread.filter((entry) => entry.reason === "unreadable") ?? []);

    /** The one polite announcement: a scan finishing or failing. Nothing per fix; the row says it. */
    const announcement = $derived(
        session.phase === "failed" ? `The scan failed, so nothing was changed (${session.error}).` : session.phase === "done" ? summary : "",
    );

    const backupAdvice = $derived(
        backup === "export"
            ? "We strongly recommend exporting the graph first."
            : backup === "folder"
              ? "We strongly recommend copying the folder first, or committing it if it is under version control."
              : "",
    );

    /** A stable DOM id for an issue's diff: issues are only ever appended, so the index holds. */
    function diffId(issue: FormattingIssue): string {
        return `${uid}-diff-${report?.issues.indexOf(issue) ?? 0}`;
    }

    function fixable(issue: FormattingIssue): boolean {
        return issue.finding.fixed !== null;
    }

    function toggleDiff(issue: FormattingIssue) {
        const next = !expanded[issue.id];
        expanded[issue.id] = next;
        if (next) session.markReviewed(issue.check);
    }

    /** Where focus goes when the control that held it has gone: the row's status line. */
    async function keepFocusIn(issue: FormattingIssue, selector: string) {
        await tick();
        if (root?.contains(document.activeElement) && document.activeElement !== document.body) return;
        root?.querySelector<HTMLElement>(`[data-issue="${CSS.escape(issue.id)}"] ${selector}`)?.focus();
    }

    async function approve(issue: FormattingIssue) {
        await session.approve(issue);
        await keepFocusIn(issue, "[data-issue-status]");
    }

    async function skip(issue: FormattingIssue) {
        session.skip(issue);
        await keepFocusIn(issue, "[data-show-again]");
    }

    async function showAgain(issue: FormattingIssue) {
        session.showAgain(issue);
        await keepFocusIn(issue, "[data-approve], [data-open-page]");
    }

    function openPage(issue: FormattingIssue) {
        onopenpage(issue.document.concept, revealLineOf(issue));
    }

    async function askApproveAll(check: FormattingCheckId) {
        confirming = check;
        await tick();
        root?.querySelector<HTMLElement>(`[data-confirm="${check}"] [data-confirm-title]`)?.focus();
    }

    async function cancelApproveAll(check: FormattingCheckId) {
        confirming = null;
        await tick();
        root?.querySelector<HTMLElement>(`[data-approve-all="${check}"]`)?.focus();
    }

    async function runApproveAll(check: FormattingCheckId) {
        confirming = null;
        await session.approveAll(check);
        await tick();
        root?.querySelector<HTMLElement>(`[data-approve-all-result="${check}"]`)?.focus();
    }

    /** What the field's label asks for first, before the phrase itself. */
    const backupStep = $derived(
        backup === "export"
            ? "When you have exported this graph and checked the export, type"
            : backup === "folder"
              ? "When you have copied or committed the folder and checked the copy, type"
              : "To start the scan, type",
    );

    /**
     * The scan buttons are disabled until the phrase is typed, and name this line as the reason:
     * a disabled button cannot be focused, so a tooltip on one could never be read.
     */
    const confirmReasonId = `${uid}-confirm-reason`;
    const scanReason = $derived(session.backupConfirmed ? undefined : confirmReasonId);

    /** Enter in the confirmation field starts the scan once the phrase is there, instead of submitting Settings. */
    function onBackupConfirmKeydown(event: KeyboardEvent) {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (session.backupConfirmed) void session.scan();
    }

    /** Escape in the confirmation cancels it, rather than closing Settings under it. */
    function onConfirmKeydown(event: KeyboardEvent, check: FormattingCheckId) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        void cancelApproveAll(check);
    }

    const button =
        "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40";
    const primary =
        "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40";
</script>

<section bind:this={root} class="space-y-3" aria-labelledby="{uid}-heading" data-testid="formatting-section">
    <h3 id="{uid}-heading" class="text-sm font-medium text-gray-500 dark:text-gray-400">Formatting</h3>
    <p class="text-sm text-gray-600 dark:text-gray-300">
        The scan finds text that EtherPK reads differently from the way it writes it, e.g., tabs and uneven
        indentation, bullets written with * or +, no-break spaces in indentation, Windows line endings and unclosed
        code blocks. Fixing indentation can change how a page's bullets nest in the editor, so that they nest the way
        the author meant. Nothing changes until you approve a fix.
    </p>
    <div
        class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100"
        data-testid="formatting-backup-note"
    >
        {#if backup === "export"}
            <p>
                Fixes rewrite your pages, and they can't be undone here. We strongly recommend exporting this graph first,
                so you keep a copy of every page as it is now.
            </p>
            {#if onexport}
                <button type="button" onclick={onexport} class={button} data-testid="formatting-export">Export…</button>
            {/if}
        {:else if backup === "folder"}
            <p>
                Fixes rewrite the files in this graph's folder, and they can't be undone here. We strongly recommend copying
                the folder first, or committing it if it is under version control.
            </p>
        {:else}
            <p>Fixes rewrite your pages, and they can't be undone here.</p>
        {/if}
        <div class="space-y-1.5 pt-1">
            <label for="{uid}-confirm" class="block">
                {backupStep} <strong class="font-semibold">'{BACKUP_CONFIRMATION_PHRASE}'</strong> below.
            </label>
            <input
                id="{uid}-confirm"
                type="text"
                value={session.backupConfirmation}
                oninput={(event) => (session.backupConfirmation = event.currentTarget.value)}
                onkeydown={onBackupConfirmKeydown}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                class="block w-full max-w-md rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                data-testid="formatting-confirm"
            />
        </div>
    </div>

    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            onclick={() => session.scan()}
            disabled={session.busy || !session.backupConfirmed}
            aria-describedby={scanReason}
            class={button}
            data-testid="formatting-scan"
        >
            {session.phase === "scanning"
                ? session.total > 0
                    ? `Scanning… ${session.done.toLocaleString()} of ${plural(session.total, "page", "pages")}`
                    : "Scanning…"
                : report
                  ? "Scan again"
                  : "Scan for formatting issues"}
        </button>
        {#if session.phase === "scanning"}
            <button type="button" onclick={() => session.cancel()} class={button} data-testid="formatting-cancel">Cancel</button>
        {/if}
    </div>
    {#if !session.backupConfirmed}
        <p id={confirmReasonId} class="text-sm text-gray-500 dark:text-gray-400" data-testid="formatting-confirm-reason">
            Type the phrase above to turn on the scan.
        </p>
    {/if}
    {#if session.busy && session.phase !== "scanning"}
        <p class="text-sm text-gray-500 dark:text-gray-400">A new scan can start once the fixes in progress finish.</p>
    {/if}

    <p class="sr-only" aria-live="polite">{announcement}</p>

    {#if session.phase === "failed"}
        <div class="space-y-2" data-testid="formatting-failed">
            <p class="text-sm text-red-600 dark:text-red-400">The scan failed, so nothing was changed ({session.error}).</p>
            <button type="button" onclick={() => session.scan()} disabled={session.busy || !session.backupConfirmed} aria-describedby={scanReason} class={button}
                >Try again</button
            >
        </div>
    {/if}

    {#if report}
        <div class="space-y-1" data-testid="formatting-summary">
            {#if report.stopped}
                <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="formatting-stopped">
                    Scan stopped after {session.done.toLocaleString()} of {plural(report.total, "page", "pages")}.
                </p>
            {/if}
            <p class="text-sm text-gray-600 dark:text-gray-300" data-testid="formatting-result">{summary}</p>
            {#if report.protectedCount > 0}
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="formatting-protected">
                    {report.protectedCount === 1
                        ? "1 Protected Document was not checked."
                        : `${report.protectedCount.toLocaleString()} Protected Documents were not checked.`}
                </p>
            {/if}
            {#if syncing.length > 0}
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="formatting-syncing">
                    {syncing.length === 1
                        ? "1 page was not checked because it has not finished syncing."
                        : `${syncing.length.toLocaleString()} pages were not checked because they have not finished syncing.`}
                    <button
                        type="button"
                        onclick={() => session.scan()}
                        disabled={session.busy || !session.backupConfirmed}
                        aria-describedby={scanReason}
                        class="font-medium text-gray-700 dark:text-gray-200 underline underline-offset-2 disabled:opacity-40"
                        >Scan again</button
                    >
                </p>
            {/if}
            {#if unreadable.length > 0}
                <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="formatting-unreadable">
                    {unreadable.length === 1 ? "1 page" : `${unreadable.length.toLocaleString()} pages`} could not be read, so
                    {unreadable.length === 1 ? "it was" : "they were"} not checked: {unreadable.map((entry) => entry.document.concept).join(", ")}.
                </p>
            {/if}
        </div>

        {#each groups as group (group.check.id)}
            {@const check = group.check}
            {@const pending = group.issues.filter((issue) => issue.status === "pending")}
            {@const canFix = group.issues.some(fixable)}
            <div
                class="space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3"
                role="group"
                aria-labelledby="{uid}-group-{check.id}"
                data-testid="formatting-group"
                data-check={check.id}
            >
                <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
                    <h4 id="{uid}-group-{check.id}" class="text-sm font-medium text-gray-950 dark:text-gray-100">
                        {check.label}
                        <span class="font-normal text-gray-500 dark:text-gray-400">({plural(group.issues.length, "page", "pages")})</span>
                    </h4>
                    {#if canFix && pending.length > 0}
                        <div class="flex flex-wrap items-center gap-2">
                            {#if !session.reviewed[check.id]}
                                <span class="text-sm text-gray-500 dark:text-gray-400" id="{uid}-approve-all-why-{check.id}"
                                    >Show the changes for one page in the group first.</span
                                >
                            {/if}
                            <button
                                type="button"
                                onclick={() => askApproveAll(check.id)}
                                disabled={!session.reviewed[check.id] || session.approvingAll !== null || session.phase === "scanning"}
                                aria-describedby={session.reviewed[check.id] ? undefined : `${uid}-approve-all-why-${check.id}`}
                                class={button}
                                data-approve-all={check.id}
                                data-testid="formatting-approve-all"
                                >{session.approvingAll === check.id ? "Fixing…" : `Approve all ${pending.length.toLocaleString()}`}</button
                            >
                        </div>
                    {/if}
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">{check.help}</p>

                {#if confirming === check.id}
                    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                    <div
                        class="space-y-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 text-sm text-amber-900 dark:text-amber-100"
                        role="group"
                        aria-labelledby="{uid}-confirm-{check.id}"
                        data-confirm={check.id}
                        data-testid="formatting-approve-all-confirm"
                        onkeydown={(event) => onConfirmKeydown(event, check.id)}
                    >
                        <p id="{uid}-confirm-{check.id}" class="font-medium" tabindex="-1" data-confirm-title>
                            Fix {plural(pending.length, "page", "pages")}?
                        </p>
                        <p>
                            Approving all of them rewrites {plural(pending.length, "page", "pages")}, and you can't undo the changes here. {backupAdvice}
                        </p>
                        <div class="flex flex-wrap gap-2">
                            <button type="button" onclick={() => runApproveAll(check.id)} class={primary} data-testid="formatting-approve-all-go"
                                >Fix {plural(pending.length, "page", "pages")}</button
                            >
                            <button type="button" onclick={() => cancelApproveAll(check.id)} class={button}>Cancel</button>
                        </div>
                    </div>
                {/if}
                {#if session.lastApproveAll?.check === check.id}
                    {@const tally = session.lastApproveAll}
                    <p class="text-sm text-gray-600 dark:text-gray-300" tabindex="-1" data-approve-all-result={check.id} data-testid="formatting-approve-all-result">
                        Fixed {tally.fixed.toLocaleString()} of {tally.total.toLocaleString()}.{tally.changed > 0
                            ? ` ${plural(tally.changed, "page", "pages")} changed since the scan and ${tally.changed === 1 ? "is" : "are"} shown again.`
                            : ""}
                    </p>
                {/if}

                <ul class="space-y-2">
                    {#each group.issues as issue (issue.id)}
                        {@const open = OPEN.has(issue.status)}
                        <li
                            class="space-y-2 rounded-lg border border-gray-200 dark:border-gray-800 p-3"
                            data-issue={issue.id}
                            data-status={issue.status}
                            data-testid="formatting-issue"
                        >
                            <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                                <div class="min-w-0">
                                    <p class="break-words text-sm font-medium text-gray-950 dark:text-gray-100" data-testid="formatting-issue-page">
                                        {issue.document.concept}
                                    </p>
                                    {#if issue.status !== "skipped"}
                                        <p class="text-sm text-gray-500 dark:text-gray-400">{issue.finding.reason}</p>
                                    {/if}
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    {#if issue.status === "skipped"}
                                        <button type="button" onclick={() => showAgain(issue)} class={button} data-show-again data-testid="formatting-show-again"
                                            >Show again</button
                                        >
                                    {:else}
                                        {#if open && fixable(issue)}
                                            <button
                                                type="button"
                                                onclick={() => toggleDiff(issue)}
                                                aria-expanded={expanded[issue.id] ?? false}
                                                aria-controls={diffId(issue)}
                                                class={button}
                                                data-testid="formatting-show-changes"
                                                >{expanded[issue.id] ? "Hide changes" : "Show changes"}</button
                                            >
                                            <button
                                                type="button"
                                                onclick={() => approve(issue)}
                                                disabled={issue.status === "applying" || session.approvingAll !== null}
                                                class={primary}
                                                data-approve
                                                data-testid="formatting-approve"
                                                >{issue.status === "applying"
                                                    ? "Fixing…"
                                                    : issue.status === "unconfirmed" || issue.status === "failed"
                                                      ? "Try again"
                                                      : "Approve"}</button
                                            >
                                            <button
                                                type="button"
                                                onclick={() => skip(issue)}
                                                disabled={issue.status === "applying"}
                                                class={button}
                                                data-testid="formatting-skip">Skip</button
                                            >
                                        {/if}
                                        {#if issue.status !== "gone"}
                                            <button type="button" onclick={() => openPage(issue)} class={button} data-open-page data-testid="formatting-open-page"
                                                >Open page</button
                                            >
                                        {/if}
                                    {/if}
                                </div>
                            </div>
                            {#if issue.status !== "pending" && issue.status !== "applying"}
                                <p
                                    class="text-sm {issue.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-300'}"
                                    tabindex="-1"
                                    data-issue-status
                                    data-testid="formatting-issue-status"
                                >
                                    {#if issue.status === "fixed"}
                                        Fixed.
                                    {:else if issue.status === "skipped"}
                                        Skipped.
                                    {:else if issue.status === "changed"}
                                        The page changed after the scan, so the changes shown are for its current text.
                                    {:else if issue.status === "resolved"}
                                        The page no longer has the issue.
                                    {:else if issue.status === "gone"}
                                        The page no longer exists.
                                    {:else if issue.status === "protected"}
                                        The page is now protected, so it was not changed.
                                    {:else if issue.status === "unconfirmed"}
                                        The page is still syncing. Try again after it has finished syncing.
                                    {:else if issue.status === "failed"}
                                        The page was not changed, because the fix could not be written ({issue.error}).
                                    {/if}
                                </p>
                            {/if}
                            {#if open && fixable(issue) && expanded[issue.id]}
                                <FormattingDiff id={diffId(issue)} before={issue.scannedText} after={issue.finding.fixed ?? issue.scannedText} />
                            {/if}
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    {/if}
</section>
