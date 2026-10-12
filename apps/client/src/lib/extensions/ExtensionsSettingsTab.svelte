<script lang="ts">
    /**
     * Settings and Extensions → Extensions (ADR 0121): every extension on this device, whether it is
     * running, and a switch for each. The switch is per device, like spell check's on the Spelling
     * tab, so it applies to every graph here and to none elsewhere. Switching takes effect at once
     * in the open graph: the extension's tabs show that it is off, and come back when it is on.
     *
     * A package the Client could not read is listed too, with every reason, so a missing extension
     * is explained rather than silently absent.
     *
     * An extension's settings (ADR 0134) are drawn under its entry, and can be set while it is off.
     * They are the person's, in every graph, and a note says whether they follow the person to
     * their other devices.
     *
     * **The Extension Directory** (ADR 0123), when the Client has one, lists the reviewed extensions
     * from other Publishers below. Installing asks first, saying what an extension can reach, then
     * starts it at once. The extensions a person installs follow them to their other devices with
     * their settings, and update by themselves (installed-sync.ts): an installed one says where it
     * came from, when it was last updated, a newer release waiting for the next start or for a newer
     * Client, and can be removed, here and on the person's other devices. One installed from the
     * account that this device cannot run yet is listed too, saying why.
     */
    import { onMount, tick } from "svelte";
    import type { Attachment } from "svelte/attachments";
    import { createSubscriber } from "svelte/reactivity";

    import { personSettings, type PersonSettings } from "$lib/person-settings/person-settings";
    import { personSettingsSync, type PersonSettingsSync, type PersonSettingsSyncState } from "$lib/person-settings/person-settings-sync";

    import { compareVersions } from "./catalogue";
    import type { DirectoryState, ExtensionDirectory } from "./directory";
    import { type DirectoryExtension, type DirectoryRelease, isHttpsAddress, newestRelease } from "./directory-format";
    import ExtensionSettingField from "./ExtensionSettingField.svelte";
    import InstallConsent from "./InstallConsent.svelte";
    import type { ExtensionHost, ExtensionStatus } from "./host";
    import { installedIds, type InstalledReport, type InstalledSync } from "./installed-sync";

    const {
        host,
        directory = null,
        installedSync = null,
        settings = personSettings(),
        settingsSync = personSettingsSync(),
    }: { host: ExtensionHost; directory?: ExtensionDirectory | null; installedSync?: InstalledSync | null; settings?: PersonSettings; settingsSync?: PersonSettingsSync } = $props();

    const uid = $props.id();

    // ── The directory's list ────────────────────────────────────────────────────────────────

    /** The list, once read: kept while it is read again, so a retry never blanks it. */
    let directoryState = $state<DirectoryState | null>(null);
    let directoryLoading = $state(false);
    /** Set once a read has taken long enough to say so, so a quick one never flashes a message. */
    let directorySlow = $state(false);
    let loadController: AbortController | null = null;

    async function loadDirectory() {
        if (!directory) return;
        loadController?.abort();
        const controller = new AbortController();
        loadController = controller;
        directoryLoading = true;
        const slow = setTimeout(() => (directorySlow = true), 300);
        try {
            const state = await directory.load(controller.signal);
            if (!controller.signal.aborted) directoryState = state;
        } catch {
            if (!controller.signal.aborted) directoryState = { state: "unavailable", error: "The Client's server could not be reached." };
        } finally {
            clearTimeout(slow);
            if (loadController === controller) {
                directoryLoading = false;
                directorySlow = false;
            }
        }
    }

    // Read as the tab opens, and given up if it closes first.
    onMount(() => {
        void loadDirectory();
        return () => loadController?.abort();
    });

    const listing = $derived(directoryState?.state === "ok" ? directoryState.listing : null);

    // ── The extensions on this device ───────────────────────────────────────────────────────

    const watchHost = createSubscriber((update) => host.subscribe(update));
    // What keeping in step last found for each of the person's extensions.
    const watchReports = createSubscriber((update) => installedSync?.subscribe(update) ?? (() => {}));
    const reports = $derived.by((): Readonly<Record<string, InstalledReport>> => {
        watchReports();
        return installedSync?.reports() ?? {};
    });
    // The extensions the person installed, as their settings say: on this device or not yet.
    const watchSettings = createSubscriber((update) => settings.subscribe(update));
    const intended = $derived.by(() => {
        watchSettings();
        return installedIds(settings);
    });

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
            fromDirectory: entry.installed !== undefined,
            listed: entry.installed ? (listing?.extensions.find((extension) => extension.id === entry.id) ?? null) : null,
            report: reports[entry.id] ?? {},
        }));
    });

    /** The listed extensions the person has not installed, each with the release this Client would install. */
    const available = $derived.by(() => {
        watchHost();
        if (!listing || !directory) return [];
        return listing.extensions
            .filter((extension) => !host.catalogue.extensions.some((entry) => entry.id === extension.id) && !intended.includes(extension.id))
            .map((extension) => ({ extension, release: newestRelease(extension, directory.clientVersion) }));
    });

    /** The person's extensions not on this device: installing from the account, or unable to run here yet. */
    const pending = $derived.by(() => {
        watchHost();
        return intended
            .filter((id) => !host.catalogue.extensions.some((entry) => entry.id === id))
            .map((id) => ({ id, name: listing?.extensions.find((extension) => extension.id === id)?.displayName ?? id, report: reports[id] ?? {} }));
    });

    /** What a report says about an extension that is not running here, or null while it is being installed. */
    function pendingNote(report: InstalledReport): string | null {
        // Nothing is installed while the list cannot be read, so say that rather than "Installing".
        if (directoryState?.state === "off") return "This EtherPK has no Extension Directory, so it can't be installed here.";
        if (directoryState?.state === "unavailable") return "It installs here once the Extension Directory can be read.";
        if (report.failure) return `It couldn't be installed on this device: ${report.failure}`;
        if (report.unlisted) return "It is no longer in the Extension Directory, so it can't run.";
        if (report.waiting) {
            const needs = `Version ${report.waiting.version} needs EtherPK ${report.waiting.needs} or later. This is ${directory?.clientVersion}.`;
            return report.withdrawn ? `The release on this device was taken out of the Extension Directory, so it stopped. ${needs}` : needs;
        }
        return null;
    }

    function formatDate(time: number): string {
        return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "long" });
    }

    /** The oldest Client any of an extension's releases runs on. */
    function lowestNeeded(extension: DirectoryExtension): string {
        return [...extension.releases].sort((a, b) => compareVersions(a.minClientVersion, b.minClientVersion))[0]?.minClientVersion ?? "";
    }

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

    // ── Installing, updating and removing ───────────────────────────────────────────────────

    /** The listed extension whose install is being confirmed. */
    let confirming = $state<string | null>(null);
    /** The ids being installed, so a second press waits for the first. */
    let busy = $state<Record<string, true>>({});
    /** Why the last install of each id failed. */
    let failures = $state<Record<string, string>>({});
    /** Set while keeping in step is asked to try again, so a second press waits for it. */
    let retrying = $state(false);
    /** The last outcome, read out by assistive technology. */
    let announcement = $state("");
    let rowList = $state<HTMLElement | null>(null);
    let directoryList = $state<HTMLElement | null>(null);
    let directoryHeading = $state<HTMLElement | null>(null);

    function without<T>(record: Record<string, T>, id: string): Record<string, T> {
        const { [id]: _removed, ...rest } = record;
        return rest;
    }

    async function install(extension: DirectoryExtension, release: DirectoryRelease) {
        if (!directory || busy[extension.id]) return;
        busy = { ...busy, [extension.id]: true };
        failures = without(failures, extension.id);
        try {
            await directory.install(extension, release);
            confirming = null;
            announcement = `${extension.displayName} is installed.`;
            // The row it moved to takes the keyboard, since the button that was pressed is gone.
            await tick();
            rowList?.querySelector<HTMLElement>(`[data-extension="${CSS.escape(extension.id)}"]`)?.focus();
        } catch (error) {
            failures = { ...failures, [extension.id]: error instanceof Error ? error.message : String(error) };
        } finally {
            busy = without(busy, extension.id);
        }
    }

    async function remove(id: string, name: string) {
        if (!directory || busy[id]) return;
        directory.remove(id);
        failures = without(failures, id);
        announcement = `${name} was removed. You can install it again from the Extension Directory.`;
        await tick();
        directoryHeading?.focus();
    }

    /** Read the list again and try what keeping in step could not do. */
    async function retry() {
        if (!installedSync || retrying) return;
        retrying = true;
        try {
            await installedSync.run();
        } finally {
            retrying = false;
        }
    }

    /** Where the extensions a person installs run, by whether their account syncs. */
    function installsNote(state: PersonSettingsSyncState): string {
        return state === "synced" || state === "syncing"
            ? "One you install runs in every graph, here and on your other devices where you sync with your account. Each updates by itself."
            : "One you install runs in every graph on this device, and on your other devices once you sync a graph. Each updates by itself.";
    }

    /** The confirmation takes the keyboard as it opens, on its Install button. */
    const focusOnOpen: Attachment<HTMLButtonElement> = (button) => {
        button.focus();
    };

    /** Close a confirmation, giving the keyboard back to the row's Install button. */
    async function cancel(id: string) {
        if (busy[id]) return;
        confirming = null;
        await tick();
        directoryList?.querySelector<HTMLElement>(`[data-extension="${CSS.escape(id)}"] [data-testid="directory-install"]`)?.focus();
    }

    /** Esc in a confirmation cancels it, and stays there rather than closing the Settings dialog. */
    function cancelOnEscape(event: KeyboardEvent, id: string) {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        event.preventDefault();
        void cancel(id);
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

    const secondaryButton =
        "rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 aria-disabled:cursor-progress";
    const primaryButton =
        "rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 aria-disabled:cursor-progress";
    const link = "text-sm text-gray-700 underline underline-offset-2 hover:text-gray-950 dark:text-gray-300 dark:hover:text-gray-100";
</script>

<div class="space-y-5" data-testid="extensions-tab">
    <p class="text-sm text-gray-600 dark:text-gray-400">
        Extensions add views, commands and menu rows to EtherPK. Some come with EtherPK{#if directory}, and you can install others from the Extension Directory below{/if}. Switching one off applies to every graph on
        <strong>this device</strong>, and its open tabs say so until it is back on.
    </p>

    <ul class="space-y-4" bind:this={rowList}>
        {#each rows as row (row.id)}
            <li class="border-t border-gray-100 pt-4 first:border-t-0 first:pt-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 dark:border-gray-800" tabindex="-1" data-testid="extension-row" data-extension={row.id}>
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
                {#if row.fromDirectory}
                    <p class="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-origin">
                        From the Extension Directory, where each release is reviewed before it is listed.
                        {#if row.listed && isHttpsAddress(row.listed.repository)}<a class={link} href={row.listed.repository} target="_blank" rel="noopener noreferrer">Source</a>{/if}
                    </p>
                    {#if row.report.updatedAt !== undefined}
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-updated">Updated to {row.version} on {formatDate(row.report.updatedAt)}.</p>
                    {/if}
                    {#if row.report.staged}
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-staged">Version {row.report.staged} runs from the next time EtherPK starts.</p>
                    {/if}
                    {#if row.report.waiting}
                        <p class="mt-1 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-waiting">
                            Version {row.report.waiting.version} needs EtherPK {row.report.waiting.needs} or later. This is {directory?.clientVersion}.
                        </p>
                    {/if}
                    {#if row.report.failure}
                        <p class="mt-1 text-sm text-(--gk-text-warning)" role="alert" data-testid="extension-failure">Its newer release couldn't be fetched: {row.report.failure}</p>
                    {/if}
                    <div class="mt-2 flex flex-wrap items-center gap-2">
                        <button type="button" class={secondaryButton} aria-disabled={busy[row.id] !== undefined} onclick={() => remove(row.id, row.name)} data-testid="extension-remove">Remove</button>
                    </div>
                {/if}
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

    {#if directory}
        <section class="border-t border-gray-100 pt-5 dark:border-gray-800" aria-labelledby="{uid}-directory" data-testid="extension-directory">
            <h3 id="{uid}-directory" class="text-sm font-medium text-gray-950 focus:outline-none dark:text-gray-100" tabindex="-1" bind:this={directoryHeading}>Extension Directory</h3>
            <p class="mt-1 text-sm text-gray-600 dark:text-gray-400" data-testid="extension-directory-note">
                Extensions from other publishers. Each release is reviewed before it is listed. {installsNote(syncState)}
            </p>

            {#if pending.length > 0}
                <ul class="mt-3 space-y-3" data-testid="extension-pending">
                    {#each pending as item (item.id)}
                        {@const note = pendingNote(item.report)}
                        <li class="rounded-lg border border-gray-200 p-3 dark:border-gray-800" data-testid="pending-row" data-extension={item.id}>
                            <p class="text-sm text-gray-950 dark:text-gray-100"><span class="font-medium">{item.name}</span>, installed from your account</p>
                            <p class="mt-1 text-sm {item.report.failure ? 'text-(--gk-text-warning)' : 'text-gray-500 dark:text-gray-400'}" role={item.report.failure ? "alert" : undefined} data-testid="pending-note">
                                {note ?? "Installing on this device…"}
                            </p>
                            <div class="mt-2 flex flex-wrap items-center gap-2">
                                {#if item.report.failure}
                                    <button type="button" class={secondaryButton} aria-disabled={retrying} aria-busy={retrying} onclick={retry} data-testid="pending-retry">{retrying ? "Trying again…" : "Try again"}</button>
                                {/if}
                                <button type="button" class={secondaryButton} onclick={() => remove(item.id, item.name)} data-testid="pending-remove">Remove</button>
                            </div>
                        </li>
                    {/each}
                </ul>
            {/if}

            {#if directoryState === null}
                {#if directorySlow}
                    <p class="mt-3 text-sm text-gray-500 dark:text-gray-400" role="status" data-testid="extension-directory-loading">Loading the Extension Directory…</p>
                {/if}
            {:else if directoryState.state === "off"}
                <p class="mt-3 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-directory-off">This EtherPK has no Extension Directory, so there are no other extensions to install.</p>
            {:else if directoryState.state === "unavailable"}
                <div class="mt-3 space-y-2" role="alert" data-testid="extension-directory-unavailable">
                    <p class="text-sm text-(--gk-text-warning)">The Extension Directory couldn't be read: {directoryState.error}</p>
                    <button type="button" class={secondaryButton} aria-disabled={directoryLoading} aria-busy={directoryLoading} onclick={() => !directoryLoading && loadDirectory()} data-testid="extension-directory-retry">
                        {directoryLoading ? "Trying again…" : "Try again"}
                    </button>
                </div>
            {:else if available.length === 0}
                <p class="mt-3 text-sm text-gray-500 dark:text-gray-400" data-testid="extension-directory-empty">
                    {listing && listing.extensions.length > 0 ? "Every extension the directory lists is installed." : "No extensions are listed yet."}
                </p>
            {:else}
                <ul class="mt-3 space-y-4" bind:this={directoryList}>
                    {#each available as item (item.extension.id)}
                        {@const extension = item.extension}
                        {@const release = item.release}
                        <li class="rounded-lg border border-gray-200 p-3 dark:border-gray-800" data-testid="directory-row" data-extension={extension.id}>
                            <p class="text-sm text-gray-950 dark:text-gray-100">
                                <span class="font-medium">{extension.displayName}</span>
                                <span class="text-gray-500 dark:text-gray-400">{release?.version ?? extension.releases[0].version}, by {extension.publisher}</span>
                            </p>
                            {#if extension.description}
                                <p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{extension.description}</p>
                            {/if}
                            <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                                {#if isHttpsAddress(extension.repository)}<a class={link} href={extension.repository} target="_blank" rel="noopener noreferrer">Source</a>,{/if}
                                {extension.license} licence
                            </p>
                            {#if !release}
                                <p class="mt-2 text-sm text-gray-500 dark:text-gray-400" data-testid="directory-needs">Needs EtherPK {lowestNeeded(extension)} or later.</p>
                            {:else if confirming === extension.id}
                                <div class="mt-3 space-y-2 border-l-2 border-gray-300 pl-3 dark:border-gray-700" role="group" aria-labelledby="{uid}-confirm-{extension.id}" data-testid="directory-confirm">
                                    <InstallConsent name={extension.displayName} id="{uid}-confirm-{extension.id}" />
                                    <div class="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            class={primaryButton}
                                            aria-disabled={busy[extension.id] !== undefined}
                                            aria-busy={busy[extension.id] !== undefined}
                                            onclick={() => install(extension, release)}
                                            onkeydown={(event) => cancelOnEscape(event, extension.id)}
                                            {@attach focusOnOpen}
                                            data-testid="directory-install-confirm"
                                        >
                                            {busy[extension.id] ? "Installing…" : `Install ${extension.displayName}`}
                                        </button>
                                        <button
                                            type="button"
                                            class={secondaryButton}
                                            aria-disabled={busy[extension.id] !== undefined}
                                            onclick={() => cancel(extension.id)}
                                            onkeydown={(event) => cancelOnEscape(event, extension.id)}
                                            data-testid="directory-install-cancel">Cancel</button
                                        >
                                    </div>
                                    {#if failures[extension.id]}
                                        <p class="text-sm text-(--gk-text-warning)" role="alert" data-testid="directory-failure">{extension.displayName} wasn't installed: {failures[extension.id]}</p>
                                    {/if}
                                </div>
                            {:else}
                                <button type="button" class="{secondaryButton} mt-2" onclick={() => (confirming = extension.id)} data-testid="directory-install">Install</button>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}

    <p class="sr-only" role="status" aria-live="polite" data-testid="extensions-announcement">{announcement}</p>
</div>
