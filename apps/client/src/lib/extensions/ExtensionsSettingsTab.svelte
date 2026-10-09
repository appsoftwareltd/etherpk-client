<script lang="ts">
    /**
     * Settings and Extensions → Extensions (ADR 0121): every extension this Client ships, whether it
     * is running, and a switch for each. The switch is per device, like spell check's on the
     * Spelling tab, so it applies to every graph here and to none elsewhere. Switching takes effect at once in the open
     * graph: the extension's tabs show that it is off, and come back when it is switched on.
     *
     * A package the Client could not read is listed too, with every reason, so a missing extension
     * is explained rather than silently absent.
     *
     * An extension's settings (ADR 0134) are drawn under its entry, and can be set while it is off.
     * They are the person's, in every graph, and a note says whether they follow the person to
     * their other devices.
     */
    import { createSubscriber } from "svelte/reactivity";

    import { personSettings, type PersonSettings } from "$lib/person-settings/person-settings";
    import { personSettingsSync, type PersonSettingsSync, type PersonSettingsSyncState } from "$lib/person-settings/person-settings-sync";

    import ExtensionSettingField from "./ExtensionSettingField.svelte";
    import type { ExtensionHost, ExtensionStatus } from "./host";

    const {
        host,
        settings = personSettings(),
        settingsSync = personSettingsSync(),
    }: { host: ExtensionHost; settings?: PersonSettings; settingsSync?: PersonSettingsSync } = $props();

    const watchHost = createSubscriber((update) => host.subscribe(update));
    const rows = $derived.by(() => {
        watchHost();
        return host.catalogue.extensions.map((entry) => ({
            id: entry.id,
            name: entry.package.manifest.displayName,
            publisher: entry.package.manifest.publisher,
            version: entry.package.version,
            description: entry.package.description,
            on: host.isOn(entry.id),
            status: host.status(entry.id),
            settings: entry.package.manifest.settings ?? [],
        }));
    });

    const watchSync = createSubscriber((update) => settingsSync.subscribe(update));
    const syncState = $derived.by(() => {
        watchSync();
        return settingsSync.state();
    });

    // Looking again as the tab opens, so a device whose keys were unlocked since says so.
    $effect(() => {
        void settingsSync.sync();
    });

    /** The ids whose switch is being applied, so a second press waits for the first. */
    let switching = $state<string[]>([]);

    async function toggle(id: string, on: boolean) {
        if (switching.includes(id)) return;
        switching = [...switching, id];
        try {
            await host.setOn(id, on);
        } finally {
            switching = switching.filter((pending) => pending !== id);
        }
    }

    function describe(status: ExtensionStatus): string {
        switch (status.state) {
            case "off":
                return "Off on this device.";
            case "idle":
                return "On. It starts when a graph opens.";
            case "starting":
                return "Starting…";
            case "running":
                return "Running in this graph.";
            case "failed":
                return `Could not start: ${status.message}`;
        }
    }

    function syncNote(state: PersonSettingsSyncState): string {
        switch (state) {
            case "device":
                return "Kept on this device. Once you sync a graph, your settings follow you to your other devices.";
            case "locked":
                return "Kept on this device. They sync with your account once your Encryption Keys are unlocked here.";
            case "syncing":
                return "Syncing with your account…";
            case "synced":
                return "Saved with your account, so they follow you to your other devices.";
            case "waiting":
                return "Kept on this device until your account can be reached, and then synced with it.";
        }
    }
</script>

<div class="space-y-5" data-testid="extensions-tab">
    <p class="text-sm text-gray-600 dark:text-gray-400">
        Extensions add views, commands and menu rows to EtherPK. These come with EtherPK. Switching one off applies to every graph on
        <strong>this device</strong>, and its open tabs say so until it is back on.
    </p>

    <ul class="space-y-4">
        {#each rows as row (row.id)}
            <li class="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0 dark:border-gray-800" data-testid="extension-row" data-extension={row.id}>
                <label class="flex items-start gap-2 text-sm text-gray-950 dark:text-gray-100">
                    <input
                        type="checkbox"
                        checked={row.on}
                        disabled={switching.includes(row.id)}
                        onchange={(e) => toggle(row.id, (e.currentTarget as HTMLInputElement).checked)}
                        data-testid="extension-switch"
                        class="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-700"
                    />
                    <span>
                        <span class="font-medium">{row.name}</span>
                        <span class="text-gray-500 dark:text-gray-400">{row.version}, by {row.publisher}</span>
                    </span>
                </label>
                {#if row.description}
                    <p class="mt-1.5 text-sm text-gray-600 dark:text-gray-400">{row.description}</p>
                {/if}
                <p
                    class="mt-1 text-sm {row.status.state === 'failed' ? 'text-(--gk-text-warning)' : 'text-gray-500 dark:text-gray-400'}"
                    role={row.status.state === "failed" ? "alert" : undefined}
                    data-testid="extension-status"
                >
                    {describe(row.status)}
                </p>
                {#if row.settings.length > 0}
                    <details class="mt-2" data-testid="extension-settings">
                        <summary class="cursor-pointer text-sm font-medium text-gray-950 dark:text-gray-100">Settings</summary>
                        <div class="mt-3 space-y-4 border-l-2 border-gray-100 pl-3 dark:border-gray-800">
                            {#each row.settings as setting (setting.id)}
                                <ExtensionSettingField extensionId={row.id} {setting} {settings} />
                            {/each}
                            <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="extension-settings-sync" data-state={syncState}>{syncNote(syncState)}</p>
                        </div>
                    </details>
                {/if}
            </li>
        {/each}
    </ul>

    {#if host.catalogue.broken.length > 0}
        <div class="border-t border-gray-100 pt-4 dark:border-gray-800" data-testid="extensions-broken">
            <h3 class="text-sm font-medium text-gray-950 dark:text-gray-100">Extensions that could not be read</h3>
            <ul class="mt-2 space-y-2">
                {#each host.catalogue.broken as broken (broken.where)}
                    <li class="text-sm text-gray-600 dark:text-gray-400">
                        <span class="font-medium text-gray-950 dark:text-gray-100">{broken.where}</span>: {broken.errors.join(" ")}
                    </li>
                {/each}
            </ul>
        </div>
    {/if}
</div>
