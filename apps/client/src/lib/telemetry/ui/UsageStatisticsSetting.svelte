<script lang="ts">
    /**
     * The usage statistics switch at the foot of the Settings modal's General tab (ADR 0187), with
     * a link to the privacy page that says what is sent.
     *
     * The setting applies the moment it changes and is the person's, not the graph's, so the
     * General tab's Save has nothing to commit for it. It renders inside that tab's form, so the
     * checkbox has no name and submits nothing.
     */
    import { page } from "$app/state";
    import { createSubscriber } from "svelte/reactivity";

    import { usageStatistics } from "../usage-statistics-device";

    const statistics = usageStatistics();
    // The setting lives outside Svelte; reading it subscribes, so the switch follows a change made
    // in another tab or on another device.
    const watchSetting = createSubscriber((update) => statistics.subscribe(update));
    const current = $derived.by(() => {
        watchSetting();
        return statistics.state();
    });
    // The deployment's privacy page (`legalLinks` from the root layout); null where it has none.
    const privacyUrl = $derived<string | null>(page.data.legalLinks?.privacyUrl ?? null);
</script>

<div class="border-t border-neutral-100 dark:border-neutral-800 pt-4" data-testid="usage-statistics-setting">
    <label class="flex items-start gap-2 text-sm text-neutral-950 dark:text-neutral-100">
        <input
            type="checkbox"
            checked={current !== "off"}
            onchange={(e) => statistics.setEnabled(e.currentTarget.checked)}
            aria-describedby="usage-statistics-help"
            data-testid="usage-statistics-enabled"
            class="mt-0.5 h-4 w-4 rounded border-neutral-300 dark:border-neutral-700"
        />
        <span>Send usage statistics</span>
    </label>
    <p id="usage-statistics-help" class="mt-1.5 text-sm text-neutral-500 dark:text-neutral-400">
        EtherPK counts how its features are used, to decide what to work on. It never sends your notes, names or
        searches. This setting is yours, not the graph's: it applies at once, on this device and on your other
        devices when your account syncs a graph.
        {#if privacyUrl}
            The <a
                href="{privacyUrl}#usage-statistics"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="usage-statistics-privacy-link"
                class="font-medium text-(--gk-accent) underline underline-offset-2">privacy policy</a
            > says what is sent.
        {/if}
    </p>
    {#if current === "browser-signal"}
        <!-- Persistent text, not a disabled box: the setting is still theirs to change. -->
        <p role="status" class="mt-1.5 text-sm text-neutral-950 dark:text-neutral-100" data-testid="usage-statistics-browser-signal">
            Your browser sends the Global Privacy Control signal, so nothing is sent from this browser whatever this
            is set to.
        </p>
    {/if}
</div>
