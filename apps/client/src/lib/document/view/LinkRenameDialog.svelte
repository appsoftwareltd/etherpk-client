<script lang="ts">
    /**
     * The renames one link edit proposes, asked together (ADR 0065, amended 2026-10-03). An edit
     * of a wikilink can change several names - the outer link's own text and a scope inside it,
     * say - and they are answered in one place before any of them runs.
     *
     * One row per rename, ticked by default: a ticked rename is made everywhere, an unticked one
     * changes just the link that was edited. The new name is what was typed, so it is shown
     * rather than offered for editing; another name means editing the link. Each row carries its
     * own impact and, for a concept with a page, its own choice of keeping the old name as an
     * alias or updating the links. A row's preview leaves out names a ticked row above it
     * renames first, so the figures add up to what will happen.
     *
     * States: plans still being computed (per row), a rename the store refuses (unticked and
     * locked, the reason beside it), nothing ticked (Rename has nothing to do, and the dialog
     * says so in place), running (busy; dismissal refused), and a failed run (each row marked
     * renamed, failed with its reason, or not started; Retry runs the rest, Close keeps what is
     * done). A run that completes closes the dialog.
     */
    import Dialog from "@appsoftwareltd/etherpk-shared/dialog";
    import type { RenameLinkStrategy } from "$lib/storage/rename";

    import { type LinkRenameChoice, type LinkRenameRow, previewPlans } from "./link-renames";
    import RenameRow from "./RenameRow.svelte";

    let {
        rows,
        busy = false,
        onconfirm,
        onclose,
    }: {
        rows: LinkRenameRow[];
        busy?: boolean;
        /** Run the ticked renames, in the order of the rows, with each row's choice. */
        onconfirm: (choices: LinkRenameChoice[]) => void;
        /** Keep the links as typed - or, after a failed run, keep what was done. */
        onclose: () => void;
    } = $props();

    // Mounted fresh for each edit's renames, so the rows it opens with are the whole story.
    // svelte-ignore state_referenced_locally
    let ticked = $state(rows.map(() => true));
    // svelte-ignore state_referenced_locally
    // Updating the links is each row's default (RenameImpact.svelte says why).
    let strategies = $state<RenameLinkStrategy[]>(rows.map(() => "rewrite"));

    const uid = $props.id();
    const hintId = `${uid}-hint`;

    /** A rename the store will not make: shown on its row, which cannot be ticked. */
    const refusals = $derived(rows.map((row) => row.plan?.refusal ?? null));
    /** Whether each row will run: ticked, and not refused. */
    const effective = $derived(rows.map((_, i) => ticked[i] && refusals[i] === null));
    const previews = $derived(previewPlans(rows.map((row, i) => ({ plan: row.plan, ticked: effective[i] }))));
    const started = $derived(rows.some((row) => row.status !== "waiting"));
    const failed = $derived(rows.some((row) => row.status === "failed"));
    const toRun = $derived(rows.filter((row, i) => effective[i] && row.status !== "done").length);
    const several = $derived(rows.length > 1);
    /** Every row is refused, so there is nothing to tick. */
    const allRefused = $derived(refusals.every((refusal) => refusal !== null));
    /**
     * Why Rename is off, in persistent text (rule 7), or null when it is on. Once a run has
     * started a row can be unticked but not ticked again, so Retry keeps the outermost-first order.
     */
    const hint = $derived(
        busy || toRun > 0
            ? null
            : allRefused
              ? "None of these can be renamed. The links stay as you typed them."
              : started
                ? "Nothing is left to rename. Close keeps what was done."
                : "Tick a rename, or keep the links as typed.",
    );

    /**
     * A row that cannot change: refused, already renamed, or unticked once a run has started. It
     * stays focusable (`aria-disabled`, not `disabled`), so focus is not lost when a refusal
     * arrives on the tick that has it, and the reason beside it is reachable.
     */
    function locked(row: LinkRenameRow, index: number): boolean {
        return refusals[index] !== null || row.status === "done" || (started && !ticked[index]);
    }

    /** After a failed run, focus goes to Retry (rule 6): the failed row says why, beside it. */
    function focusRetryAfterFailure(button: HTMLButtonElement): void {
        if (failed && !busy) button.focus();
    }

    function confirm() {
        // Guarded here as well as on the button: Enter in the form reaches this too.
        if (busy || toRun === 0) return;
        onconfirm(rows.map((row, i) => ({ ticked: effective[i], strategy: row.pageless ? "rewrite" : strategies[i] })));
    }

    /**
     * Enter on a checkbox or radio confirms, as it does in a text field: every control here is
     * one, and a browser does not submit a form from them.
     */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        confirm();
    }

    function statusOf(row: LinkRenameRow, index: number): string | null {
        if (row.status === "done") return "Renamed";
        if (row.status === "failed") return null; // the reason is shown instead
        return started && effective[index] ? "Not started" : null;
    }
</script>

<Dialog open={true} title="Rename" size="lg" testId="link-rename-dialog" {busy} busyReason="Renaming…" {onclose} onsubmit={confirm}>
    {#snippet body()}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="space-y-4" onkeydown={onKeydown} role="group" aria-labelledby="{uid}-intro">
            <p id="{uid}-intro" class="text-sm text-gray-600 dark:text-gray-400" data-testid="link-rename-intro">
                {#if several}
                    Your edit changed {rows.length} names. A ticked rename is made everywhere, and an unticked one changes only the link you edited.
                {:else}
                    You changed a link from "{rows[0].before}" to "{rows[0].after}". Rename "{rows[0].before}" everywhere, or keep just this link?
                {/if}
            </p>

            {#each rows as row, i (row.before)}
                <RenameRow
                    before={row.before}
                    after={row.after}
                    plan={previews[i]}
                    pageless={row.pageless}
                    testIdPrefix="link-rename"
                    label={{ text: "Rename everywhere: ", visible: false }}
                    tick={{ checked: effective[i], locked: locked(row, i), autofocus: i === 0, ontoggle: (checked) => (ticked[i] = checked) }}
                    status={statusOf(row, i)}
                    problem={row.error ?? refusals[i]}
                    problemId="{uid}-error-{i}"
                    showImpact={effective[i] && row.status !== "done"}
                    bind:strategy={strategies[i]}
                    {busy}
                />
            {/each}

            {#if hint}
                <!-- Rule 7: Rename is disabled now, and the reason is in persistent text. -->
                <p id={hintId} class="text-sm text-gray-600 dark:text-gray-400" data-testid="link-rename-nothing-ticked">{hint}</p>
            {/if}

            <!-- The cascade rule (ADR 0038 §2): a scoped concept's name contains its scope's. -->
            <p class="text-sm text-gray-500 dark:text-gray-400">
                Links that use a renamed name as a scope are updated with it - a scoped concept is named by its scope.
            </p>
        </div>
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={onclose}
            disabled={busy}
            data-testid="link-rename-keep"
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40"
        >{started ? "Close" : several ? "Keep links as typed" : "Just this link"}</button>
        <button
            {@attach focusRetryAfterFailure}
            type="submit"
            disabled={busy || toRun === 0}
            aria-describedby={hint ? hintId : undefined}
            data-testid="link-rename-confirm"
            class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
        >{busy ? "Renaming…" : failed ? "Retry" : several ? `Rename ${toRun}` : "Rename"}</button>
    {/snippet}
</Dialog>
