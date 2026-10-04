<script lang="ts">
    /**
     * TEMPORARY (ADR 0061, amended 2026-10-03): the one-off repair that shows the aliases a synced
     * graph hid before an alias was always shown in its page's frontmatter. Remove it, with the
     * Server store's `revealHiddenAliases`, once every synced graph has run it (see the Roadmap).
     *
     * It only adds an `aliases` line, and running it again finds nothing, so it acts at once with no
     * confirmation. Documents it had to skip are named with what to do about them.
     */
    import type { HiddenAliasesReport } from "$lib/storage/server/server-document-store";

    let { onreveal }: { onreveal: () => Promise<HiddenAliasesReport> } = $props();

    const uid = $props.id();
    let running = $state(false);
    let report = $state<HiddenAliasesReport | null>(null);
    let error = $state<string | null>(null);

    const nothingFound = $derived(
        report !== null && report.revealed.length === 0 && report.unreadable.length === 0 && report.unconfirmed.length === 0,
    );

    const count = (n: number) => (n === 1 ? "1 document" : `${n} documents`);

    async function reveal() {
        if (running) return;
        running = true;
        error = null;
        // A report from an earlier run would read as this run's beside a failure.
        report = null;
        try {
            report = await onreveal();
        } catch (e) {
            // As a sentence, so the line around it reads whichever way the message ends.
            const message = (e instanceof Error ? e.message : String(e)).trim();
            error = /[.!?]$/.test(message) ? message : `${message}.`;
        } finally {
            running = false;
        }
    }
</script>

<section class="space-y-2" aria-labelledby="{uid}-heading" data-testid="hidden-aliases-section">
    <h3 id="{uid}-heading" class="text-sm font-medium text-gray-500 dark:text-gray-400">Hidden aliases</h3>
    <p class="text-sm text-gray-600 dark:text-gray-300">
        A page given an alias before EtherPK always showed aliases in frontmatter can answer to a name you can't
        see on it. This adds an aliases line to each such page, so every name a page answers to is on the page.
        Running it again is safe.
    </p>
    <button
        type="button"
        onclick={reveal}
        disabled={running}
        data-testid="hidden-aliases-reveal"
        class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
        >{running ? "Showing hidden aliases…" : "Show hidden aliases"}</button
    >
    <!-- The outcome, report or failure, is announced once, when a run finishes; it says nothing while idle. -->
    <div role="status" class="space-y-1 text-sm text-gray-600 dark:text-gray-300" data-testid="hidden-aliases-result">
        {#if report}
            {#if nothingFound}
                <p>No document has hidden aliases.</p>
            {:else if report.revealed.length > 0}
                <p>
                    {count(report.revealed.length)}
                    {report.revealed.length === 1 ? "now shows its aliases" : "now show their aliases"} in frontmatter.
                </p>
            {/if}
            {#if report.unreadable.length > 0}
                <p data-testid="hidden-aliases-unreadable">
                    Skipped {count(report.unreadable.length)} whose frontmatter does not parse: {report.unreadable.join(", ")}.
                    Fix the frontmatter and run this again.
                </p>
            {/if}
            {#if report.unconfirmed.length > 0}
                <p data-testid="hidden-aliases-unconfirmed">
                    Skipped {count(report.unconfirmed.length)} that {report.unconfirmed.length === 1 ? "has" : "have"} not finished
                    syncing to this device: {report.unconfirmed.join(", ")}. Run this again once sync has caught up.
                </p>
            {/if}
        {/if}
        {#if error}
            <p class="text-red-600" data-testid="hidden-aliases-error">
                Couldn't show hidden aliases. {error} Press the button to try again.
            </p>
        {/if}
    </div>
</section>
