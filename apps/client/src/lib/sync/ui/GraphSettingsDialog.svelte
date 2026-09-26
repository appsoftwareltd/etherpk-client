<script lang="ts">
    /**
     * The one **Settings** modal, in up to seven tabs.
     *
     * - **General** — the graph name and the shared [[Graph Settings]] (ADR 0031). Both live in
     *   the encrypted root-doc meta map: the name is canonical (any member may rename — it renames
     *   for everyone), the settings are graph-scoped, mirroring the filesystem settings page. The
     *   graph id is shown because names are user-chosen and not unique.
     * - **Spelling** — whether this device checks spelling, the graph's Spelling Languages on this
     *   device, and its shared Graph Dictionary (ADR 0095). Applied as changed, like the next tab.
     * - **Protected Documents** — the per-device lock timings and this device's key affordances.
     * - **Mirror** — synced graphs only: the [[Local Mirror]] (ADR 0008), a plain-Markdown copy in
     *   a folder on this device. It moved here from a toolbar button, which the mobile chrome had
     *   no room for and which showed "Mirroring" with nothing to say where or what that meant.
     * - **Publish** — the graph's [[Publication]]s, their themes and includes, and where each is
     *   published on this device (ADR 0082).
     * - **Maintenance** — rebuild the index, scan for orphaned assets, read the storage footprint.
     *
     * The last tab is deliberately NOT called "Graph": nothing in it is graph content. The
     * [[Derived Index]] is browser-private and never synced, and both controls are actions rather
     * than settings — whereas the General tab holds the actual Graph Settings, which do travel in
     * an [[Export]]. Naming it "Graph" would invert the glossary.
     */
    import { onMount } from "svelte";
    import { normalizeDisplaySize } from "$lib/document";
    import { formatBytes } from "$lib/format-bytes";
    import {
        type AppInstallState,
        type GraphSettings,
        promptInstall,
        subscribeAppInstall,
    } from "$lib/storage";
    import {
        DEFAULT_IMAGE_DISPLAY_SIZE,
        DEFAULT_RECENT_COUNT,
        IMAGE_DISPLAY_SIZE_OFF,
        MAX_RECENT_COUNT,
        MIN_RECENT_COUNT,
        normalizeHexColor,
    } from "$lib/storage/fs/graph-settings";
    import type { GraphAssetTools } from "$lib/storage/fs/asset-orphans";
    import OrphanAssetsSection from "$lib/storage/ui/OrphanAssetsSection.svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import ProtectionSettingsTab from "$lib/document/protection/ui/ProtectionSettingsTab.svelte";
    import SpellingSettingsTab from "$lib/document/spelling/ui/SpellingSettingsTab.svelte";
    import type { SpellingTabProps } from "$lib/document/spelling/ui/spelling-tab";
    import type { ProtectionTabProps } from "$lib/document/protection/ui/protection-tab";
    import type { MirrorTabProps } from "./mirror-tab";
    import type { PublishTabProps } from "./publish-tab";
    import PublishSettingsTab from "./PublishSettingsTab.svelte";
    import { PRESENCE_PALETTE } from "$lib/sync/presence-identity";
    import {
        AGENT_TOOLS,
        type AgentTool,
        type AgentsTabProps,
        diagramsSetupCommand,
        loginCommand,
        publishCommand,
        registerCommand,
        registerFolderCommand,
        semanticSetupCommand,
        tokensPageUrl,
    } from "./agents-tab";
    import { MIRROR_PHASE_LABELS } from "$lib/storage/server/local-mirror";

    let {
        graphId,
        name,
        settings,
        assetTools = null,
        storageInfo = null,
        indexPersisted = null,
        indexPersistenceBlocked = undefined,
        indexProgress = null,
        onrebuildindex = null,
        nameHelp = "Changes the graph name for all members.",
        protection = null,
        spelling = null,
        mirror = null,
        agents = null,
        publish = null,
        folderPath = null,
        tab = undefined,
        onchangetab = undefined,
        onsave,
        onclose,
    }: {
        graphId: string;
        name: string;
        settings: GraphSettings;
        /** Orphaned-asset scan/cleanup; null hides the section (dialog opened outside an open graph). */
        assetTools?: GraphAssetTools | null;
        /** Storage Footprint figures (synced graphs, ADR 0033); null hides the line. */
        storageInfo?: { docBytes: number; assetBytes: number } | null;
        /**
         * Whether this browser can keep the [[Derived Index]] between visits (ADR 0041 §4).
         * Null hides the line; false is where the once-per-device notice sends anyone who
         * wants to check what it meant.
         */
        indexPersisted?: boolean | null;
        /** A held index is temporary and should not be described as unsupported storage. */
        indexPersistenceBlocked?: "held" | "unsupported";
        /** How far a running rebuild has got, for the button's label; null when nothing is known. */
        indexProgress?: { done: number; total: number } | null;
        /**
         * Discard and re-derive the [[Derived Index]] from the documents; null hides the button
         * (no open graph). Resolves once the rebuilt generation is live.
         */
        onrebuildindex?: (() => Promise<void>) | null;
        /** Backend-aware copy under the name field (a filesystem rename is display-only). */
        nameHelp?: string;
        /** Protection tab. Null hides the tab entirely (dialog opened outside an open graph). */
        protection?: ProtectionTabProps | null;
        /** The Spelling tab (ADR 0095); null outside an open graph, where there is nothing to check. */
        spelling?: SpellingTabProps | null;
        /** Mirror tab. Null hides it: a Filesystem graph, or the dialog opened outside an open graph. */
        mirror?: MirrorTabProps | null;
        /** Agents tab (ADR 0070, ADR 0072). Null hides it: the dialog opened outside an open graph. */
        agents?: AgentsTabProps | null;
        /** Publish tab (ADR 0082). Null hides it: the dialog opened outside an open graph. */
        publish?: PublishTabProps | null;
        /**
         * The graph folder's path on this device (folder-path.ts): the remembered value, blank
         * for none, and the folder's leaf name for the hint. Null hides the field: a Server
         * graph, or the dialog opened outside an open graph. Saved with the General tab, but
         * per device - the result carries it separately from the shared settings.
         */
        folderPath?: { path: string; folderName: string } | null;
        /**
         * The tab to be on: the one the address names while the workspace hosts this dialog
         * (ADR 0023, 2026-09-20), which is the tab an entry point asked for, else the one this
         * graph's Settings was last on (remembered per device, 2026-09-19). Followed while open,
         * so the Publish chord or a history step can move an open dialog to another tab.
         * Omitted, or not offered for this graph, lands on General.
         */
        tab?: "general" | "spelling" | "protection" | "mirror" | "agents" | "publish" | "maintenance";
        /**
         * The tab the dialog is on changed: the user picked one (click or arrow keys), or the
         * tab asked for is not offered on this graph and it opened on General instead. The
         * workspace remembers it and keeps the address honest.
         */
        onchangetab?: (tab: "general" | "spelling" | "protection" | "mirror" | "agents" | "publish" | "maintenance") => void;
        onsave: (result: { name: string; settings: GraphSettings; folderPath?: string }) => void;
        onclose: () => void;
    } = $props();

    /** The Storage tools exist only inside an open graph; the /graphs picker opens this dialog too. */
    const showTools = $derived(
        assetTools !== null || storageInfo !== null || indexPersisted !== null,
    );

    let rebuilding = $state(false);
    let rebuilt = $state(false);
    let rebuildError = $state<string | null>(null);

    /** Which agent the register command is spelled for; the serve command is the same for all. */
    let agentTool = $state<AgentTool>("claude");
    /** Which of the two commands was last copied, for the button's "Copied" tick. */
    type AgentCopyKey = "login" | "register" | "semantic" | "diagrams" | "publish";
    let agentCopied = $state<AgentCopyKey | null>(null);
    let agentCopyError = $state<string | null>(null);
    async function copyAgentCommand(which: AgentCopyKey, text: string) {
        agentCopyError = null;
        try {
            await navigator.clipboard.writeText(text);
            agentCopied = which;
            setTimeout(() => {
                if (agentCopied === which) agentCopied = null;
            }, 2000);
        } catch {
            // No clipboard (an insecure context, a denied permission): the text is on screen
            // and selectable, so say that rather than failing silently.
            agentCopyError = "Couldn't copy - select the command and copy it by hand.";
        }
    }

    async function rebuildIndex() {
        if (!onrebuildindex || rebuilding) return;
        rebuilding = true;
        rebuilt = false;
        rebuildError = null;
        try {
            await onrebuildindex();
            rebuilt = true;
        } catch (e) {
            rebuildError = `Rebuild failed: ${(e as Error).message}`;
        } finally {
            rebuilding = false;
        }
    }

    /**
     * Whether this device runs EtherPK as an installed app, and whether the browser has offered
     * to install it. Per device, not per graph: it sits in this dialog because an installed app
     * is what stops a phone's browser clearing the graph data kept here, and this is where
     * someone looks when a graph is slow to open or has gone missing on a device.
     */
    let install = $state<AppInstallState>({
        installed: false,
        promptAvailable: false,
    });
    let installDismissed = $state(false);
    // An external subscription, not derived state: the offer arrives on a window event.
    onMount(() => subscribeAppInstall((next) => (install = next)));

    async function installApp() {
        installDismissed = (await promptInstall()) === "dismissed";
    }

    type Tab = "general" | "spelling" | "protection" | "mirror" | "agents" | "publish" | "maintenance";
    const tabs = $derived(
        [
            { id: "general" as const, label: "General", shown: true },
            { id: "spelling" as const, label: "Spelling", shown: spelling !== null },
            {
                id: "protection" as const,
                label: "Protected Documents",
                shown: protection !== null,
            },
            {
                id: "mirror" as const,
                label: "Mirror and Export",
                shown: mirror !== null,
            },
            { id: "agents" as const, label: "Agents", shown: agents !== null },
            { id: "publish" as const, label: "Publish", shown: publish !== null },
            {
                id: "maintenance" as const,
                label: "Maintenance",
                shown: showTools,
            },
        ].filter((t) => t.shown),
    );
    // The Mirror dot in the toolbar opens this dialog to say something about the mirror, so it
    // has to land on that tab; arriving on General with no hint would be a dead end. A tab this
    // graph does not offer (Mirror on a Filesystem graph, a stale address) falls back to General
    // rather than an empty panel. Derived, not seeded once: the workspace moves an open dialog
    // by changing the prop, and a pick here is an assignment the next prop change overrides.
    let activeTab = $derived<Tab>(tab && tabs.some((t) => t.id === tab) ? tab : "general");

    // Opened on a tab other than the one asked for (the fallback above): say so once, so the
    // workspace can remember General and correct an address that named the other one.
    onMount(() => {
        if (activeTab !== tab) onchangetab?.(activeTab);
    });

    /** A tab the user chose, as opposed to the one the dialog was asked to be on. */
    function selectTab(next: Tab) {
        activeTab = next;
        onchangetab?.(next);
    }

    /**
     * How long ago the folder was last known to match the graph. The whole point of a backup is
     * being able to answer that, and a timestamp nobody can read at a glance does not.
     */
    function agoText(at: number | undefined): string {
        if (!at) return "not yet";
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
        if (seconds < 60) return "just now";
        const minutes = Math.round(seconds / 60);
        if (minutes < 60)
            return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
        const days = Math.round(hours / 24);
        return `${days} day${days === 1 ? "" : "s"} ago`;
    }

    const uid = $props.id();

    /** Left/Right/Home/End across the strip, moving focus with the selection (ARIA tabs). */
    function onTabKeydown(event: KeyboardEvent) {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex((t) => t.id === activeTab);
        const next =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                    tabs.length;
        selectTab(tabs[next].id);
        // The handler sits on each TAB, not the tablist: a tablist is not focusable, so a keydown
        // handler on it would be unreachable by keyboard (and svelte-check says so).
        (event.currentTarget as HTMLElement)
            .closest('[role="tablist"]')
            ?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-tab-${activeTab}`)}`)
            ?.focus();
    }

    let open = $state(true);
    // The dialog is mounted fresh per open; initial values are the whole story.
    // svelte-ignore state_referenced_locally
    let draftName = $state(name);
    // svelte-ignore state_referenced_locally
    // Seeded with the effective value, so an untouched graph shows the 800 it actually uploads at.
    let displaySize = $state(
        settings.defaultMaxImageDisplaySize ?? DEFAULT_IMAGE_DISPLAY_SIZE,
    );
    // svelte-ignore state_referenced_locally
    let codeLanguage = $state(settings.defaultCodeLanguage ?? "");
    // svelte-ignore state_referenced_locally
    let recentCount = $state<number>(
        settings.recentDocumentCount ?? DEFAULT_RECENT_COUNT,
    );
    /**
     * The toolbar colour, or null for the theme's own surface. A colour input cannot be blank,
     * so "no colour" is a state of its own rather than a value of the input: the input shows a
     * neutral stand-in while null, and picking anything sets it. The stand-in is deliberately
     * not the theme colour (the dialog does not know which theme is on) - it is never saved.
     */
    // svelte-ignore state_referenced_locally
    let toolbarColor = $state<string | null>(settings.toolbarColor ?? null);
    const TOOLBAR_COLOR_STAND_IN = "#e5e7eb";
    // svelte-ignore state_referenced_locally
    let draftFolderPath = $state(folderPath?.path ?? "");
    let error = $state<string | null>(null);

    function save() {
        // The shell runs this on Enter in ANY field, and the other tabs have fields of their own —
        // pressing Enter in "New passphrase" would otherwise save the General tab and close the
        // whole modal out from under a half-finished passphrase change.
        if (activeTab !== "general") return;
        error = null;
        if (!draftName.trim()) {
            error = "Give the graph a name.";
            return;
        }
        // Seeded from the current settings, NOT from {}: this dialog does not edit every
        // field it persists. Favourites are Graph Settings too (ADR 0036) and are changed
        // from the Sidebar, so building a fresh object here would silently wipe them.
        const next: GraphSettings = { ...settings };
        delete next.defaultMaxImageDisplaySize;
        delete next.defaultCodeLanguage;
        // Blank ⇒ back to the default; `0` ⇒ no hint at all (natural size); else a real size.
        const trimmedSize = displaySize.trim();
        if (trimmedSize === IMAGE_DISPLAY_SIZE_OFF) {
            next.defaultMaxImageDisplaySize = IMAGE_DISPLAY_SIZE_OFF;
        } else if (trimmedSize !== "") {
            const normalized = normalizeDisplaySize(trimmedSize);
            if (!normalized) {
                error =
                    "Image size: enter a width like 800, width×height like 800x600, or 0 for natural size.";
                return;
            }
            next.defaultMaxImageDisplaySize = normalized;
        }
        const lang = codeLanguage.trim();
        if (lang !== "") next.defaultCodeLanguage = lang;
        if (
            !Number.isInteger(recentCount) ||
            recentCount < MIN_RECENT_COUNT ||
            recentCount > MAX_RECENT_COUNT
        ) {
            error = `Recent documents: enter a whole number between ${MIN_RECENT_COUNT} and ${MAX_RECENT_COUNT}.`;
            return;
        }
        next.recentDocumentCount = recentCount;
        delete next.toolbarColor;
        if (toolbarColor !== null) {
            const hex = normalizeHexColor(toolbarColor);
            if (!hex) {
                error = "Toolbar colour: pick a colour, or use the theme colour.";
                return;
            }
            next.toolbarColor = hex;
        }
        open = false;
        onsave({
            name: draftName.trim(),
            settings: next,
            ...(folderPath ? { folderPath: draftFolderPath.trim() } : {}),
        });
    }

    function close() {
        open = false;
        onclose();
    }
</script>

<!-- Wide: four tabs and a form with help text under every field were cramped at the prompt
     width, and the Maintenance tools wrapped their result lines. A phone is unaffected. -->
<Modal
    {open}
    title="Settings"
    size="xl"
    placement="top"
    onclose={close}
    onsubmit={save}
    tools={activeTab === "maintenance"
        ? storageTools
        : activeTab === "general"
          ? installTools
          : undefined}
>
    {#snippet body()}
        {#if tabs.length > 1}
            <!--
                Below the md breakpoint the strip does not fit: six tabs at phone width scrolled
                the whole dialog sideways. A native select stands in there, the strip above it.
                The options paint their own theme surface - a browser's popup list does not
                inherit the select's dark background, and white options under a dark dialog is a
                thing that has been missed before.
            -->
            <label class="block md:hidden">
                <span class="sr-only">Settings section</span>
                <select
                    value={activeTab}
                    onchange={(event) => selectTab(event.currentTarget.value as Tab)}
                    class="block w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-950 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                    data-testid="settings-tab-select"
                >
                    {#each tabs as entry (entry.id)}
                        <option
                            value={entry.id}
                            class="bg-white text-gray-950 dark:bg-gray-900 dark:text-gray-100"
                            >{entry.label}</option
                        >
                    {/each}
                </select>
            </label>
            <!--
                Real tab semantics, not just the roles. Declaring role="tab" while leaving arrow
                keys unimplemented is worse than plain buttons: it announces a keyboard contract to
                a screen-reader user that the widget does not honour. Roving tabindex keeps the
                strip a single Tab stop, and Left/Right/Home/End move between them.
            -->
            <div
                class="-mt-1 hidden gap-1 border-b border-gray-100 md:flex dark:border-gray-800"
                role="tablist"
                aria-label="Settings sections"
            >
                {#each tabs as entry (entry.id)}
                    <button
                        type="button"
                        role="tab"
                        id="{uid}-tab-{entry.id}"
                        aria-selected={activeTab === entry.id}
                        aria-controls="{uid}-panel"
                        tabindex={activeTab === entry.id ? 0 : -1}
                        data-testid="settings-tab-{entry.id}"
                        onclick={() => selectTab(entry.id)}
                        onkeydown={onTabKeydown}
                        class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors {activeTab ===
                        entry.id
                            ? 'border-gray-900 dark:border-gray-100 text-gray-950 dark:text-gray-100'
                            : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}"
                        >{entry.label}</button
                    >
                {/each}
            </div>
        {/if}

        <div
            id="{uid}-panel"
            role={tabs.length > 1 ? "tabpanel" : undefined}
            aria-labelledby={tabs.length > 1 ? `${uid}-tab-${activeTab}` : undefined}
            class="space-y-4"
        >
            {#snippet mirrorList(
                testId: string,
                summary: string,
                names: string[],
                warn: boolean,
            )}
                <div
                    class="text-sm {warn
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-gray-600 dark:text-gray-400'}"
                >
                    <details data-testid={testId}>
                        <summary class="cursor-pointer">{summary}</summary>
                        <ul
                            data-testid="{testId}-names"
                            class="mt-2 max-h-40 overflow-y-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 p-2 font-mono text-sm"
                        >
                            <!-- Keyed on position as well as name: two documents can hold the same dangling
                     link, and a repeated key would throw where a plain list would simply show both. -->
                            {#each names as name, index (`${index}:${name}`)}
                                <li class="truncate" title={name}>{name}</li>
                            {/each}
                        </ul>
                    </details>
                </div>
            {/snippet}

            {#if activeTab === "spelling" && spelling}
                <SpellingSettingsTab {...spelling} />
            {:else if activeTab === "protection" && protection}
                <ProtectionSettingsTab {...protection} />
            {:else if activeTab === "publish" && publish}
                <!-- Nothing here is a setting the footer saves: each publication card has a Save of
                 its own (it writes a page), and the folder is per device. -->
                <PublishSettingsTab {...publish} />
            {:else if activeTab === "mirror" && mirror}
                {@const exportGraph = mirror.exportGraph}
                <!-- Nothing here is a setting either: choosing a folder starts the mirror at once,
                 and there is nothing for Save to apply, so the footer offers Done. -->
                <div class="space-y-3" data-testid="mirror-tab">
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        A Local Mirror keeps a plain Markdown copy of this graph
                        in a folder you choose, updated as you edit. It is
                        one-way - EtherPK writes to the folder and never reads
                        from it - so it is a readable backup you own, not a
                        second place to edit.
                    </p>
                    {#if mirror.heldElsewhere && !mirror.status}
                        <p
                            role="status"
                            class="text-sm text-gray-950 dark:text-gray-100"
                            data-testid="mirror-held-elsewhere"
                        >
                            Another tab of this browser is mirroring this graph.
                            Only one tab writes to the folder at a time; this
                            one takes over by itself if that tab closes.
                        </p>
                        <div class="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onclick={mirror.onstop}
                                data-testid="mirror-stop"
                                class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                >Stop mirroring</button
                            >
                        </div>
                    {:else if mirror.status}
                        <p
                            role="status"
                            class="text-sm text-gray-950 dark:text-gray-100"
                            data-testid="mirror-status"
                        >
                            {#if mirror.status.paused}
                                Mirroring to <strong
                                    >{mirror.status.folder}</strong
                                >
                                has stopped.
                                {mirror.status.paused.message}
                            {:else if mirror.status.syncing}
                                Writing to <strong
                                    >{mirror.status.folder}</strong
                                >.
                                {#if mirror.status.pass && mirror.status.pass.progress.total > 0}
                                    {MIRROR_PHASE_LABELS[
                                        mirror.status.pass.progress.phase
                                    ]}:
                                    {mirror.status.pass.progress.done} of {mirror
                                        .status.pass.progress.total}.
                                {:else}
                                    Checking what has changed.
                                {/if}
                            {:else}
                                Mirroring to <strong
                                    >{mirror.status.folder}</strong
                                >.
                                {mirror.status.documents}
                                {mirror.status.documents === 1
                                    ? "document"
                                    : "documents"} and
                                {mirror.status.assets}
                                {mirror.status.assets === 1
                                    ? "attachment"
                                    : "attachments"} are in the folder.
                                <!-- "Complete" only when it is: nothing waiting, and the server
                                     answered the question of what changed on other devices. -->
                                {#if mirror.status.skipped.length === 0 && mirror.status.missingAssets.length === 0 && !mirror.status.changesElsewhereUnchecked}
                                    Last checked complete {agoText(
                                        mirror.status.lastSyncAt,
                                    )}.
                                {:else}
                                    Last checked {agoText(
                                        mirror.status.lastSyncAt,
                                    )}.
                                {/if}
                            {/if}
                        </p>
                        {#if mirror.status.changesElsewhereUnchecked && !mirror.status.paused}
                            <p
                                class="text-sm text-amber-700 dark:text-amber-400"
                                data-testid="mirror-unchecked"
                            >
                                Could not ask the server for edits made on other
                                devices, so some may not be in the folder yet. It
                                asks again shortly; Mirror now asks at once.
                            </p>
                        {/if}
                        <!-- Each of these can name thousands of files on a real graph, so the count
                         is the message and the names are folded away behind it. A wall of text is
                         not a report: it buries the sentence that says what to do. -->
                        {#if mirror.status.skipped.length > 0}
                            {@render mirrorList(
                                "mirror-skipped",
                                `Waiting for ${mirror.status.skipped.length} ${mirror.status.skipped.length === 1 ? "document" : "documents"} to finish syncing before writing ${mirror.status.skipped.length === 1 ? "it" : "them"}.`,
                                mirror.status.skipped,
                                true,
                            )}
                        {/if}
                        {#if mirror.status.missingAssets.length > 0}
                            {@render mirrorList(
                                "mirror-missing-assets",
                                `${mirror.status.missingAssets.length} ${mirror.status.missingAssets.length === 1 ? "attachment" : "attachments"} could not be downloaded this time. Every pass tries again, including Mirror now.`,
                                mirror.status.missingAssets,
                                true,
                            )}
                        {/if}
                        {#if mirror.status.danglingLinks.length > 0}
                            {@render mirrorList(
                                "mirror-dangling-links",
                                `${mirror.status.danglingLinks.length} ${mirror.status.danglingLinks.length === 1 ? "link points" : "links point"} at an attachment this graph does not hold, usually from an import that could not bring the file across. No pass can resolve ${mirror.status.danglingLinks.length === 1 ? "it" : "them"}; the documents holding ${mirror.status.danglingLinks.length === 1 ? "it" : "them"} are named below.`,
                                mirror.status.danglingLinks.map(
                                    (link) => `${link.concept} → ${link.name}`,
                                ),
                                false,
                            )}
                        {/if}
                        {#if mirror.status.collisions.length > 0}
                            {@render mirrorList(
                                "mirror-collisions",
                                `${mirror.status.collisions.length} ${mirror.status.collisions.length === 1 ? "document" : "documents"} share a file name with another, so ${mirror.status.collisions.length === 1 ? "it was" : "they were"} numbered. The title inside each file is unchanged, so nothing links to the wrong page.`,
                                mirror.status.collisions.map(
                                    (entry) => entry.fileName,
                                ),
                                false,
                            )}
                        {/if}
                        <p class="text-sm text-gray-600 dark:text-gray-400">
                            Mirroring runs while this graph is open here, and
                            picks up where it left off next time you open it on
                            this device.
                        </p>
                        <div class="flex flex-wrap gap-2">
                            {#if mirror.status.paused}
                                <button
                                    type="button"
                                    onclick={mirror.onresume}
                                    data-testid="mirror-resume"
                                    class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                                    >{mirror.status.paused.kind === "folder"
                                        ? "Choose the folder again…"
                                        : "Reconnect and carry on"}</button
                                >
                            {:else}
                                <button
                                    type="button"
                                    onclick={mirror.onsync}
                                    disabled={mirror.status.syncing}
                                    data-testid="mirror-sync-now"
                                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                                    >Mirror now</button
                                >
                            {/if}
                            <button
                                type="button"
                                onclick={mirror.onstop}
                                data-testid="mirror-stop"
                                class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                >Stop mirroring</button
                            >
                        </div>
                    {:else if !mirror.supported}
                        <p
                            class="text-sm text-gray-600 dark:text-gray-400"
                            data-testid="mirror-unsupported"
                        >
                            This browser can't give EtherPK a folder to write
                            to. Mirroring needs the File System Access API,
                            which Chrome and Edge on a desktop provide; phones
                            and Firefox don't yet.
                        </p>
                    {:else}
                        <p class="text-sm text-gray-600 dark:text-gray-400">
                            The mirror is set up per device. It runs while the
                            graph is open here and resumes by itself next time.
                            If the folder you pick already has files in it,
                            you'll be asked before it's taken over.
                        </p>
                        <button
                            type="button"
                            onclick={mirror.onenable}
                            data-testid="mirror-enable"
                            class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                            >Choose a folder and start mirroring…</button
                        >
                    {/if}

                    <!-- The one-shot half (ADR 0092): the same folder form, zipped, on any browser.
                         Nothing here is a setting either; the export starts on its own click and
                         reports through the Activity toast, and an incomplete one waits here. -->
                    <div
                        class="space-y-3 border-t border-gray-900/10 dark:border-gray-100/15 pt-4"
                        data-testid="export-section"
                    >
                        <h3 class="text-sm font-semibold text-gray-950 dark:text-gray-100">
                            Export as zip
                        </h3>
                        <p class="text-sm text-gray-600 dark:text-gray-400">
                            A one-off copy of this graph as a zip: the same
                            plain Markdown files, attachments and settings a
                            mirror folder holds, importable again as a new graph
                            on any device. Works in every browser, phones
                            included.
                        </p>
                        <p
                            class="text-sm text-gray-950 dark:text-gray-100"
                            role="status"
                            data-testid="export-estimate"
                        >
                            {#if exportGraph.estimate === null}
                                Counting what the archive would hold…
                            {:else if exportGraph.estimate === "offline"}
                                The Sync Server can't be reached, and attachments
                                are downloaded from it, so an export can't run
                                right now. Try again once you are connected.
                            {:else}
                                {exportGraph.estimate.documents}
                                {exportGraph.estimate.documents === 1
                                    ? "document"
                                    : "documents"} and {exportGraph.estimate
                                    .assets}
                                {exportGraph.estimate.assets === 1
                                    ? "attachment"
                                    : "attachments"}, about {formatBytes(
                                    exportGraph.estimate.bytes,
                                )}.
                                {#if !exportGraph.savePicker}
                                    The archive is built on this device first,
                                    then downloaded.
                                {/if}
                            {/if}
                        </p>
                        {#if exportGraph.pending}
                            <div
                                class="space-y-2 rounded-lg border border-amber-600/40 bg-amber-50 dark:bg-amber-950/30 p-3"
                                data-testid="export-pending"
                            >
                                <p class="text-sm text-gray-950 dark:text-gray-100">
                                    The last export finished with something left
                                    out. Keep it as it is, marked incomplete, or
                                    discard it.
                                </p>
                                {#if exportGraph.pending.skipped.length > 0}
                                    {@render mirrorList(
                                        "export-pending-skipped",
                                        `${exportGraph.pending.skipped.length} ${exportGraph.pending.skipped.length === 1 ? "document was" : "documents were"} still syncing and ${exportGraph.pending.skipped.length === 1 ? "is" : "are"} not in the archive.`,
                                        exportGraph.pending.skipped,
                                        true,
                                    )}
                                {/if}
                                {#if exportGraph.pending.missingAssets.length > 0}
                                    {@render mirrorList(
                                        "export-pending-missing",
                                        `${exportGraph.pending.missingAssets.length} ${exportGraph.pending.missingAssets.length === 1 ? "attachment" : "attachments"} could not be downloaded and ${exportGraph.pending.missingAssets.length === 1 ? "is" : "are"} not in the archive.`,
                                        exportGraph.pending.missingAssets,
                                        true,
                                    )}
                                {/if}
                                <div class="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onclick={exportGraph.pending.onkeep}
                                        data-testid="export-keep"
                                        class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                                        >Keep the incomplete export</button
                                    >
                                    <button
                                        type="button"
                                        onclick={exportGraph.pending.ondiscard}
                                        data-testid="export-discard"
                                        class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                        >Discard</button
                                    >
                                </div>
                            </div>
                        {:else}
                            <div class="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onclick={exportGraph.onexport}
                                    disabled={exportGraph.running ||
                                        exportGraph.estimate === "offline" ||
                                        exportGraph.estimate === null}
                                    data-testid="export-start"
                                    class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50"
                                    >{exportGraph.running
                                        ? "Exporting…"
                                        : "Export as zip…"}</button
                                >
                            </div>
                        {/if}
                        {#if exportGraph.leftover}
                            <p
                                class="text-sm text-gray-600 dark:text-gray-400"
                                data-testid="export-leftover"
                            >
                                An earlier export's download file ({formatBytes(
                                    exportGraph.leftover.size,
                                )}) is still on this device. It is removed by
                                itself an hour after its download began, or now:
                                <button
                                    type="button"
                                    onclick={exportGraph.leftover.onremove}
                                    data-testid="export-leftover-remove"
                                    class="font-medium text-gray-950 dark:text-gray-100 underline hover:no-underline"
                                    >Remove it</button
                                >
                            </p>
                        {/if}
                    </div>
                </div>
            {:else if activeTab === "agents" && agents && agents.kind === "local"}
                <!-- Nothing to set up: the folder is the integration, so this tab only says
                     where the agent's instructions are and what they cover. -->
                <div class="space-y-4" data-testid="agents-tab-local">
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        This graph is a folder on this computer, so an AI agent
                        (Claude Code, Codex, Cursor and the like) works on it
                        the way it works on any project: point it at the folder,
                        or give it a file's path. There is nothing to connect.
                    </p>
                    <p class="text-sm text-gray-950 dark:text-gray-100">
                        EtherPK keeps an <code class="font-mono">AGENTS.md</code>
                        at the top of the folder{#if agents.folderName}
                            (<code class="font-mono" data-testid="agents-local-folder">{agents.folderName}</code>){/if},
                        beside <code class="font-mono">journals/</code>,
                        <code class="font-mono">pages/</code> and
                        <code class="font-mono">assets/</code>. Agents read a
                        file of that name before they touch anything, and this
                        one tells them how the notes are written - bullets and
                        indenting, <code class="font-mono">[[links]]</code>,
                        tasks and their tags, images and files - and what to
                        leave alone: the scrambled body of a protected document
                        and the <code class="font-mono">etherpk/</code> folder.
                        A <code class="font-mono">CLAUDE.md</code> beside it
                        just points Claude Code at the same file.
                    </p>
                    <p class="text-sm text-gray-950 dark:text-gray-100">
                        Both files are yours to add to. Anything you write
                        outside the part between the
                        <code class="font-mono">&lt;!-- BEGIN ETHERPK --&gt;</code>
                        and <code class="font-mono">&lt;!-- END ETHERPK --&gt;</code>
                        lines is kept; that part is rewritten each time the
                        graph opens so it always matches this version.
                    </p>
                    {#if agents.folderPath}
                        <p class="text-sm text-gray-600 dark:text-gray-400">
                            Path on this device:
                            <code class="font-mono" data-testid="agents-local-path">{agents.folderPath}/AGENTS.md</code>
                        </p>
                        <!-- The same Headless Client that serves a synced graph serves a folder,
                             with no sign-in: search, backlinks, tasks and format-safe edits over the
                             files, alongside the files themselves. A person reads this, never an
                             agent; AGENTS.md stays about the file format on purpose. -->
                        <div class="space-y-1 border-t border-gray-900/10 dark:border-gray-100/15 pt-4">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="text-sm font-medium text-gray-950 dark:text-gray-100">Or give the agent search, backlinks and tasks too</span>
                                <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                                    for
                                    <select
                                        bind:value={agentTool}
                                        class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                                        data-testid="agents-tool"
                                    >
                                        {#each AGENT_TOOLS as toolOption (toolOption.id)}
                                            <option value={toolOption.id}>{toolOption.label}</option>
                                        {/each}
                                    </select>
                                </label>
                            </div>
                            <p class="text-sm text-gray-600 dark:text-gray-400">
                                The EtherPK Headless Client can serve this folder to
                                the agent over MCP, no sign-in needed: it keeps an
                                index of the notes so the agent can search them,
                                follow links and list tasks, and its edits keep the
                                format. Edits the agent makes to the files directly
                                are picked up as they land.
                            </p>
                            <div class="flex items-start gap-2">
                                <pre
                                    class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm"
                                    data-testid="agents-register-folder-command">{registerFolderCommand(agentTool, agents.folderPath)}</pre>
                                <button
                                    type="button"
                                    onclick={() =>
                                        copyAgentCommand(
                                            "register",
                                            registerFolderCommand(agentTool, agents!.kind === "local" ? agents!.folderPath! : ""),
                                        )}
                                    class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                    data-testid="agents-copy-register-folder"
                                    >{agentCopied === "register" ? "Copied" : "Copy"}</button
                                >
                            </div>
                            {#if agentCopyError}
                                <p role="status" class="text-sm text-red-700 dark:text-red-400">{agentCopyError}</p>
                            {/if}
                        </div>
                    {:else if agents.folderName}
                        <p class="text-sm text-gray-600 dark:text-gray-400">
                            To hand an agent a full path, or to serve the folder
                            to an agent over MCP with search, backlinks and
                            tasks, set
                            <span class="font-medium">Folder path on this device</span>
                            on the General tab, or use
                            <span class="font-medium">Copy full file path</span>
                            on a document's tab.
                        </p>
                    {/if}
                    {#if agents.folderPath}
                        {@render agentExtras(agents)}
                    {/if}
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        <a
                            href="https://docs.etherpk.com/using-ai-agents-with-your-notes"
                            target="_blank"
                            rel="noreferrer"
                            class="underline decoration-gray-400 underline-offset-2 hover:decoration-gray-950 dark:hover:decoration-gray-100"
                            >Read the guide</a
                        >, including what to do when the notes folder sits inside a
                        bigger project.
                    </p>
                </div>
            {:else if activeTab === "agents" && agents && agents.kind === "synced"}
                <!-- Nothing here is a setting: two commands to copy and a link. The token itself
                     is minted at the portal and never passes through this dialog. -->
                <div class="space-y-4" data-testid="agents-tab">
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        An AI agent reaches a synced graph through the EtherPK
                        Headless Client: a small program on the agent's own
                        computer that signs in as one of your devices, keeps
                        this graph in sync and speaks MCP to the agent beside
                        it. Your notes stay encrypted on the way through the
                        Sync Server, so it only works where your keys are - not
                        for agents that live entirely in the cloud. Protected
                        documents are listed by name only and never served.
                    </p>
                    <ol class="space-y-3 text-sm text-gray-950 dark:text-gray-100">
                        <li class="space-y-1">
                            <p>
                                <span class="font-medium">1. Sign the machine in</span>
                                once. You'll need an account-wide Personal
                                Access Token from
                                <a
                                    href={tokensPageUrl(agents.serverBaseUrl)}
                                    target="_blank"
                                    rel="noreferrer"
                                    class="underline decoration-gray-400 underline-offset-2 hover:decoration-gray-950 dark:hover:decoration-gray-100"
                                    data-testid="agents-tokens-link">the Sync Server portal</a
                                >, then you confirm a code in any unlocked
                                EtherPK tab.
                            </p>
                            <div class="flex items-start gap-2">
                                <pre
                                    class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm"
                                    data-testid="agents-login-command">{loginCommand(agents.serverBaseUrl)}</pre>
                                <button
                                    type="button"
                                    onclick={() =>
                                        copyAgentCommand(
                                            "login",
                                            loginCommand(agents!.serverBaseUrl),
                                        )}
                                    class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                    data-testid="agents-copy-login"
                                    >{agentCopied === "login" ? "Copied" : "Copy"}</button
                                >
                            </div>
                        </li>
                        <li class="space-y-1">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="font-medium">2. Tell the agent about this graph</span>
                                <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                                    for
                                    <select
                                        bind:value={agentTool}
                                        class="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-950 dark:text-gray-100"
                                        data-testid="agents-tool"
                                    >
                                        {#each AGENT_TOOLS as toolOption (toolOption.id)}
                                            <option value={toolOption.id}>{toolOption.label}</option>
                                        {/each}
                                    </select>
                                </label>
                            </div>
                            <div class="flex items-start gap-2">
                                <pre
                                    class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm"
                                    data-testid="agents-register-command">{registerCommand(agentTool, agents.graphId, agents.serverBaseUrl)}</pre>
                                <button
                                    type="button"
                                    onclick={() =>
                                        copyAgentCommand(
                                            "register",
                                            registerCommand(agentTool, agents!.graphId, agents!.serverBaseUrl),
                                        )}
                                    class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                                    data-testid="agents-copy-register"
                                    >{agentCopied === "register" ? "Copied" : "Copy"}</button
                                >
                            </div>
                        </li>
                    </ol>
                    {#if agentCopyError}
                        <p role="status" class="text-sm text-red-700 dark:text-red-400">{agentCopyError}</p>
                    {/if}
                    {@render agentExtras(agents)}
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        This graph's id is <code class="font-mono" data-testid="agents-graph-id">{agents.graphId}</code>.
                        Revoke the token at the portal to cut the agent off.
                        <a
                            href="https://docs.etherpk.com/using-ai-agents-with-your-notes"
                            target="_blank"
                            rel="noreferrer"
                            class="underline decoration-gray-400 underline-offset-2 hover:decoration-gray-950 dark:hover:decoration-gray-100"
                            >Read the guide</a
                        >.
                    </p>
                </div>
            {:else if activeTab === "maintenance"}
                <!-- The controls themselves render below the footer, through the shell's `tools`
                 snippet: each acts the moment it is pressed, so none of them may sit between the
                 inputs and the Save that does not apply to them. -->
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Housekeeping for this graph. Nothing here is a setting -
                    each control acts as soon as you press it.
                </p>
            {:else}
                <div>
                    <label
                        for="graph-name"
                        class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                        >Graph name</label
                    >
                    <input
                        id="graph-name"
                        data-testid="graph-name"
                        bind:value={draftName}
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                    <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                        {nameHelp}
                    </p>
                </div>
                <div>
                    <label
                        for="graph-display-size"
                        class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                        >Default maximum image display size on upload</label
                    >
                    <input
                        id="graph-display-size"
                        data-testid="graph-display-size"
                        bind:value={displaySize}
                        placeholder={DEFAULT_IMAGE_DISPLAY_SIZE}
                        inputmode="numeric"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                    <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                        Uploaded images get this added to their description, e.g.
                        <code>![photo|{DEFAULT_IMAGE_DISPLAY_SIZE}]</code>. A width like
                        800 or width×height like 800x600; 0 for natural size.
                    </p>
                </div>
                <div>
                    <label
                        for="graph-code-language"
                        class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                        >Default code language</label
                    >
                    <input
                        id="graph-code-language"
                        data-testid="graph-code-language"
                        bind:value={codeLanguage}
                        placeholder="e.g. text, ts, python"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                </div>
                <div>
                    <label
                        for="graph-recent-count"
                        class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                        >Recent documents shown in the sidebar</label
                    >
                    <input
                        id="graph-recent-count"
                        data-testid="graph-recent-count"
                        type="number"
                        min={MIN_RECENT_COUNT}
                        max={MAX_RECENT_COUNT}
                        bind:value={recentCount}
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                    <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                        Which documents are recent is remembered per device; how
                        many are listed is shared.
                    </p>
                </div>
                <div>
                    <label
                        for="graph-toolbar-color"
                        class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                        >Toolbar colour</label
                    >
                    <!-- Eight ready-made pastels first - the presence palette, so a graph's bar
                         and a member's caret draw from the same set - then the picker for anything
                         else. A tap on a swatch is the whole gesture for most people; the picker
                         stays for the rest. -->
                    <div
                        class="mt-3 mb-4 flex flex-wrap gap-2"
                        role="group"
                        aria-label="Ready-made toolbar colours"
                        data-testid="graph-toolbar-color-swatches"
                    >
                        {#each PRESENCE_PALETTE as swatch (swatch.color)}
                            <button
                                type="button"
                                title={swatch.label}
                                aria-label={swatch.label}
                                aria-pressed={toolbarColor === swatch.color}
                                data-testid="graph-toolbar-color-swatch"
                                data-color={swatch.color}
                                onclick={() => (toolbarColor = swatch.color)}
                                style="background-color: {swatch.color}"
                                class="h-8 w-8 rounded-full border border-gray-900/15 dark:border-white/20 ring-offset-2 ring-offset-white dark:ring-offset-gray-900 transition-shadow hover:ring-2 hover:ring-gray-400 dark:hover:ring-gray-500 {toolbarColor ===
                                swatch.color
                                    ? 'ring-2 ring-gray-900 dark:ring-gray-100'
                                    : ''}"
                            ></button>
                        {/each}
                    </div>
                    <div class="flex items-center gap-3">
                        <!-- The native picker: every browser has one, and a swatch is what a colour
                             setting should look like. Reads the stand-in while unset so the control
                             is never blank; the first pick is what sets the value. -->
                        <input
                            id="graph-toolbar-color"
                            data-testid="graph-toolbar-color"
                            type="color"
                            value={toolbarColor ?? TOOLBAR_COLOR_STAND_IN}
                            oninput={(event) =>
                                (toolbarColor = (
                                    event.currentTarget as HTMLInputElement
                                ).value)}
                            class="h-9 w-14 cursor-pointer rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 p-1"
                        />
                        {#if toolbarColor !== null}
                            <code
                                class="font-mono text-sm text-gray-700 dark:text-gray-300"
                                data-testid="graph-toolbar-color-value">{toolbarColor}</code
                            >
                            <button
                                type="button"
                                onclick={() => (toolbarColor = null)}
                                data-testid="graph-toolbar-color-clear"
                                class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                >Use theme colour</button
                            >
                        {:else}
                            <span
                                class="text-sm text-gray-500 dark:text-gray-400"
                                data-testid="graph-toolbar-color-default"
                                >Theme colour</span
                            >
                        {/if}
                    </div>
                    <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
                        Colours the bar of buttons above the panes (the tab strip on
                        a phone), so this graph is easy to tell apart. Pick one of
                        the ready-made colours or any colour of your own; one colour
                        for light and dark themes.
                    </p>
                </div>
                {#if folderPath}
                    <div>
                        <label
                            for="graph-folder-path-setting"
                            class="mb-1.5 block text-sm font-medium text-gray-600 dark:text-gray-300"
                            >Folder path on this device</label
                        >
                        <input
                            id="graph-folder-path-setting"
                            data-testid="graph-folder-path"
                            bind:value={draftFolderPath}
                            autocomplete="off"
                            spellcheck="false"
                            placeholder={`e.g. /home/you/notes/${folderPath.folderName}`}
                            class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 font-mono text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                        />
                        <p class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
                            Where the <strong class="font-medium">{folderPath.folderName}</strong> folder is on this
                            computer. Used by "Copy full file path" on a document tab, and
                            remembered here only; the browser cannot see it for itself.
                        </p>
                    </div>
                {/if}
                <p class="text-sm text-gray-500 dark:text-gray-400">
                    Settings are shared by every member of the graph and sync
                    end-to-end encrypted.
                </p>
                <p class="text-sm text-gray-400 dark:text-gray-500">
                    Graph id: <code
                        data-testid="graph-id"
                        class="font-mono select-all">{graphId}</code
                    >
                </p>
                {#if error}<p
                        class="text-sm text-red-600"
                        data-testid="graph-settings-error"
                    >
                        {error}
                    </p>{/if}
            {/if}
        </div>
    {/snippet}

    <!-- Save belongs to the General tab alone. The others have nothing for it to apply: the
         protection timings save as they change (per device), the mirror starts when its folder is
         chosen, and Maintenance is all actions. A Save sitting under them would imply otherwise. -->
    {#snippet footer()}
        <button
            type="button"
            onclick={close}
            data-testid="settings-dismiss"
            class="rounded-lg px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
        >
            {activeTab === "general" ? "Cancel" : "Done"}
        </button>
        {#if activeTab === "general"}
            <button
                type="submit"
                data-testid="graph-settings-save"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-2 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                >Save</button
            >
        {/if}
    {/snippet}
</Modal>

<!-- Outside the form and below Save / Cancel: nothing here is something Save applies - each
     acts the moment it is pressed - so it must not sit between the inputs and their buttons. -->
<!-- Below Save for the same reason as the Storage tools: installing acts at once and is per
     device, so it must not read as one of the shared settings the form commits. -->
<!-- The once-per-computer setups and the publish command, for either backend: what an agent's
     tools name in a refusal, spelled here so a person can copy them to the agent's machine. -->
{#snippet agentExtras(props: AgentsTabProps)}
    {@const extras = [
        { key: "semantic" as const, label: "Search by meaning", text: semanticSetupCommand(), note: "Installs the embedding model once per computer; the agent's search gains mode: semantic." },
        { key: "diagrams" as const, label: "Publish diagrams", text: diagramsSetupCommand(), note: "Installs the browser a publish draws Mermaid diagrams with; a publish with diagrams refuses until it has run." },
        ...(publishCommand(props) ? [{ key: "publish" as const, label: "Publish from the agent's machine", text: publishCommand(props)!, note: "Publishes once and remembers the folder; the agent's publish tool then writes there and cannot choose another folder." }] : []),
    ]}
    <div class="space-y-3" data-testid="agents-extras">
        <p class="text-sm font-medium text-gray-950 dark:text-gray-100">Optional, on the agent's machine</p>
        <ul class="space-y-3">
            {#each extras as extra (extra.key)}
                <li class="space-y-1">
                    <span class="text-sm font-medium">{extra.label}</span>
                    <div class="flex items-start gap-2">
                        <pre
                            class="min-w-0 flex-1 overflow-x-auto rounded-md border border-gray-900/10 dark:border-gray-100/15 bg-gray-50 dark:bg-gray-900 p-3 font-mono text-sm"
                            data-testid="agents-extra-{extra.key}">{extra.text}</pre>
                        <button
                            type="button"
                            onclick={() => copyAgentCommand(extra.key, extra.text)}
                            class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-950 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800"
                            data-testid="agents-copy-{extra.key}">{agentCopied === extra.key ? "Copied" : "Copy"}</button
                        >
                    </div>
                    <p class="text-sm text-gray-500 dark:text-gray-400">{extra.note}</p>
                </li>
            {/each}
        </ul>
    </div>
{/snippet}

{#snippet installTools()}
    <div class="space-y-2" data-testid="app-install">
        <p class="text-sm font-medium text-gray-500 dark:text-gray-400">
            Install on this device
        </p>
        {#if install.installed}
            <p
                class="text-sm text-gray-600 dark:text-gray-300"
                data-testid="app-install-installed"
            >
                EtherPK is installed on this device.
            </p>
        {:else if install.promptAvailable}
            <button
                type="button"
                onclick={installApp}
                data-testid="app-install-prompt"
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >Install EtherPK</button
            >
        {:else if installDismissed}
            <p
                class="text-sm text-gray-600 dark:text-gray-300"
                data-testid="app-install-dismissed"
            >
                Not installed. The browser will offer again on a later visit, or
                look for <em>Install app</em> in its menu.
            </p>
        {:else}
            <p
                class="text-sm text-gray-600 dark:text-gray-300"
                data-testid="app-install-unavailable"
            >
                Install EtherPK via your browser menu.
            </p>
        {/if}
        <p class="text-sm text-gray-500 dark:text-gray-400">
            Installation signals to your browser that EtherPK is a priority web
            application, meaning graph data held on the device is less likely to
            be cleared as part of storage optimisation (common on mobile
            devices), and your graphs will open without having to download
            again.
        </p>
    </div>
{/snippet}

{#snippet storageTools()}
    <div class="space-y-2">
        <p class="text-sm font-medium text-gray-500 dark:text-gray-400">
            Storage
        </p>
        {#if storageInfo}
            <p
                class="text-sm text-gray-600 dark:text-gray-300"
                data-testid="graph-storage"
            >
                {formatBytes(storageInfo.docBytes)} documents · {formatBytes(
                    storageInfo.assetBytes,
                )} assets on the server.
            </p>
            <p class="text-sm text-gray-500 dark:text-gray-400">
                The documents figure includes encrypted edit history — it
                shrinks when history is compacted.
            </p>
        {/if}
        {#if indexPersisted !== null}
            <p
                class="text-sm text-gray-500 dark:text-gray-400"
                data-testid="index-persistence"
            >
                {indexPersisted
                    ? "Search index: kept between visits, so this graph reopens quickly."
                    : indexPersistenceBlocked === "held"
                      ? "Search index: temporarily kept in memory because another window or tab holds its stored index. It will reconnect automatically."
                      : "Search index: rebuilt each visit because this browser can't store it, so large graphs take longer to open."}
            </p>
        {/if}
        {#if onrebuildindex}
            <!-- The Derived Index is never authoritative and always rebuildable; this is
                 the one way a user can invoke that rule when what the sidebars show does
                 not match the documents. Non-destructive: it re-derives from the documents,
                 which are untouched. -->
            <div class="space-y-2 pb-2">
                <button
                    type="button"
                    onclick={rebuildIndex}
                    disabled={rebuilding}
                    data-testid="index-rebuild"
                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40"
                    >{rebuilding
                        ? indexProgress && indexProgress.total > 0
                            ? `Rebuilding… ${indexProgress.done.toLocaleString()} of ${indexProgress.total.toLocaleString()}`
                            : "Rebuilding…"
                        : "Rebuild search index"}</button
                >
                <p class="pt-1 text-sm text-gray-500 dark:text-gray-400">
                    Re-reads every document to rebuild backlinks, tasks and
                    search from scratch. Use it if a sidebar disagrees with a
                    document. Your documents are not changed.
                </p>
                {#if rebuilt}
                    <p
                        class="text-sm text-gray-600 dark:text-gray-300"
                        data-testid="index-rebuilt"
                    >
                        Search index rebuilt{indexProgress &&
                        indexProgress.total > 0
                            ? ` from ${indexProgress.total.toLocaleString()} ${indexProgress.total === 1 ? "document" : "documents"}`
                            : ""}.
                    </p>
                {/if}
                {#if rebuildError}<p
                        class="text-sm text-red-600"
                        data-testid="index-rebuild-error"
                    >
                        {rebuildError}
                    </p>{/if}
            </div>
        {/if}
        {#if assetTools}
            <OrphanAssetsSection {assetTools} />
        {/if}
    </div>
{/snippet}
