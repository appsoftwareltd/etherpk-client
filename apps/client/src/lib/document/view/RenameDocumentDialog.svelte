<script lang="ts">
    /**
     * A page's rename dialog (ADR 0037), for Rename… from a menu and for a title edited in the
     * frontmatter (ADR 0061). It does not choose for the user: renaming a page leaves every
     * `[[Old Name]]` pointing at a concept with no page behind it, and neither fix is right often
     * enough to impose. The renames a link edit proposes have a dialog of their own
     * (`LinkRenameDialog.svelte`, ADR 0065), and the two read a typed name the same way (ADR 0065,
     * amended 2026-10-04).
     *
     * The page always takes the name typed: its row has no tick. A new name that changes one of the
     * page's scopes, `[[App Software]] Project` to `[[App Software 2]] Project`, changes a name other
     * documents use, and each such scope has a row of its own, ticked by default: a ticked scope is
     * renamed everywhere (its cascade carrying every page it scopes), an unticked one is left as it
     * is. "Rename just this page" runs the page's row alone. A title edit has no name field: the
     * name was typed in the editor, as a link's is.
     *
     * The reference count is what makes the choice informed rather than a coin toss - "412
     * documents link to this" reads very differently from "3". A [[Pageless Concept]] gets no
     * choice (ADR 0064): there is no document to hold an alias, so renaming one IS the rewrite.
     *
     * States: plans being computed, a name the store refuses (Rename off, the reason in place),
     * running (busy; dismissal refused), and a failed run (each row marked renamed, failed with its
     * reason, or not started; Retry runs the rest, Close keeps what is done). A run that completes
     * closes the dialog.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import type { RenameLinkStrategy, RenamePlan } from "$lib/storage/rename";

    import { type LinkRenameChoice, type LinkRenameRow, previewPlans, type RunStatus } from "./link-renames";
    import RenameRow from "./RenameRow.svelte";

    let {
        concept,
        plan,
        pageless = false,
        busy = false,
        error = null,
        initialName,
        scopeRows = [],
        pageStatus = "waiting",
        onpreview,
        onconfirm,
        oncancel,
    }: {
        concept: string;
        /** What renaming the page to the name typed would do, or null while it is being computed. */
        plan: RenamePlan | null;
        /**
         * The concept has no document - a [[Draft]] nothing has been typed into. Known by the
         * caller from the outset, so the strategy choice never flickers in and then out while
         * the plan is computed.
         */
        pageless?: boolean;
        /**
         * A name already chosen - typed into the document's frontmatter (ADR 0061). The dialog
         * says it was typed there, offers no field to change it, and Cancel puts the old name back
         * in the block.
         */
        initialName?: string;
        busy?: boolean;
        /** Why the page's own rename failed. */
        error?: string | null;
        /** The scopes the name typed renames that other documents use (ADR 0065, amended 2026-10-04). */
        scopeRows?: LinkRenameRow[];
        /** How the page's own rename went, once a run has started. */
        pageStatus?: RunStatus;
        /** Recompute the impact for a candidate name (debounced by the dialog). */
        onpreview: (candidate: string) => void;
        /** Rename the page to `next`, then each scope ticked in `scopes`, in order. */
        onconfirm: (next: string, strategy: RenameLinkStrategy, scopes: LinkRenameChoice[]) => void;
        oncancel: () => void;
    } = $props();

    /** Long enough not to re-plan on every keystroke over a large graph. */
    const PREVIEW_DEBOUNCE_MS = 200;

    let open = $state(true);
    // Mounted fresh per rename, so the initial value is the whole story.
    // svelte-ignore state_referenced_locally
    let name = $state(initialName ?? concept);
    // Updating the links is the default (RenameImpact.svelte says why).
    let strategy = $state<RenameLinkStrategy>("rewrite");
    /**
     * The choices for the scope rows, by the scope's name: the rows follow the name as it is typed,
     * and a row that comes back keeps what was chosen for it.
     */
    let unticked = $state<Record<string, boolean>>({});
    let scopeStrategies = $state<Record<string, RenameLinkStrategy>>({});
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    const uid = $props.id();
    const errorId = `${uid}-error`;
    const hintId = `${uid}-hint`;

    const fromTitle = $derived(initialName !== undefined);
    const unchanged = $derived(name.trim() === "" || name.trim() === concept);
    /**
     * A name the store will not take - a Protected Document's, which nothing may merge into
     * (ADR 0062), or a day, which is its journal entry's name and never a page's (ADR 0056).
     * Shown where a failed rename's error goes, and Rename is disabled on it, so the refusal is
     * read before the button rather than after.
     */
    const refusal = $derived(plan?.refusal ?? null);
    const scopeRefusals = $derived(scopeRows.map((row) => row.plan?.refusal ?? null));
    /** Whether each scope row will run: ticked, and not refused. */
    const scopeEffective = $derived(scopeRows.map((row, i) => !unticked[row.before] && scopeRefusals[i] === null));
    /** The page's row is above every scope row and always runs, so their previews leave it out. */
    const previews = $derived(
        previewPlans([{ plan, ticked: true }, ...scopeRows.map((row, i) => ({ plan: row.plan, ticked: scopeEffective[i] }))]),
    );
    const started = $derived(pageStatus !== "waiting" || scopeRows.some((row) => row.status !== "waiting"));
    const failed = $derived(pageStatus === "failed" || scopeRows.some((row) => row.status === "failed"));
    const blocked = $derived(busy || (!started && (unchanged || refusal !== null)));

    function strategyOf(scope: string): RenameLinkStrategy {
        return scopeStrategies[scope] ?? "rewrite";
    }

    function schedulePreview() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewTimer = undefined;
            const candidate = name.trim();
            if (candidate !== "") onpreview(candidate);
        }, PREVIEW_DEBOUNCE_MS);
    }

    /** The scope rows as chosen, or every one left out for "Rename just this page". */
    function choices(justThisPage: boolean): LinkRenameChoice[] {
        return scopeRows.map((row, i) => ({
            ticked: !justThisPage && scopeEffective[i],
            strategy: row.pageless ? "rewrite" : strategyOf(row.before),
        }));
    }

    function confirm(justThisPage = false) {
        // Guarded here as well as on the button: Enter in the form reaches this too.
        if (blocked) return;
        // A pageless concept has nothing to alias: renaming it is the rewrite (ADR 0064).
        onconfirm(name.trim(), pageless ? "rewrite" : strategy, choices(justThisPage));
    }

    function close() {
        open = false;
        oncancel();
    }

    function statusOf(status: RunStatus, runs: boolean): string | null {
        if (status === "done") return "Renamed";
        if (status === "failed") return null; // the reason is shown instead
        return started && runs ? "Not started" : null;
    }

    /**
     * Enter on a tick or a radio confirms, as it does in the name field: a browser does not submit
     * a form from them.
     */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== "Enter" || event.isComposing) return;
        if (!(event.target instanceof HTMLInputElement) || (event.target.type !== "checkbox" && event.target.type !== "radio")) return;
        event.preventDefault();
        confirm();
    }

    /** After a failed run, focus goes to Retry (rule 6): the failed row says why, beside it. */
    function focusRetryAfterFailure(button: HTMLButtonElement): void {
        if (failed && !busy) button.focus();
    }
</script>

<Modal {open} title="Rename" size={scopeRows.length > 0 ? "lg" : undefined} testId="rename-dialog" busy={busy} busyReason="Renaming…" onclose={close} onsubmit={() => confirm()}>
    {#snippet body()}
        <div>
            {#if fromTitle}
                <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="rename-from-frontmatter">
                    You changed this page's title in its frontmatter. Cancel puts "{concept}" back.
                </p>
            {:else}
                <label for="rename-name" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">New name</label>
                <input
                    id="rename-name"
                    data-testid="rename-input"
                    bind:value={name}
                    autocomplete="off"
                    readonly={started}
                    oninput={schedulePreview}
                    aria-invalid={error || refusal ? "true" : undefined}
                    aria-describedby={error || refusal ? errorId : unchanged ? hintId : undefined}
                    class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error || refusal
                        ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                        : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                />
            {/if}
            {#if error || refusal}
                <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="rename-error">{error ?? refusal}</p>
            {:else if unchanged && !fromTitle}
                <!-- Rule 7: Rename is disabled here, and a native disabled button is not
                     focusable, so the reason cannot live on its tooltip. -->
                <p id={hintId} class="mt-1.5 text-sm text-gray-500 dark:text-gray-400" data-testid="rename-unchanged-hint">
                    Enter a name different from the current one.
                </p>
            {/if}
        </div>

        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div class="space-y-4" onkeydown={onKeydown} role="group" aria-label="What the rename changes">
        <!-- The page's own row: a plain Rename… reads as it always has, the impact under the name. -->
        <RenameRow
            before={concept}
            after={name.trim()}
            plan={previews[0]}
            {pageless}
            testIdPrefix="rename-page"
            label={{ text: "This page: ", visible: scopeRows.length > 0 }}
            showNames={fromTitle || scopeRows.length > 0}
            framed={scopeRows.length > 0}
            status={statusOf(pageStatus, true)}
            problemId={errorId}
            showImpact={pageStatus !== "done"}
            bind:strategy
            {busy}
        />

        {#if scopeRows.length > 0 && !unchanged}
            <p class="text-sm text-gray-600 dark:text-gray-400" data-testid="rename-scope-intro">
                {#if scopeRows.length === 1}
                    The new name changes "{scopeRows[0].before}", which other documents use. Rename it everywhere, or rename just this page?
                {:else}
                    The new name changes {scopeRows.length} names that other documents use. A ticked name is renamed everywhere, and an unticked one is left as it is.
                {/if}
            </p>
            {#each scopeRows as row, i (row.before)}
                <RenameRow
                    before={row.before}
                    after={row.after}
                    plan={previews[i + 1]}
                    pageless={row.pageless}
                    testIdPrefix="rename-scope"
                    label={{ text: "Rename everywhere: ", visible: false }}
                    tick={{
                        checked: scopeEffective[i],
                        locked: scopeRefusals[i] !== null || row.status === "done" || (started && !scopeEffective[i]),
                        autofocus: false,
                        ontoggle: (checked) => (unticked[row.before] = !checked),
                    }}
                    status={statusOf(row.status, scopeEffective[i])}
                    problem={row.error ?? scopeRefusals[i]}
                    problemId="{uid}-scope-error-{i}"
                    showImpact={scopeEffective[i] && row.status !== "done"}
                    bind:strategy={() => strategyOf(row.before), (value) => (scopeStrategies[row.before] = value)}
                    {busy}
                />
            {/each}
        {/if}
        </div>

        <!-- The cascade rule (ADR 0038 §2): a scoped concept's name contains its scope's. -->
        <p class="text-sm text-gray-500 dark:text-gray-400">
            Links that use a renamed name as a scope are updated with it - a scoped concept is named by its scope.
        </p>
    {/snippet}

    {#snippet footer()}
        <button type="button" onclick={close} disabled={busy} data-testid="rename-cancel" class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40">{started ? "Close" : "Cancel"}</button>
        {#if scopeRows.length > 0 && !started && !unchanged}
            <button
                type="button"
                onclick={() => confirm(true)}
                disabled={blocked}
                data-testid="rename-just-this-page"
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
            >Rename just this page</button>
        {/if}
        <button
            {@attach focusRetryAfterFailure}
            type="submit"
            disabled={blocked}
            aria-describedby={unchanged && !error && !fromTitle ? hintId : undefined}
            data-testid="rename-confirm"
            class="min-w-28 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
        >{busy ? "Renaming…" : failed ? "Retry" : "Rename"}</button>
    {/snippet}
</Modal>
