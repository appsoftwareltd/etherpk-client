<script lang="ts">
    /**
     * The **Privacy** tab of the Settings modal (ADR 0187): whether the Client sends usage
     * statistics, every event it can send (from `usage-catalogue.ts`), and the events this page
     * has sent.
     *
     * The setting applies the moment it changes and is the person's, not the graph's, so there is
     * nothing for the dialog's Save to commit. Renders into someone else's form, so the checkbox
     * is the only input and the list is a `<details>`, which submits nothing.
     */
    import { createSubscriber } from "svelte/reactivity";

    import { USAGE_CATALOGUE } from "../usage-catalogue";
    import { usageStatistics } from "../usage-statistics-device";

    const statistics = usageStatistics();
    // The setting and the sent list live outside Svelte; each read below subscribes, so the tab
    // follows a change made in another tab, on another device, or a batch going out.
    const watchSetting = createSubscriber((update) => statistics.subscribe(update));
    const watchSent = createSubscriber((update) => statistics.subscribeSent(update));
    const current = $derived.by(() => {
        watchSetting();
        return statistics.state();
    });
    const sent = $derived.by(() => {
        watchSent();
        // Newest first: the one just sent is what someone opening this list is looking for.
        return [...statistics.sent()].reverse();
    });

    const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const describe = (data: Record<string, string> | undefined) =>
        Object.entries(data ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join(", ");
</script>

<div class="space-y-4" data-testid="privacy-tab">
    <div>
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
            EtherPK counts how its features are used, to decide what to work on. The setting is yours: it applies on
            <strong>this device</strong>, and on your other devices when your account syncs a graph.
        </p>
        {#if current === "browser-signal"}
            <!-- Persistent text, not a disabled box: the setting is still theirs to change. -->
            <p role="status" class="mt-1.5 text-sm text-neutral-950 dark:text-neutral-100" data-testid="usage-statistics-browser-signal">
                Your browser sends the Global Privacy Control signal, so nothing is sent from this browser whatever
                this is set to.
            </p>
        {/if}
    </div>

    <div class="border-t border-neutral-100 dark:border-neutral-800 pt-4">
        <h3 class="text-sm font-medium text-neutral-950 dark:text-neutral-100">What is sent</h3>
        <p class="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
            Each event below, with the time it happened. They are sent together about once a minute, and when you
            switch away from the app.
        </p>
        <ul class="mt-2 space-y-2 text-sm text-neutral-600 dark:text-neutral-400" data-testid="usage-statistics-catalogue">
            {#each USAGE_CATALOGUE as entry (entry.label)}
                <li>
                    <code class="text-neutral-950 dark:text-neutral-100">{entry.label}</code>: {entry.when}
                    {#if Object.keys(entry.properties).length > 0}
                        With {Object.values(entry.properties)
                            .map((property) => property.meaning)
                            .join("; ")}.
                    {/if}
                </li>
            {/each}
        </ul>
        <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            The service that counts them reads your browser, operating system and country from the request, and does
            not keep the address it came from.
        </p>

        <h3 class="mt-4 text-sm font-medium text-neutral-950 dark:text-neutral-100">What is not sent</h3>
        <p class="mt-1.5 text-sm text-neutral-600 dark:text-neutral-400">
            Your notes, page names, graph names, file names, searches, account and the address of this server. EtherPK
            keeps nothing on this device for counting, and sets no cookie for it.
        </p>
    </div>

    <details class="border-t border-neutral-100 dark:border-neutral-800 pt-4" data-testid="usage-statistics-sent">
        <summary class="cursor-pointer text-sm font-medium text-neutral-950 dark:text-neutral-100">
            Sent since this page opened ({sent.length})
        </summary>
        {#if sent.length === 0}
            <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                Nothing yet. Events are sent about once a minute.
            </p>
        {:else}
            <ol class="mt-2 max-h-60 space-y-1 overflow-y-auto text-sm text-neutral-600 dark:text-neutral-400">
                {#each sent as event, index (index)}
                    <li>
                        <span class="tabular-nums">{time.format(event.at)}</span>
                        <code class="text-neutral-950 dark:text-neutral-100">{event.name}</code>
                        {describe(event.data)}
                    </li>
                {/each}
            </ol>
        {/if}
    </details>
</div>
