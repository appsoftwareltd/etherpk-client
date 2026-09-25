<script lang="ts">
    /**
     * The knowledge-graph picker: list the graphs this browser knows, open one, create a
     * Local graph from a folder, or create/join a synced (Server-backed, E2EE) graph. Backend
     * is fixed at creation (ADR 0007).
     */
    import { onMount } from "svelte";

    import { dev } from "$app/environment";
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { env } from "$env/dynamic/public";
    import {
        type DeviceStorageReport,
        type DirectoryAdapter,
        type GraphRecord,
        type GraphSettings,
        type ServerGraphScope,
        type StorageRecovery,
        STORAGE_RECOVERY_FOOTNOTE,
        STORAGE_RECOVERY_HEADLINE,
        STORAGE_RECOVERY_INTRO,
        acknowledgeStorageRecoveries,
        clearLastGraphId,
        createIdbGraphRegistry,
        createWebFsDirectoryAdapter,
        describeDeviceStorage,
        ensurePermission,
        getLastGraphId,
        isFsaSupported,
        pickGraphDirectory,
        readGraphSettings,
        PLACEHOLDER_SYNCED_GRAPH_NAME,
        registerSyncedGraphOnDevice,
        sanitizeGraphSettings,
        storageRecoveryItems,
        subscribeStorageRecoveries,
        writeGraphSettings,
    } from "$lib/storage";
    import {
        type GraphAssetTools,
        filesystemAssetTools,
    } from "$lib/storage/fs/asset-orphans";
    import {
        accountIdentityFingerprint,
        createAccountKeys,
        createConfiguredSyncApi,
        createSyncApi,
        defaultCustomSyncUrl,
        ensureGraphKeys,
        isManagedSyncConfigured,
        readSyncConfig,
        resolveSyncConnection,
        writeSyncConfig,
        setVaultWrapKey,
        getVaultWrapKey as getCachedWrapKey,
        lockVault,
        acceptInvite as acceptInviteFlow,
        regenerateRecoveryCode,
        type RecoveryCodeRegeneration,
        createGraphNamePublisher,
        renameSyncedGraph,
        openSyncedGraphMetaSession,
        openHeldVault,
        resolveSyncedGraphConnection,
        type SyncedMetaSession,
        type SyncedMetaSessionDeps,
        deleteGraphCache,
        type SyncApi,
        clearActiveSyncAccount,
        MANAGED_DEVICE_DISCONNECT_HELP,
        normaliseServerOrigin,
        readActiveSyncAccount,
        setActiveSyncAccount,
        SyncApiError,
    } from "$lib/sync";
    import type { SyncAccountSummary } from "@appsoftwareltd/etherpk-shared";
    import { fromBase64Url, openVault, type GraphKeyring } from "$lib/crypto";
    import { promptRecoveryCode } from "$lib/sync/recovery-code-prompt";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import InviteDialog from "$lib/sync/ui/InviteDialog.svelte";
    import UnlockDialog from "$lib/sync/ui/UnlockDialog.svelte";
    import ResetDialog from "$lib/sync/ui/ResetDialog.svelte";
    import TransferOwnershipDialog from "$lib/sync/ui/TransferOwnershipDialog.svelte";
    import RenameGraphDialog from "$lib/sync/ui/RenameGraphDialog.svelte";
    import GraphSettingsDialog from "$lib/sync/ui/GraphSettingsDialog.svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import ImportGraphDialog from "$lib/import/ui/ImportGraphDialog.svelte";
    import { formatBytes } from "$lib/format-bytes";
    import {
        ManagedTokenError,
        clearManagedAccessToken,
    } from "$lib/auth/managed-token";
    import GraphPickerRow from "$lib/workspace/GraphPickerRow.svelte";
    import { isDemoGraph } from "$lib/demo/demo-graph";
    import {
        loadSyncedGraphViews,
        unlabelledGraphsToRead,
        persistableGraphRecord,
        type SyncedGraphView,
        type SyncedMember,
    } from "$lib/workspace/graph-picker-helpers";

    const registry = createIdbGraphRegistry();
    const supported = isFsaSupported();
    const managedSyncAvailable = isManagedSyncConfigured(env);
    const configuredCustomSyncUrl = defaultCustomSyncUrl(env);

    let graphs = $state<GraphRecord[]>([]);
    // The Demo Graph is listed apart from the graphs this browser owns (ADR 0069): a box of its
    // own below them, whatever its place in creation order, so a throwaway never sits above
    // real work and its Reset is not read as one more row's forget.
    const demoGraph = $derived(graphs.find((g) => isDemoGraph(g.id)) ?? null);
    const ordinaryGraphs = $derived(graphs.filter((g) => !isDemoGraph(g.id)));
    // The demo is offered until this browser has it; after that its row carries the reset.
    const demoAvailable = $derived(demoGraph === null);
    let status = $state("");
    let statusTone = $state<"info" | "error">("info");

    // Sync settings (device-local server URL + Personal Access Token).
    let showSyncSettings = $state(false);
    let connectionMode = $state<"managed" | "custom">(
        managedSyncAvailable ? "managed" : "custom",
    );
    let serverBaseUrl = $state(configuredCustomSyncUrl);
    let token = $state("");

    // Dialog state. The Recovery Code ritual is NOT here - it is hosted in the app shell so
    // a background import can finish on any route (promptRecoveryCode, ADR 0035).
    let inviteDialog = $state<{
        api: SyncApi;
        graphId: string;
        graphName?: string;
        keyring: GraphKeyring;
    } | null>(null);
    let unlockThen = $state<null | (() => Promise<void>)>(null);
    // Set alongside unlockThen when a caller is AWAITING the unlock rather than resuming
    // after it, so cancelling the dialog fails that caller instead of hanging it forever.
    let unlockCancelled: null | (() => void) = null;
    let showReset = $state(false);

    // Pending invites (invitee side).
    let invites = $state<
        Array<{
            id: string;
            graphId: string;
            rootDocId: string;
            sealedKeyring: string;
        }>
    >([]);

    // The Synced graphs management panel: server-side memberships cross-referenced with the
    // local registry for names (the server never knows them — ADR 0024).
    let syncConfigured = $state(false);
    // Has readSyncConfig() been consulted yet? syncConfigured starts false, which before the
    // first refresh means "not known" rather than "no Server" - a difference that matters only
    // to the no-backends notice above, which would otherwise flash for every non-Chromium user.
    let capabilitiesChecked = $state(false);
    let syncAccount = $state<SyncAccountSummary | null>(null);
    let syncAuthState = $state<
        | "disconnected"
        | "checking"
        | "authenticated"
        | "signed-out"
        | "unavailable"
    >("disconnected");
    /**
     * The account check in flight (or the last one settled). Actions gated on the plan await
     * it: on a fresh managed sign-in the first check is two round trips (the token exchange,
     * then /me), and a click that landed inside that window used to pass the Sync+ gate
     * because the gate read a plan the page did not yet have.
     */
    let accountCheck: Promise<void> = Promise.resolve();
    /**
     * A managed account on Free: its Entitlement allows no owned graphs at all (ADR 0068), so
     * creating or importing a synced graph would only be refused by the Server after the keys
     * ritual. Gate those two routes here and say what unlocks them instead; being a Player in
     * somebody else's graph is untouched, because that spends the Owner's allowance.
     */
    const syncPlusRequired = $derived(
        syncAuthState === "authenticated" &&
            syncAccount?.authentication.mode === "managed" &&
            syncAccount.entitlement.limits.ownedGraphs === 0,
    );
    const corporateBillingUrl = $derived(
        (page.data.corporateBillingUrl as string | null | undefined) ?? null,
    );
    // Does this account have a vault at all? false right after a reset / on a brand-new
    // account - states where an unlock prompt would ask for a Recovery Code that does not
    // exist. null = unknown (no config, or the check failed) - behave as before.
    let vaultExists = $state<boolean | null>(null);
    // Whether the wrap key is cached on this device - drives the Lock keys control.
    let vaultUnlocked = $state(false);
    // This account's own identity fingerprint, revealed on request rather than on load: reading
    // it needs the vault open, and nothing else on this page does.
    let ownFingerprint = $state<string | null>(null);
    let fingerprintPending = $state(false);
    let syncedGraphs = $state<SyncedGraphView[]>([]);
    // The quota-anticipating rollup over graphs this user owns (ADR 0033).
    let ownedStorage = $state<{
        graphs: number;
        docBytes: number;
        assetBytes: number;
    } | null>(null);
    let syncedLoading = $state(false);
    let syncedError = $state<string | null>(null);
    let transferDialog = $state<{
        api: SyncApi;
        graph: SyncedGraphView;
        candidates: SyncedMember[];
    } | null>(null);
    let leaveConfirm = $state<SyncedGraphView | null>(null);
    let leaveBusy = $state(false);
    let deleteConfirm = $state<SyncedGraphView | null>(null);
    let deleteText = $state("");
    let deleteBusy = $state(false);
    /** Reported inside the delete dialog, so a retry keeps the typed confirmation. */
    let deleteError = $state<string | null>(null);
    let renameDialog = $state<GraphRecord | null>(null);
    let forgetConfirm = $state<GraphRecord | null>(null);
    // Shared Graph Settings for a synced graph, edited over a short-lived meta session.
    let syncedSettings = $state<{
        record: GraphRecord;
        name: string;
        settings: GraphSettings;
        session: SyncedMetaSession;
    } | null>(null);
    // Graph Settings for a local (filesystem) graph — the same dialog over the folder's adapter.
    let localSettings = $state<{
        record: GraphRecord;
        settings: GraphSettings;
        adapter: DirectoryAdapter;
        assetTools: GraphAssetTools;
    } | null>(null);
    // Name-at-creation for New synced graph — no more piles of "Synced graph".
    let createDialog = $state(false);
    let createName = $state("");
    let createBusy = $state(false);
    /** "New synced graph" was pressed and is waiting on the account check or the keys ritual. */
    let createPending = $state(false);
    // Import a graph from a Logseq / Obsidian / EtherPK source folder.
    let importDialog = $state(false);
    /** The graph list could not be read at all, which is not the same as there being none. */
    let registryUnreadable = $state(false);
    /**
     * What this tab has put back from the device's safety copy after the browser dropped
     * IndexedDB (storage/safety-copy.ts). Shown until dismissed: the person should know why
     * their graphs are about to download again, and that nothing on the server changed.
     */
    let recoveries = $state.raw<readonly StorageRecovery[]>([]);
    /** The notice's bullets: graphs by name, passkeys by the graph they belong to. */
    const recoveredItems = $derived(
        storageRecoveryItems(
            recoveries,
            (graphId) => graphs.find((graph) => graph.id === graphId)?.name,
        ),
    );
    /** Whether this browser has agreed to keep the origin's storage, and how much it uses. */
    let deviceStorage = $state.raw<DeviceStorageReport | null>(null);
    /** Running as an installed app, which is the one thing that reliably earns persistence on a phone. */
    let installedApp = $state(false);
    const deletePlayerCount = $derived(
        deleteConfirm
            ? (deleteConfirm.members ?? []).filter((m) => m.role === "player")
                  .length
            : 0,
    );

    function setStatus(message: string, tone: "info" | "error" = "info") {
        status = message;
        statusTone = tone;
    }

    /**
     * Outcomes that belong to one graph, reported beside that graph (rule 6).
     *
     * The page-level banner still carries genuinely page-level messages: sync settings,
     * account keys, imports. Everything scoped to a row used to travel up there too, which on
     * a long list meant a delete or a rename confirmed itself off-screen.
     */
    let rowMessage = $state<
        Record<string, { text: string; tone: "info" | "error" }>
    >({});

    function setRowStatus(
        graphId: string,
        text: string,
        tone: "info" | "error" = "info",
    ) {
        rowMessage = { ...rowMessage, [graphId]: { text, tone } };
    }

    function clearRowStatus(graphId: string) {
        if (!rowMessage[graphId]) return;
        const next = { ...rowMessage };
        delete next[graphId];
        rowMessage = next;
    }

    function syncApi(): SyncApi | null {
        return createConfiguredSyncApi();
    }

    async function refresh() {
        await refreshAccount();
        try {
            graphs = await registry.listGraphs();
        } catch (err) {
            // A registry that cannot be read is not a registry that is empty, and the two used
            // to look identical: the list rejected, everything after it was skipped, and the
            // page said "No graphs yet" to someone whose graphs were all still there (2026-09-09).
            registryUnreadable = true;
            setStatus(
                `Your graphs could not be read from this browser's storage, so none are listed. Nothing has been deleted. (${(err as Error).message})`,
                "error",
            );
            return;
        }
        registryUnreadable = false;
        vaultUnlocked = getCachedWrapKey() !== null;
        // Independent fetches — don't serialize the panel behind the invites call.
        await Promise.all([refreshInvites(), refreshSynced(), refreshVault()]);
    }

    function refreshAccount(): Promise<void> {
        accountCheck = loadAccount();
        return accountCheck;
    }

    async function loadAccount() {
        const config = readSyncConfig();
        const connection = config ? resolveSyncConnection(config) : null;
        const api = connection
            ? createSyncApi({
                  baseUrl: connection.serverBaseUrl,
                  token: connection.token,
              })
            : null;
        syncConfigured = api !== null;
        capabilitiesChecked = true;
        if (!api || !connection) {
            syncAccount = null;
            syncAuthState = "disconnected";
            clearActiveSyncAccount();
            return;
        }

        syncAuthState = "checking";
        try {
            syncAccount = await api.me();
            setActiveSyncAccount({
                serverOrigin: normaliseServerOrigin(connection.serverBaseUrl),
                principalId: syncAccount.principal.id,
            });
            syncAuthState = "authenticated";
        } catch (error) {
            syncAccount = null;
            if (
                (error instanceof SyncApiError ||
                    error instanceof ManagedTokenError) &&
                error.status === 401
            ) {
                clearActiveSyncAccount();
                syncAuthState = "signed-out";
            } else {
                // Preserve the last verified partition for offline local work. It is not
                // authentication: remote calls must still present a current token or PAT.
                syncAuthState = "unavailable";
            }
        }
    }

    async function refreshVault() {
        const api = syncApi();
        if (!api) {
            vaultExists = null;
            return;
        }
        try {
            vaultExists = (await api.getVault()) !== null;
        } catch {
            vaultExists = null; // unknown — never block an action on a failed check
        }
    }

    /**
     * The vault's keyrings while it is unlocked here, so the synced list can read the server's
     * name envelope for graphs this device never opened (ADR 0031, amended 2026-09-17).
     * Null when the vault is locked, absent or unreadable: the list then keeps the id
     * placeholder, and the row copy says what would change that.
     */
    async function heldKeyrings(api: SyncApi): Promise<GraphKeyring[] | null> {
        try {
            const opened = await openHeldVault(api);
            return opened?.vault.keyrings ?? null;
        } catch (err) {
            console.warn("[graphs] could not open the vault to read graph names", err);
            return null;
        }
    }

    // Graphs this page already published an envelope for, so a refresh does not repeat the write.
    const backfilledEnvelopes = new Set<string>();

    /**
     * A graph on this device whose server row carries no name envelope yet - opened before
     * envelopes existed - gets one from the record's cached name, so the account's other
     * devices can label it without waiting for this one to open it again. Best-effort: the
     * next open republishes the canonical name anyway.
     */
    function backfillNameEnvelopes(
        api: SyncApi,
        keyrings: GraphKeyring[],
        views: SyncedGraphView[],
    ) {
        for (const view of views) {
            if (!view.onDevice || view.hasNameEnvelope) continue;
            if (view.name === PLACEHOLDER_SYNCED_GRAPH_NAME) continue;
            if (backfilledEnvelopes.has(view.id)) continue;
            const keyring = keyrings.find((k) => k.graphId === view.id);
            if (!keyring) continue;
            backfilledEnvelopes.add(view.id);
            createGraphNamePublisher({ api, keyring, graphId: view.id }).publish(
                view.name,
            );
        }
    }

    /** Per row, how reading an unlabelled graph's name from its root document went. */
    let nameReads = $state<
        Record<string, "reading" | "unnamed" | "unreachable">
    >({});
    // Rows already read this visit, so a refresh does not reconnect to them. A read the relay
    // did not answer is not recorded, so the next refresh tries it again.
    const nameReadsDone = new Set<string>();

    /**
     * A graph not on this device whose server row carries no name envelope has to be asked
     * directly, once: open its root document far enough to read the meta map, publish what
     * it says so no device ever has to do this again, and label the row. One at a time, each
     * bounded by the session's connect timeout, and only while the keys are unlocked here.
     */
    async function readUnlabelledNames(
        api: SyncApi,
        keyrings: GraphKeyring[],
        views: SyncedGraphView[],
    ) {
        const pending = unlabelledGraphsToRead(views, keyrings).filter(
            ({ view }) => !nameReadsDone.has(view.id),
        );
        for (const { view } of pending) nameReads[view.id] = "reading";
        for (const { view, keyring } of pending) {
            nameReadsDone.add(view.id);
            const publisher = createGraphNamePublisher({
                api,
                keyring,
                graphId: view.id,
            });
            let name: string | undefined;
            try {
                const session = await openSyncedGraphMetaSession(
                    await metaSessionDepsFor(view.id, view.rootDocId, {
                        keyring,
                        publishName: publisher.publish,
                    }),
                );
                try {
                    name = session.meta.name;
                } finally {
                    session.close();
                }
                await publisher.settled();
            } catch (err) {
                console.warn(
                    "[graphs] could not read a graph's name from its root document",
                    err,
                );
                nameReadsDone.delete(view.id);
                nameReads[view.id] = "unreachable";
                continue;
            }
            if (name) {
                const read = name;
                syncedGraphs = syncedGraphs.map((g) =>
                    g.id === view.id
                        ? { ...g, name: read, nameSource: "document" as const }
                        : g,
                );
                delete nameReads[view.id];
            } else {
                nameReads[view.id] = "unnamed";
            }
        }
    }

    async function refreshSynced() {
        const api = syncApi();
        if (!api) {
            syncedGraphs = [];
            syncedError = null;
            return;
        }
        syncedLoading = true;
        try {
            const keyrings = await heldKeyrings(api);
            const overview = await loadSyncedGraphViews(api, graphs, {
                keyrings: keyrings ?? undefined,
            });
            const scope = readActiveSyncAccount();
            if (scope) {
                await registry.reconcileServerMemberships(
                    scope,
                    overview.graphs.map((graph) => graph.id),
                );
                graphs = await registry.listGraphs();
                const localById = new Map(
                    graphs.map((graph) => [graph.id, graph]),
                );
                overview.graphs = overview.graphs.map((graph) => {
                    const local = localById.get(graph.id);
                    return local
                        ? {
                              ...graph,
                              name: local.name,
                              nameSource: "device" as const,
                              onDevice: true,
                          }
                        : graph;
                });
            }
            ownedStorage = overview.ownedStorage;
            syncedGraphs = overview.graphs;
            syncedError = null;
            if (keyrings) {
                backfillNameEnvelopes(api, keyrings, overview.graphs);
                void readUnlabelledNames(api, keyrings, overview.graphs);
            }
        } catch (err) {
            syncedGraphs = [];
            syncedError = (err as Error).message;
        } finally {
            syncedLoading = false;
        }
    }

    async function refreshInvites() {
        const api = syncApi();
        if (!api) return;
        try {
            invites = await api.listInvites();
        } catch {
            invites = [];
        }
    }

    /** Run `action` if the vault is unlocked, else open the unlock dialog and resume after. */
    async function requireUnlockedVault(
        action: () => Promise<void>,
    ): Promise<void> {
        if (getCachedWrapKey()) {
            await action();
            return;
        }
        // No vault on the account (fresh, or just reset): an unlock prompt would ask for a
        // Recovery Code that does not exist. Explain instead of dead-ending the user.
        if (vaultExists === false) {
            setStatus(
                "This account has no encryption keys yet - they are created with your first synced graph.",
                "error",
            );
            return;
        }
        supersedePendingUnlock();
        unlockThen = action;
    }

    /** Fail whoever was awaiting the dialog before handing it to a new caller. */
    function supersedePendingUnlock() {
        const cancelled = unlockCancelled;
        unlockCancelled = null;
        cancelled?.();
    }

    /**
     * Settle the account's encryption keys BEFORE anything is written for a new synced graph.
     * Documents and assets reach the server during an import while the Graph Key that opens
     * them lives only in this tab, so a keyless account mints and commits its vault first
     * (ADR 0029 rung 1) and a locked one unlocks first. An unknown vault state - the check
     * failed, e.g. the server is unreachable - must not block: let the attempt run and report
     * the real error.
     */
    async function ensureAccountKeysReady(): Promise<void> {
        if (getCachedWrapKey()) return;
        if (vaultExists === true) {
            await unlockVaultInteractively();
            return;
        }
        if (vaultExists !== false) return;
        const api = syncApi();
        if (!api)
            throw new Error(
                "Add a sync server URL and access token in Sync settings first.",
            );
        // Say it on the page as well as in the dialog: the ritual interrupts what they asked for.
        setStatus(
            "This account had no encryption keys, so they are being created now. Nothing is uploaded until you save your Recovery Code.",
        );
        await mintAccountKeysWithRitual(
            api,
            "This account had no encryption keys, so EtherPK has just created them. Nothing is uploaded to the sync server until you have saved this code.",
        );
    }

    /**
     * Mint the account's keys and hold until the Recovery Code is acknowledged, because the
     * acknowledgement is what writes the vault. Resolves with the keys usable on this device.
     */
    async function mintAccountKeysWithRitual(
        api: SyncApi,
        reason?: string,
    ): Promise<void> {
        let created: Awaited<ReturnType<typeof createAccountKeys>>;
        try {
            created = await createAccountKeys(api);
        } catch (err) {
            // Another device minted first: join those keys rather than starting a rival account.
            if (
                (err as Error).message.includes("already has encryption keys")
            ) {
                vaultExists = true;
                await unlockVaultInteractively();
                return;
            }
            throw err;
        }
        await new Promise<void>((resolve, reject) => {
            promptRecoveryCode({
                code: created.recoveryCode,
                arrival: "first",
                reason,
                commit: created.commit,
                then: (err) => (err ? reject(err) : resolve()),
            });
        });
        setVaultWrapKey(created.deviceKey);
        vaultExists = true;
        vaultUnlocked = true;
    }

    /**
     * Await an interactive unlock. Callers that cannot be resumed by a callback - a running
     * import asking for the key, a pre-flight before creating anything server-side - hold this
     * promise until the dialog succeeds, and are rejected if the user cancels.
     */
    function unlockVaultInteractively(): Promise<Uint8Array> {
        const cached = getCachedWrapKey();
        if (cached) return Promise.resolve(cached);
        return new Promise<Uint8Array>((resolve, reject) => {
            unlockCancelled = () =>
                reject(
                    new Error(
                        "Unlock your keys with your Recovery Code to continue.",
                    ),
                );
            unlockThen = async () => {
                const key = getCachedWrapKey();
                if (key) resolve(key);
                else
                    reject(
                        new Error("The keys on this device are still locked."),
                    );
            };
        });
    }

    /**
     * Keys must be in hand before an import creates anything on the server. The plan check
     * comes first for the same reason as in startCreateServerGraph: the dialog's synced
     * destination is offered from the same not-yet-known plan.
     */
    async function ensureVaultReadyForSyncedImport(): Promise<void> {
        await accountCheck;
        if (syncPlusRequired)
            throw new Error(
                "Synced graphs need Sync+. Start your trial from Billing first.",
            );
        await ensureAccountKeysReady();
    }

    function loadSyncConfig() {
        const config = readSyncConfig();
        if (config?.mode === "custom") {
            connectionMode = "custom";
            serverBaseUrl = config.serverBaseUrl;
            token = config.token;
        } else if (config?.mode === "managed" && managedSyncAvailable) {
            connectionMode = "managed";
        } else if (!managedSyncAvailable) {
            connectionMode = "custom";
        }
    }

    function connectManagedSync() {
        if (!managedSyncAvailable) {
            setStatus(
                "Managed Sync is not available from this Client.",
                "error",
            );
            return;
        }
        clearActiveSyncAccount();
        writeSyncConfig({ mode: "managed" });
        window.location.href = "/auth/login";
    }

    async function disconnectManagedSync() {
        clearManagedAccessToken();
        lockVault();
        clearActiveSyncAccount();
        await fetch("/auth/logout", { method: "POST" });
        window.location.href = "/graphs?managed=signed-out";
    }

    function prepareManagedSignOut() {
        // The form navigation continues through Corporate and Server. Clear in-memory and local
        // identity state before leaving so no authenticated UI survives if navigation is delayed.
        clearManagedAccessToken();
        lockVault();
        clearActiveSyncAccount();
    }

    function saveSyncConfig() {
        const url = serverBaseUrl.trim();
        if (!url || !token.trim()) {
            setStatus(
                "Both a server URL and an access token are required.",
                "error",
            );
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            setStatus(
                "The server URL must start with http:// or https:// (use http:// for a local server).",
                "error",
            );
            return;
        }
        clearActiveSyncAccount();
        writeSyncConfig({
            mode: "custom",
            serverBaseUrl: url,
            token: token.trim(),
        });
        showSyncSettings = false;
        setStatus("Sync settings saved on this device.");
        void refresh();
    }

    async function openFolder() {
        try {
            const handle = await pickGraphDirectory();
            const adapter = createWebFsDirectoryAdapter(handle);
            await adapter.ensureSkeleton();
            const id = crypto.randomUUID();
            await registry.insertGraph({
                id,
                name: handle.name,
                backend: "filesystem",
                createdAt: Date.now(),
                handle,
            });
            await goto(`/g/${id}`);
        } catch (err) {
            setStatus(
                `Could not open a folder: ${(err as Error).message}`,
                "error",
            );
        }
    }

    /** Step 1 of creation: ask for a name up front — no more piles of "Synced graph". */
    function startCreateServerGraph() {
        if (createPending) return;
        if (!syncApi()) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        createPending = true;
        void (async () => {
            try {
                // The plan is only known once the account check has answered; a click that
                // lands before then waits for it rather than racing it (it then either
                // proceeds or is refused, exactly as a later click would be).
                await accountCheck;
                if (syncPlusRequired) {
                    setStatus(
                        "Synced graphs need Sync+. Start your trial from Billing to create one.",
                        "error",
                    );
                    return;
                }
                // Settle the keys next. Naming a graph this device cannot key, then creating
                // it server-side only to fail, used to leave an empty graph against the owner's
                // allowance - and on a keyless account the code ritual belongs before the
                // graph, not after it.
                await ensureAccountKeysReady();
                createName = "";
                createDialog = true;
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "prepare your encryption keys"),
                    "error",
                );
            } finally {
                createPending = false;
            }
        })();
    }

    async function createServerGraph(name: string) {
        if (createBusy) return;
        const api = syncApi();
        if (!api) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        createBusy = true;
        try {
            const graph = await api.createGraph(); // server stores no name (ADR 0024)
            const keys = await withGraphCleanupOnFailure(api, graph.id, () =>
                ensureGraphKeys(api, graph.id, () =>
                    unlockVaultInteractively(),
                ),
            );
            const { recoveryCodeJustGenerated, deviceKey, commit } = keys;
            setVaultWrapKey(deviceKey);
            // The name lands in the local registry now; the first open seeds it into the
            // encrypted meta map (ADR 0031), where it becomes canonical for every member.
            await registry.insertGraph({
                id: graph.id,
                name,
                backend: "server",
                createdAt: Date.now(),
                handle: { rootDocId: graph.rootDocId },
                serverScope: requireActiveServerScope(),
                membershipActive: true,
            });
            createDialog = false;
            if (recoveryCodeJustGenerated) {
                // Prevention (ADR 0029): the vault is written only once the code is acknowledged.
                // Creation still navigates on confirm - unlike an import, the user has been
                // waiting on a dialog and has gone nowhere.
                promptRecoveryCode({
                    code: recoveryCodeJustGenerated,
                    arrival: "first",
                    commit,
                    then: (err) => {
                        if (err)
                            return setStatus(
                                `Saved your code, but could not finish setup: ${err.message}`,
                                "error",
                            );
                        void goto(`/g/${graph.id}`);
                    },
                });
                return;
            }
            await commit();
            await goto(`/g/${graph.id}`);
        } catch (err) {
            createDialog = false;
            setStatus(
                describeSyncFailure(err, "create a synced graph"),
                "error",
            );
        } finally {
            createBusy = false;
        }
    }

    /** The import dialog's synced-destination target, when this device is configured for sync. */
    /** Plan ids are code names on the wire; the product names belong on screen. */
    function planLabel(plan: string): string {
        return plan === "sync_plus" ? "Sync+" : plan === "free" ? "Free" : plan;
    }

    function importSyncTarget() {
        const config = readSyncConfig();
        const connection = config ? resolveSyncConnection(config) : null;
        const serverScope = readActiveSyncAccount();
        return connection && serverScope
            ? {
                  api: createSyncApi({
                      baseUrl: connection.serverBaseUrl,
                      token: connection.token,
                  }),
                  serverBaseUrl: connection.serverBaseUrl,
                  serverScope,
              }
            : null;
    }

    async function importWrapKey(): Promise<Uint8Array> {
        return unlockVaultInteractively();
    }

    /**
     * A graph exists on the server the moment it is created, before it can be keyed. If the
     * keying or registration that follows fails, remove it: an empty graph nobody can open
     * still counts against the owner's allowance (runServerImport does the same).
     */
    async function withGraphCleanupOnFailure<T>(
        api: SyncApi,
        graphId: string,
        work: () => Promise<T>,
    ): Promise<T> {
        try {
            return await work();
        } catch (err) {
            await api.deleteGraph(graphId).catch(() => {});
            throw err;
        }
    }

    /**
     * The import SUCCEEDED, wherever the user now is. Cache the device key and, on a fresh
     * account, start the Recovery Code ritual immediately - the identity and keyring exist
     * only in memory until `commit()`, so this cannot wait on the user pressing "Open"
     * (ADR 0029 + 0035). It deliberately does NOT navigate: an eight-minute background
     * import must not yank the user out of whatever they moved on to.
     */
    function onImportSettled(result: {
        graphId: string;
        recoveryCode?: string;
        commit?: () => Promise<void>;
        deviceKey?: Uint8Array;
    }) {
        if (result.deviceKey) setVaultWrapKey(result.deviceKey);
        // An import runs in the background and finishes wherever the user has wandered to. When
        // that is this page, the new graph would otherwise be missing from both lists until a
        // reload - the local registry is read on mount, and the synced panel with it.
        void refresh();
        if (result.recoveryCode) {
            promptRecoveryCode({
                code: result.recoveryCode,
                arrival: "first",
                // A code always arrives with the write that makes it real; an import that
                // somehow reports one without it has nothing left to persist.
                commit: result.commit ?? (async () => {}),
                // No navigation here: the toast's "Open" owns that.
                then: (err) => {
                    if (err)
                        setStatus(
                            `Saved your code, but could not finish setup: ${err.message}`,
                            "error",
                        );
                },
            });
        }
    }

    /** The finished toast's "Open" button - the only thing that navigates. */
    function onImported(result: { graphId: string }) {
        void goto(`/g/${result.graphId}`);
    }

    async function openGraph(graph: GraphRecord) {
        if (graph.backend === "server") {
            await goto(`/g/${graph.id}`);
            return;
        }
        const granted = await ensurePermission(graph.handle);
        if (!granted) {
            setRowStatus(
                graph.id,
                `Permission to "${graph.name}" was denied. Grant access when the browser asks, then open it again.`,
                "error",
            );
            return;
        }
        await goto(`/g/${graph.id}`);
    }

    /** Forget (confirmed via dialog): local record only — a synced graph also drops its cache. */
    async function executeForget() {
        const graph = forgetConfirm;
        forgetConfirm = null;
        if (!graph) return;
        if (graph.backend === "server") await deleteGraphCache(graph.id);
        await registry.removeGraph(graph.id);
        if (getLastGraphId() === graph.id) clearLastGraphId();
        await refresh();
    }

    /** Open the rename dialog — a synced rename needs the vault (it writes the meta map). */
    function renameGraph(graph: GraphRecord) {
        if (graph.backend !== "server") {
            renameDialog = graph;
            return;
        }
        void requireUnlockedVault(async () => {
            renameDialog = graph;
        });
    }

    /**
     * Everything a short-lived meta session needs: config + sync token + the vault keyring.
     * A caller that already opened the vault passes the keyring; one that wants to await the
     * publish passes its own publisher's `publish`.
     */
    async function metaSessionDepsFor(
        graphId: string,
        rootDocId: string,
        options: {
            keyring?: GraphKeyring;
            publishName?: (name: string) => void;
        } = {},
    ): Promise<SyncedMetaSessionDeps> {
        const connection = resolveSyncedGraphConnection(graphId);
        if (!connection)
            throw new Error(
                "Connect Managed Sync or add a custom server in Sync settings first.",
            );
        const { api } = connection;
        let keyring = options.keyring;
        if (!keyring) {
            if (!getCachedWrapKey()) throw new Error("Unlock your vault first.");
            const opened = await openHeldVault(api);
            if (!opened) throw new Error("No vault on this device");
            keyring = opened.vault.keyrings.find((k) => k.graphId === graphId);
        }
        if (!keyring) throw new Error("You do not hold this graph key");
        const held = keyring;
        return {
            graphId,
            rootDocId,
            keyring: held,
            relayUrl: connection.relayUrl,
            token: connection.token,
            // A rename from this page reaches the server's name envelope like one from the
            // workspace does, so other devices label the graph by its new name.
            publishName:
                options.publishName ??
                createGraphNamePublisher({ api, keyring: held, graphId }).publish,
        };
    }

    /** The deps for a graph already in the local registry (rootDocId lives on its handle). */
    function recordMetaDeps(
        graph: GraphRecord,
    ): Promise<SyncedMetaSessionDeps> {
        return metaSessionDepsFor(
            graph.id,
            (graph.handle as { rootDocId: string }).rootDocId,
        );
    }

    /** Open the shared Graph Settings dialog for a local graph: resolve the folder, read settings.json. */
    async function openLocalSettings(graph: GraphRecord) {
        try {
            const granted = await ensurePermission(graph.handle);
            if (!granted) {
                setRowStatus(
                    graph.id,
                    `Permission to "${graph.name}" was denied. Grant access when the browser asks, then open it again.`,
                    "error",
                );
                return;
            }
            const adapter = createWebFsDirectoryAdapter(
                graph.handle as FileSystemDirectoryHandle,
            );
            const settings = await readGraphSettings(adapter);
            localSettings = {
                record: graph,
                settings,
                adapter,
                assetTools: filesystemAssetTools(adapter),
            };
        } catch (err) {
            setRowStatus(
                graph.id,
                describeSyncFailure(err, "open the graph settings"),
                "error",
            );
        }
    }

    /** Save from the local-graph settings dialog: settings.json + the registry display name. */
    async function saveLocalSettings(result: {
        name: string;
        settings: GraphSettings;
    }) {
        const ctx = localSettings;
        localSettings = null;
        if (!ctx) return;
        try {
            await writeGraphSettings(ctx.adapter, result.settings);
            const name = result.name.trim();
            if (name && name !== ctx.record.name)
                await registry.insertGraph(
                    persistableGraphRecord(ctx.record, name),
                );
            await refresh();
        } catch (err) {
            setRowStatus(
                ctx.record.id,
                describeSyncFailure(err, "save the graph settings"),
                "error",
            );
        }
    }

    async function performRename(
        graph: GraphRecord,
        newName: string,
    ): Promise<void> {
        if (graph.backend === "server") {
            await renameSyncedGraph(await recordMetaDeps(graph), newName);
        }
        await registry.insertGraph(persistableGraphRecord(graph, newName));
        await refresh();
        setRowStatus(graph.id, `Renamed to "${newName}".`);
    }

    /**
     * Shared Graph Settings for a synced graph (ADR 0031), edited from the picker over a
     * short-lived encrypted connection. Settings are one set per graph — every member
     * shares them, like the name.
     */
    function openSyncedSettings(graph: GraphRecord) {
        void requireUnlockedVault(async () => {
            setRowStatus(graph.id, "Opening graph settings…");
            try {
                const session = await openSyncedGraphMetaSession(
                    await recordMetaDeps(graph),
                );
                syncedSettings = {
                    record: graph,
                    name: session.meta.name ?? graph.name,
                    settings: sanitizeGraphSettings(
                        session.meta.settings ?? {},
                    ),
                    session,
                };
                setStatus("");
            } catch (err) {
                setStatus(
                    `Could not open graph settings: ${(err as Error).message}`,
                    "error",
                );
            }
        });
    }

    async function saveSyncedSettings(result: {
        name: string;
        settings: GraphSettings;
    }) {
        const ctx = syncedSettings;
        syncedSettings = null;
        if (!ctx) return;
        try {
            await ctx.session.save(
                result.name,
                result.settings as Record<string, unknown>,
            );
            await registry.insertGraph(
                persistableGraphRecord(ctx.record, result.name),
            );
            await refresh();
            setRowStatus(ctx.record.id, `Saved settings for "${result.name}".`);
        } catch (err) {
            setRowStatus(
                ctx.record.id,
                describeSyncFailure(err, "save the graph settings"),
                "error",
            );
        } finally {
            ctx.session.close();
        }
    }

    function inviteToGraph(graphId: string, graphName?: string) {
        const api = syncApi();
        if (!api) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        void requireUnlockedVault(async () => {
            const heldKey = getCachedWrapKey()!;
            try {
                const existing = await api.getVault();
                if (!existing) throw new Error("No vault on this device");
                const opened = await openVault(
                    fromBase64Url(existing.vault),
                    heldKey,
                );
                setVaultWrapKey(opened.vaultKey); // self-heal: the vault key survives re-keys
                const keyring = opened.vault.keyrings.find(
                    (k) => k.graphId === graphId,
                );
                if (!keyring) throw new Error("You do not hold this graph key");
                inviteDialog = { api, graphId, graphName, keyring };
            } catch (err) {
                setRowStatus(
                    graphId,
                    describeSyncFailure(err, "start the invite"),
                    "error",
                );
            }
        });
    }

    /**
     * Open the shared transfer dialog for a graph the user owns (keyless — no unlock needed).
     *
     * A graph with no players still opens it. Refusing here reported "invite a player first"
     * into the page banner, which sits well above the row that was clicked; the dialog says
     * the same thing where the user is looking (rule 7: prefer local guidance to a dead end).
     */
    function startTransfer(graph: SyncedGraphView) {
        const api = syncApi();
        if (!api) return;
        clearRowStatus(graph.id);
        const candidates = (graph.members ?? []).filter(
            (m) => m.role === "player",
        );
        transferDialog = { api, graph, candidates };
    }

    /**
     * Register a server graph this device doesn't know yet. The record takes the name the
     * server's name envelope gave the row, or its root document read once (ADR 0031,
     * amended), or failing that the
     * one read from the encrypted meta map here; opening the graph refreshes it either way.
     * The same write repairs a record stranded under a previous account scope, and the
     * workspace's "Set it up here" runs it too (register-synced-graph.ts).
     */
    function addToDevice(graph: SyncedGraphView) {
        // Unlock-gated so the graph's REAL name can be read at add time — otherwise a
        // re-added graph shows the placeholder until first open, and a rename done before
        // Forget looks lost.
        void requireUnlockedVault(async () => {
            setRowStatus(graph.id, "Adding to this device…");
            // The row is already named: no root document download is needed.
            let name: string | undefined =
                graph.nameSource !== "placeholder" ? graph.name : undefined;
            if (!name) {
                try {
                    const session = await openSyncedGraphMetaSession(
                        await metaSessionDepsFor(graph.id, graph.rootDocId),
                    );
                    try {
                        name = session.meta.name;
                    } finally {
                        session.close();
                    }
                } catch (err) {
                    // Offline or key unavailable: keep the default; the first open heals the name.
                    console.warn(
                        "[graphs] could not read the graph name before adding it; the first open heals it",
                        err,
                    );
                }
            }
            let record: GraphRecord;
            try {
                record = await registerSyncedGraphOnDevice(
                    { id: graph.id, rootDocId: graph.rootDocId, name },
                    { registry, scope: requireActiveServerScope() },
                );
            } catch (err) {
                // Thrown inside the unlock continuation, this used to leave the row stuck on
                // "Adding to this device…" with no explanation.
                setRowStatus(
                    graph.id,
                    describeSyncFailure(err, "add the graph to this device"),
                    "error",
                );
                return;
            }
            await refresh();
            setRowStatus(graph.id, `Added "${record.name}" to this device.`);
        });
    }

    /** Permanently delete an owned graph (confirmed by typing DELETE). Every member loses it. */
    async function executeDelete() {
        const graph = deleteConfirm;
        const api = syncApi();
        if (!graph || !api || deleteBusy || deleteText !== "DELETE") return;
        deleteBusy = true;
        deleteError = null;
        try {
            await api.deleteGraph(graph.id);
            await deleteGraphCache(graph.id);
            if (graph.onDevice) {
                await registry.removeGraph(graph.id);
                if (getLastGraphId() === graph.id) clearLastGraphId();
            }
            deleteConfirm = null;
            deleteText = "";
            await refresh();
            setStatus(
                `"${graph.name}" has been permanently deleted from the sync server.`,
            );
        } catch (err) {
            // Stay open: the typed DELETE is the expensive part, and making the user retype it
            // after the server's failure reads as a punishment for someone else's fault.
            deleteError = describeSyncFailure(err, "delete the graph");
        } finally {
            deleteBusy = false;
        }
    }

    /** Drop this user's Player membership (confirmed via dialog). Keyless, like transfer. */
    async function executeLeave() {
        if (leaveBusy) return;
        const graph = leaveConfirm;
        const api = syncApi();
        if (!graph || !api) return;
        leaveBusy = true;
        try {
            await api.leaveGraph(graph.id);
            await deleteGraphCache(graph.id);
            if (graph.onDevice) {
                await registry.removeGraph(graph.id);
                if (getLastGraphId() === graph.id) clearLastGraphId();
            }
            leaveConfirm = null;
            await refresh();
            setStatus(
                `You have left "${graph.name}". Ask the owner for a new invite to rejoin.`,
            );
        } catch (err) {
            setRowStatus(
                graph.id,
                describeSyncFailure(err, "leave the graph"),
                "error",
            );
            leaveConfirm = null;
        } finally {
            leaveBusy = false;
        }
    }

    function acceptInvite(invite: (typeof invites)[number]) {
        const api = syncApi();
        if (!api) return;
        void requireUnlockedVault(async () => {
            const heldKey = getCachedWrapKey()!;
            try {
                const existing = await api.getVault();
                if (!existing) throw new Error("No vault on this device");
                const opened = await openVault(
                    fromBase64Url(existing.vault),
                    heldKey,
                );
                setVaultWrapKey(opened.vaultKey); // self-heal: the vault key survives re-keys
                const accepted = await acceptInviteFlow(
                    api,
                    invite,
                    opened.vault.identityPrivateKey,
                    opened.vaultKey,
                    existing.version,
                );
                await registry.insertGraph({
                    id: accepted.graphId,
                    // The name travels inside the sealed invite (ADR 0031); older invites lack it.
                    name: accepted.name ?? "Shared graph",
                    backend: "server",
                    createdAt: Date.now(),
                    handle: { rootDocId: accepted.rootDocId },
                    serverScope: requireActiveServerScope(),
                    membershipActive: true,
                });
                await refresh();
                setStatus(
                    "Invite accepted. The shared graph is now in your list.",
                );
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "accept the invite"),
                    "error",
                );
            }
        });
    }

    async function runUnlockThen() {
        const action = unlockThen;
        unlockThen = null;
        unlockCancelled = null;
        vaultUnlocked = getCachedWrapKey() !== null;
        if (action) await action();
        // The keys now open the name envelopes: label the graphs this device never added.
        if (vaultUnlocked) void refreshSynced();
    }

    /**
     * Mint the account's keys and Recovery Code on their own. Waiting for the first synced graph
     * made the ritual a surprise at the end of a long import, and left an account that had just
     * been reset with no way to get a code at all until it uploaded something.
     */
    function createKeys() {
        const api = syncApi();
        if (!api) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        void (async () => {
            try {
                await mintAccountKeysWithRitual(
                    api,
                    "These are your account's new encryption keys. Every synced graph you create or join from now on is protected by them.",
                );
                setStatus(
                    "Encryption keys created. Your synced graphs will use them from now on.",
                );
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "create encryption keys"),
                    "error",
                );
            }
        })();
    }

    function regenerateKit() {
        const api = syncApi();
        if (!api) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        void requireUnlockedVault(async () => {
            let prepared: RecoveryCodeRegeneration;
            try {
                prepared = await regenerateRecoveryCode(api, getCachedWrapKey()!);
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "regenerate the Recovery Code"),
                    "error",
                );
                return;
            }
            // Nothing has been written: the current code works until the user confirms they
            // have saved this one, and only then does commit re-wrap the vault (ADR 0029,
            // amended 2026-09-17). A crash or a closed tab before that changes nothing.
            let deviceKey: Uint8Array | null = null;
            promptRecoveryCode({
                code: prepared.code,
                arrival: "regenerate",
                reason: "Your current code still works. When you continue, it stops working for good and only this new code can unlock your keys. Save this one first.",
                commit: async () => {
                    deviceKey = await prepared.commit();
                },
                cancel: () => setStatus("Your Recovery Code is unchanged."),
                then: (err) => {
                    if (err) {
                        void settleFailedRegenerate(prepared, err);
                        return;
                    }
                    // Cached only now: for a legacy vault the upgrade minted this key at commit.
                    setVaultWrapKey(deviceKey!);
                    vaultUnlocked = true;
                    setStatus(REGENERATE_ACTIVE);
                },
            });
        });
    }

    const REGENERATE_ACTIVE =
        "Your new Recovery Code is active. The old one no longer works.";

    /**
     * A commit that threw is ambiguous: a request can time out after the server applied it.
     * Telling the user "your old code still works" when it does not would have them discard
     * the only working code, so ask the server which code opens the vault before saying
     * anything. Three honest outcomes; the third is the one where the server cannot be reached.
     */
    async function settleFailedRegenerate(
        prepared: RecoveryCodeRegeneration,
        err: Error,
    ): Promise<void> {
        let active: Uint8Array | null;
        try {
            active = await prepared.activeVaultKey();
        } catch {
            setStatus(
                "Could not confirm the change. Keep the new code you saved, and keep the old one too until you are back online and can regenerate again.",
                "error",
            );
            return;
        }
        if (active) {
            setVaultWrapKey(active);
            vaultUnlocked = true;
            setStatus(REGENERATE_ACTIVE);
            return;
        }
        setStatus(
            `${describeSyncFailure(err, "regenerate the Recovery Code")} Nothing changed. Your current Recovery Code still works and the new one was not activated. Try again.`,
            "error",
        );
    }

    /** Closing the dialog abandons a resumable action and fails an awaiting one. */
    function cancelUnlock() {
        const cancelled = unlockCancelled;
        unlockThen = null;
        unlockCancelled = null;
        cancelled?.();
    }

    /**
     * Reveal this account's own identity fingerprint, so an invitee can read it out and the
     * inviter's comparison in InviteDialog can be completed.
     * Needs the vault open, because the identity key lives inside it.
     */
    function showOwnFingerprint() {
        const api = syncApi();
        if (!api) {
            setStatus(
                "Add a sync server URL and access token in Sync settings first.",
                "error",
            );
            return;
        }
        fingerprintPending = true;
        void requireUnlockedVault(async () => {
            try {
                ownFingerprint = await accountIdentityFingerprint(
                    api,
                    async () => getCachedWrapKey()!,
                );
                if (!ownFingerprint) {
                    setStatus(
                        "This account has no encryption keys yet, so it has no fingerprint.",
                        "error",
                    );
                }
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "read your security fingerprint"),
                    "error",
                );
            } finally {
                fingerprintPending = false;
            }
        }).finally(() => {
            // requireUnlockedVault resolves without running the action when the user cancels.
            fingerprintPending = false;
        });
    }

    /** Unlock on its own, so the keys can be restored without regenerating the Recovery Code. */
    function unlockKeys() {
        void requireUnlockedVault(async () => {
            vaultUnlocked = true;
            setStatus("Keys unlocked on this device.");
        });
    }

    /** Clear the wrap key cached on this device - for shared machines / stepping away. */
    function lockKeys() {
        lockVault();
        vaultUnlocked = false;
        setStatus(
            "Keys locked on this device. Unlocking again needs your Recovery Code; nothing is lost.",
        );
    }

    function requireActiveServerScope(): ServerGraphScope {
        const scope = readActiveSyncAccount();
        if (!scope)
            throw new Error(
                "Authenticate with the Sync Server before adding a synced graph.",
            );
        return scope;
    }

    async function onResetComplete() {
        showReset = false;
        // Forget local synced graphs and the unlocked vault; a fresh identity is minted next time.
        for (const g of graphs.filter((x) => x.backend === "server"))
            await registry.removeGraph(g.id);
        lockVault();
        vaultUnlocked = false;
        vaultExists = false; // eager — refresh() re-checks, but don't flash the old button
        await refresh();
        setStatus(
            "Your encryption keys have been reset. Create a new synced graph to start over.",
        );
    }

    onMount(() => {
        if (page.url.searchParams.get("sync") === "connect") {
            loadSyncConfig();
            showSyncSettings = true;
        }
        // Subscribed before the first refresh, so a restore that happens inside it is caught;
        // one that happened earlier in this tab (a workspace open) is replayed on subscribe.
        const stopRecoveries = subscribeStorageRecoveries(
            (all) => (recoveries = all),
        );
        installedApp =
            window.matchMedia("(display-mode: standalone)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone ===
                true;
        void describeDeviceStorage().then((report) => (deviceStorage = report));
        void refresh();
        return stopRecoveries;
    });
</script>

<svelte:head><title>Knowledge graphs · EtherPK</title></svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8 space-y-6">
    <header class="flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-2xl font-semibold text-gray-950 dark:text-white">
            Knowledge graphs
        </h1>
        <div class="flex flex-wrap gap-2">
            {#if supported}
                <button
                    data-testid="graphs-open-folder"
                    onclick={openFolder}
                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Open folder (Local Graph)</button
                >
            {/if}
            {#if demoAvailable}
                <a
                    data-testid="graphs-try-demo"
                    href="/demo"
                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Try the demo</a
                >
            {/if}
            <button
                data-testid="graphs-create-server"
                onclick={startCreateServerGraph}
                disabled={syncPlusRequired}
                aria-disabled={syncPlusRequired}
                aria-busy={createPending}
                title={syncPlusRequired
                    ? "Synced graphs need Sync+"
                    : undefined}
                class="aria-busy:cursor-progress aria-busy:opacity-70 rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                >New synced graph</button
            >

            <button
                data-testid="graphs-import"
                onclick={() => (importDialog = true)}
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >Import</button
            >
            <button
                data-testid="graphs-sync-settings-toggle"
                onclick={() => {
                    loadSyncConfig();
                    showSyncSettings = !showSyncSettings;
                }}
                class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >Sync settings</button
            >
        </div>
    </header>

    <!--
        What this browser and this deployment can actually offer, said next to the buttons
        rather than below the whole sync form. Two situations reach here and they need
        different advice: a non-Chromium browser with a Server connected can still make synced
        graphs, but a standalone deployment opened in Firefox or Safari can make nothing at
        all, and telling that user "synced graphs work on any browser" is useless when no
        Server is connected. Gated on capabilitiesChecked so the harder notice does not flash
        before readSyncConfig() has been consulted.
    -->
    {#if !supported && capabilitiesChecked && !syncConfigured}
        <p
            class="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
            data-testid="graphs-no-backends"
        >
            <span class="font-semibold"
                >There is no way to create a graph on this device yet.</span
            >
            Keeping notes in a folder needs the File System Access API, which today
            only Chromium-based desktop browsers (Chrome, Edge, Brave) provide, and
            no Sync Server is connected here. Either open EtherPK in a Chromium desktop
            browser to use a folder, or connect a Sync Server under
            <span class="font-medium">Sync settings</span> and create a synced graph
            instead.
        </p>
    {:else if !supported}
        <p
            class="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
            data-testid="graphs-unsupported"
        >
            This browser cannot open a local folder. The Filesystem Backend
            needs the File System Access API, available today only in
            Chromium-based desktop browsers. Synced graphs work on any browser.
        </p>
    {/if}

    {#if syncConfigured}
        <section
            data-testid="sync-auth-status"
            class="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/5"
        >
            {#if syncAuthState === "authenticated" && syncAccount}
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <p
                            class="text-sm font-semibold text-gray-950 dark:text-white"
                        >
                            {syncAccount.authentication.mode === "managed"
                                ? "Signed in"
                                : "Authenticated"} as {syncAccount.principal
                                .name ??
                                syncAccount.principal.email ??
                                "Sync account"}
                        </p>
                        {#if syncAccount.principal.name && syncAccount.principal.email}
                            <p class="text-sm text-gray-500 dark:text-gray-400">
                                {syncAccount.principal.email}
                            </p>
                        {/if}
                    </div>
                    <span
                        class="rounded-full bg-emerald-50 px-2.5 py-1 text-sm font-medium text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
                        >Authenticated</span
                    >
                </div>
                {#if syncPlusRequired}
                    <div
                        class="mt-3 rounded-lg border border-indigo-200 bg-indigo-50/70 p-3 dark:border-indigo-400/20 dark:bg-indigo-950/20"
                        data-testid="sync-plus-required"
                    >
                        <p
                            class="text-sm font-medium text-gray-950 dark:text-white"
                        >
                            Free plan · no synced graphs on this plan
                        </p>
                        <p
                            class="mt-1 text-sm leading-5 text-gray-600 dark:text-gray-300"
                        >
                            Local folder graphs are free and unlimited. Sync+
                            adds end-to-end encrypted sync across your devices,
                            multiplayer and managed storage, and starts with a
                            14-day trial. Graphs shared with you still work
                            here.
                        </p>
                        {#if corporateBillingUrl}
                            <a
                                href={corporateBillingUrl}
                                data-sveltekit-reload
                                class="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                                >Start your Sync+ trial</a
                            >
                        {/if}
                    </div>
                {:else}
                    <p class="mt-3 text-sm text-gray-500 dark:text-gray-400">
                        {planLabel(syncAccount.entitlement.plan)} plan · {syncAccount.entitlement.status.replace(
                            "_",
                            " ",
                        )} · {syncAccount.entitlement.usage.ownedGraphs} of {syncAccount
                            .entitlement.limits.ownedGraphs} owned graphs · {formatBytes(
                            syncAccount.entitlement.usage.ownedStorageBytes,
                        )} of {formatBytes(
                            syncAccount.entitlement.limits.ownedStorageBytes,
                        )} owned storage
                    </p>
                    {#if syncAccount.entitlement.status === "read_only" && syncAccount.authentication.mode === "managed"}
                        <p
                            class="mt-2 text-sm leading-5 text-amber-800 dark:text-amber-200"
                            data-testid="sync-read-only-notice"
                        >
                            Your Sync+ subscription has ended, so graphs you own
                            are read-only. You can still open, export and delete
                            them. Owned graphs are deleted from the managed
                            service after a retention period, so export anything
                            you want to keep{#if corporateBillingUrl}, or <a
                                    href={corporateBillingUrl}
                                    data-sveltekit-reload
                                    class="underline">restart Sync+</a
                                >{/if}.
                        </p>
                    {/if}
                {/if}
            {:else if syncAuthState === "checking"}
                <p class="text-sm text-gray-500 dark:text-gray-400">
                    Checking your Sync account…
                </p>
            {:else if syncAuthState === "signed-out"}
                <p
                    class="text-sm font-medium text-amber-700 dark:text-amber-300"
                >
                    Not signed in to this Sync Server.
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Server-backed graphs stay hidden until the Server confirms
                    your account.
                </p>
            {:else if syncAuthState === "unavailable"}
                <p
                    class="text-sm font-medium text-amber-700 dark:text-amber-300"
                >
                    Could not confirm your Sync account.
                </p>
                <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    The last verified account remains available for offline
                    local work. Remote changes still require valid
                    authentication.
                </p>
            {/if}
        </section>
    {/if}

    {#if managedSyncAvailable}
        <!-- The form attribute on the button below associates it with this external form. This
             avoids invalid nested forms inside the Sync settings form. -->
        <form
            id="managed-global-logout"
            method="POST"
            action="/auth/logout/managed"
        ></form>
    {/if}

    {#if showSyncSettings}
        <form
            data-testid="graphs-sync-settings"
            onsubmit={(e) => {
                e.preventDefault();
                saveSyncConfig();
            }}
            class="space-y-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-white/5 p-5"
        >
            {#if managedSyncAvailable}
                <div
                    class="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/10"
                    role="tablist"
                    aria-label="Sync connection"
                >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={connectionMode === "managed"}
                        onclick={() => (connectionMode = "managed")}
                        class="rounded-md px-3 py-2 text-sm font-medium {connectionMode ===
                        'managed'
                            ? 'bg-white text-gray-950 shadow-sm dark:bg-gray-800 dark:text-white'
                            : 'text-gray-600 dark:text-gray-300'}"
                        >Managed Sync</button
                    >
                    <button
                        type="button"
                        role="tab"
                        aria-selected={connectionMode === "custom"}
                        onclick={() => (connectionMode = "custom")}
                        class="rounded-md px-3 py-2 text-sm font-medium {connectionMode ===
                        'custom'
                            ? 'bg-white text-gray-950 shadow-sm dark:bg-gray-800 dark:text-white'
                            : 'text-gray-600 dark:text-gray-300'}"
                        >Custom server</button
                    >
                </div>
            {/if}

            {#if managedSyncAvailable && connectionMode === "managed"}
                <div
                    class="rounded-lg border border-indigo-200 bg-indigo-50/70 p-4 dark:border-indigo-400/20 dark:bg-indigo-950/20"
                >
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        EtherPK Managed Sync
                    </p>
                    <p
                        class="mt-1 text-sm leading-5 text-gray-600 dark:text-gray-300"
                    >
                        Sign in once to connect this device. There is no server
                        address or access token to copy, and your graph content
                        remains end-to-end encrypted.
                    </p>
                    <div class="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="managed-sync-connect"
                            onclick={connectManagedSync}
                            class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                            >Continue to secure sign in</button
                        >
                        <button
                            type="submit"
                            form="managed-global-logout"
                            onclick={prepareManagedSignOut}
                            class="rounded-lg border border-indigo-200 bg-white/70 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-white dark:border-indigo-400/20 dark:bg-white/5 dark:text-indigo-200 dark:hover:bg-white/10"
                            >Sign out of EtherPK</button
                        >
                    </div>
                    <div
                        class="mt-3 border-t border-indigo-200 pt-3 dark:border-indigo-400/20"
                    >
                        <p
                            class="text-sm leading-5 text-gray-600 dark:text-gray-300"
                        >
                            {MANAGED_DEVICE_DISCONNECT_HELP}
                        </p>
                        <button
                            type="button"
                            onclick={disconnectManagedSync}
                            class="mt-2 rounded-lg border border-indigo-200 bg-white/70 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-white dark:border-indigo-400/20 dark:bg-white/5 dark:text-indigo-200 dark:hover:bg-white/10"
                            >Disconnect this device</button
                        >
                    </div>
                </div>
            {:else}
                <div>
                    <label
                        for="sync-url"
                        class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >Sync server URL</label
                    >
                    <input
                        id="sync-url"
                        data-testid="sync-url"
                        bind:value={serverBaseUrl}
                        placeholder="http://localhost:5173"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                    <p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        Include the scheme. Use http:// for a local server,
                        https:// for a hosted one.
                    </p>
                </div>
                <div>
                    <label
                        for="sync-token"
                        class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >Personal Access Token</label
                    >
                    <input
                        id="sync-token"
                        data-testid="sync-token"
                        type="password"
                        bind:value={token}
                        placeholder="epk_pat_…"
                        class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm font-mono text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                    />
                </div>
                <p class="text-sm text-gray-500 dark:text-gray-400">
                    Create a PAT in your server's account portal. It
                    authenticates sync but can never decrypt your notes.
                </p>
                <div class="flex justify-end">
                    <button
                        type="submit"
                        data-testid="sync-save"
                        class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                        >Save custom server</button
                    >
                </div>
            {/if}

            <div
                class="border-t border-gray-200 dark:border-gray-800 pt-4 space-y-3"
            >
                <div>
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Recovery Code
                    </p>
                    {#if vaultExists === false}
                        <!-- Fresh or just-reset account: there is no vault, so an unlock prompt
                             would ask for a Recovery Code that does not exist. -->
                        <p
                            data-testid="regenerate-code-none"
                            class="text-sm text-gray-500 dark:text-gray-400"
                        >
                            This account has no encryption keys yet. Create them
                            now to get your Recovery Code, or let your first
                            synced graph create them for you.
                        </p>
                        <button
                            type="button"
                            data-testid="create-keys"
                            onclick={createKeys}
                            class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                            >Create encryption keys</button
                        >
                    {:else}
                        <p class="text-sm text-gray-500 dark:text-gray-400">
                            Your Recovery Code is a one-off code that unlocks
                            your encryption keys on a device when no other
                            device of yours is unlocked to vouch for it. It
                            covers your whole account - every synced graph,
                            including ones you join later - and the sync server
                            never sees it, so nobody can recover your notes
                            without it.
                        </p>
                        <p
                            class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                        >
                            Regenerating shows you a new code. Your current
                            code keeps working until you confirm you have saved
                            the new one, then it is retired for good. Devices
                            already unlocked stay unlocked. Do it if you never
                            saved your code, or think someone else may have seen
                            it.
                        </p>
                        <button
                            type="button"
                            data-testid="regenerate-code"
                            onclick={regenerateKit}
                            class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                            >Regenerate Recovery Code</button
                        >
                    {/if}
                </div>
                <div>
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Unlock keys on this device
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        Restore this device's access with your Recovery Code, or
                        by approving from a device that is already unlocked.
                        Needed after clearing site data or signing out
                        everywhere - and you do not have to own a synced graph
                        to do it.
                    </p>
                    <button
                        type="button"
                        data-testid="unlock-keys"
                        onclick={unlockKeys}
                        disabled={vaultUnlocked || vaultExists === false}
                        class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >{vaultUnlocked
                            ? "Keys are unlocked"
                            : "Unlock keys"}</button
                    >
                </div>
                <div>
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Your security fingerprint
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        When somebody invites you to their graph, they are shown
                        a fingerprint for your account and asked to check it is
                        really yours. This is the one to read out to them, in
                        person or over a call you trust. It is not a secret.
                    </p>
                    {#if ownFingerprint}
                        <code
                            data-testid="own-fingerprint"
                            class="mt-2 block break-all rounded-lg bg-gray-100 dark:bg-white/5 px-4 py-3 text-center text-sm font-mono tracking-wide text-gray-950 dark:text-gray-100"
                            >{ownFingerprint}</code
                        >
                    {:else}
                        <button
                            type="button"
                            data-testid="show-own-fingerprint"
                            onclick={showOwnFingerprint}
                            disabled={fingerprintPending ||
                                vaultExists === false}
                            class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                            >{fingerprintPending
                                ? "Reading…"
                                : "Show my fingerprint"}</button
                        >
                        {#if vaultExists === false}
                            <p
                                class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                            >
                                Create your encryption keys first; a fingerprint
                                identifies them.
                            </p>
                        {/if}
                    {/if}
                </div>
                <div>
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Lock keys on this device
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        Once unlocked, your keys stay available on this device
                        so you are not asked for your Recovery Code in every
                        tab. Lock them when stepping away from a shared machine,
                        or if this device can no longer read your notes: locking
                        and then unlocking again replaces the keys held here.
                        Nothing is lost, and unlocking again just needs the
                        code.
                    </p>
                    <button
                        type="button"
                        data-testid="lock-keys"
                        onclick={lockKeys}
                        disabled={!vaultUnlocked}
                        class="mt-2 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >{vaultUnlocked
                            ? "Lock keys"
                            : "Keys are locked"}</button
                    >
                </div>
                <div data-testid="device-storage">
                    <p
                        class="text-sm font-medium text-gray-950 dark:text-white"
                    >
                        Storage on this device
                    </p>
                    {#if deviceStorage?.persisted === true}
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-persisted"
                        >
                            This browser has agreed to keep EtherPK's local data
                            on this device rather than clearing it to free
                            space.
                        </p>
                    {:else if deviceStorage?.persisted === false}
                        <!-- The honest version of "your data is safe here": on a phone it is not, unless the
                             browser has been given a reason to keep it. -->
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-best-effort"
                        >
                            This browser may clear EtherPK's data on this device
                            to free up space. Which synced graphs and passkeys
                            belong here is also kept in local storage, which
                            survives that, but a graph's documents then download
                            again from the sync server.
                            {#if !installedApp}
                                Installing EtherPK to your home screen, or
                                bookmarking it, usually persuades the browser to
                                keep the data.
                            {/if}
                        </p>
                    {:else}
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-unknown"
                        >
                            This browser does not say whether it will keep
                            EtherPK's data when space runs low. Which synced
                            graphs and passkeys belong here is also kept in
                            local storage either way.
                        </p>
                    {/if}
                    {#if deviceStorage?.usage !== null && deviceStorage?.usage !== undefined}
                        <p
                            class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-usage"
                        >
                            EtherPK is using {formatBytes(deviceStorage.usage)} here{deviceStorage.quota !==
                            null
                                ? ` of the ${formatBytes(deviceStorage.quota)} this browser allows`
                                : ""}.
                        </p>
                    {/if}
                </div>
                <div>
                    <p class="text-sm font-medium text-red-600">
                        Reset encryption keys
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        Start over with new keys. Graphs you own are permanently
                        deleted unless you first hand them to another player.
                        This cannot be undone.
                    </p>
                    <p class="text-sm text-gray-500 dark:text-gray-400">
                        Only this device having trouble? A graph that says it is
                        not in this browser is fixed by <span
                            class="font-medium">Add to this device</span
                        >
                        above, and keys that will not open your notes by
                        <span class="font-medium">Lock keys</span>
                        then <span class="font-medium">Unlock keys</span>.
                        Neither deletes anything.
                    </p>
                    <button
                        type="button"
                        data-testid="reset-keys"
                        onclick={() => (showReset = true)}
                        class="mt-2 rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >Reset encryption keys</button
                    >
                </div>
            </div>
        </form>
    {/if}

    <!--
        One slot still carries every page-level outcome, but it is at least announced now.
        Per-row failures that belong beside their graph (delete, leave) report in their own
        dialog instead of travelling up here.
    -->
    {#if status}
        <p
            data-testid="graphs-status"
            role={statusTone === "error" ? "alert" : "status"}
            class="text-sm {statusTone === 'error'
                ? 'text-red-600'
                : 'text-gray-600 dark:text-gray-400'}"
        >
            {status}
        </p>
    {/if}

    {#if invites.length > 0}
        <section
            data-testid="graphs-invites"
            class="rounded-xl border border-gray-900/15 dark:border-gray-100/20 bg-white dark:bg-white/5 p-4"
        >
            <h2 class="text-sm font-semibold text-gray-950 dark:text-white">
                Pending invites
            </h2>
            <ul class="mt-3 space-y-2">
                {#each invites as invite (invite.id)}
                    <li class="flex items-center justify-between gap-3">
                        <span class="text-sm text-gray-700 dark:text-gray-300"
                            >You have been invited to a shared graph.</span
                        >
                        <button
                            data-testid="invite-accept"
                            onclick={() => acceptInvite(invite)}
                            class="shrink-0 rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                            >Accept</button
                        >
                    </li>
                {/each}
            </ul>
        </section>
    {/if}

    {#if recoveries.length > 0}
        <!-- Stays until dismissed: it explains a slow next open and rules out the sync server
             as the cause, which is exactly what a person who has just lost sight of their
             graphs wants to know before they reach for Reset (2026-09-01, 2026-09-10). -->
        <div
            data-testid="storage-recovered"
            role="status"
            class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-950/30"
        >
            <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 text-amber-900 dark:text-amber-100">
                    <p class="text-sm font-medium">
                        {STORAGE_RECOVERY_HEADLINE}
                    </p>
                    <p class="mt-1 text-sm">{STORAGE_RECOVERY_INTRO}</p>
                    <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm">
                        {#each recoveredItems as item (item)}
                            <li>{item}</li>
                        {/each}
                    </ul>
                    <p class="mt-2 text-sm text-amber-800 dark:text-amber-200">
                        {STORAGE_RECOVERY_FOOTNOTE}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="storage-recovered-dismiss"
                    onclick={acknowledgeStorageRecoveries}
                    class="shrink-0 rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:text-amber-100 dark:hover:bg-amber-900/40"
                    >Dismiss</button
                >
            </div>
        </div>
    {/if}

    <section data-testid="graphs-on-device" class="space-y-3">
        <div>
            <h2 class="text-lg font-semibold text-gray-950 dark:text-white">
                Graphs on this device
            </h2>
            <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                Local folders and synced graphs set up in this browser.
            </p>
        </div>

        {#snippet pickerRow(graph: GraphRecord)}
            <GraphPickerRow
                {graph}
                message={rowMessage[graph.id] ?? null}
                onopen={() => void openGraph(graph)}
                onrename={() => renameGraph(graph)}
                onsettings={() =>
                    graph.backend === "server"
                        ? openSyncedSettings(graph)
                        : void openLocalSettings(graph)}
                onforget={() => (forgetConfirm = graph)}
                onreset={() => void goto("/demo?reset=1")}
            />
        {/snippet}

        <!-- Skipped when the demo is the only graph: an empty box reading "No graphs yet … try
             the demo" beside the demo itself would offer what is already there. -->
        {#if ordinaryGraphs.length > 0 || graphs.length === 0}
            <ul
                data-testid="graphs-list"
                class="divide-y divide-gray-200 dark:divide-white/10 rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden"
            >
                {#each ordinaryGraphs as graph (graph.id)}
                    {@render pickerRow(graph)}
                {:else}
                    <!-- "None" and "could not be read" are different sentences, and only one of
                         them should let someone believe their graphs are gone. -->
                    {#if registryUnreadable}
                        <li
                            class="px-4 py-6 text-center text-sm text-red-600"
                            data-testid="graphs-unreadable"
                        >
                            Your graphs could not be read from this browser's storage.
                            Nothing has been deleted.
                        </li>
                    {:else}
                        <li
                            class="px-4 py-6 text-center text-sm text-gray-500"
                            data-testid="graphs-empty"
                        >
                            No graphs yet. Open a folder, create a synced graph, or <a
                                href="/demo"
                                class="underline hover:text-gray-700 dark:hover:text-gray-300"
                                >try the demo</a
                            >.
                        </li>
                    {/if}
                {/each}
            </ul>
        {/if}

        {#if demoGraph}
            <ul
                data-testid="graphs-demo-list"
                class="rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden"
            >
                {@render pickerRow(demoGraph)}
            </ul>
        {/if}
    </section>

    {#if syncConfigured}
        <section data-testid="synced-graphs" class="space-y-3">
            <div>
                <h2 class="text-lg font-semibold text-gray-950 dark:text-white">
                    Synced graphs
                </h2>
                <p class="mt-2 mb-2 text-sm text-gray-500 dark:text-gray-400">
                    Your memberships on the sync server. Names sync end-to-end
                    encrypted. The server only ever sees ciphertext. When you
                    add a graph to this device, the name will be shown.
                </p>
                <p
                    class="text-sm text-gray-500 dark:text-gray-400"
                    data-testid="synced-graphs-import-hint"
                >
                    To move a local graph to synced storage, create a new graph
                    via <button
                        class="underline hover:text-gray-700 dark:hover:text-gray-300"
                        onclick={() => (importDialog = true)}>Import</button
                    >.
                </p>
                {#if ownedStorage && ownedStorage.graphs > 0}
                    <p
                        class="text-sm text-gray-500 dark:text-gray-400"
                        data-testid="synced-owned-storage"
                    >
                        Graphs you own use {formatBytes(
                            ownedStorage.docBytes + ownedStorage.assetBytes,
                        )} on the server ({formatBytes(ownedStorage.docBytes)} notes
                        · {formatBytes(ownedStorage.assetBytes)} assets across {ownedStorage.graphs}
                        {ownedStorage.graphs === 1 ? "graph" : "graphs"}).
                    </p>
                {/if}
            </div>
            {#if syncedError}
                <p
                    class="text-sm text-red-600"
                    data-testid="synced-graphs-error"
                >
                    Could not reach the sync server: {syncedError}
                </p>
            {:else if syncedLoading && syncedGraphs.length === 0}
                <!-- First load only: later refreshes keep the cards in place while data renews. -->
                <p
                    class="flex items-center gap-2 text-sm text-gray-500"
                    data-testid="synced-graphs-loading"
                >
                    <svg
                        class="h-4 w-4 motion-safe:animate-spin text-gray-400"
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                    >
                        <circle
                            class="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            stroke-width="3"
                        />
                        <path
                            class="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z"
                        />
                    </svg>
                    Loading synced graphs…
                </p>
            {:else if syncedGraphs.length === 0}
                <p
                    class="text-sm text-gray-500"
                    data-testid="synced-graphs-empty"
                >
                    No synced graphs on this server yet.
                </p>
            {:else}
                <ul class="space-y-3">
                    {#each syncedGraphs as g (g.id)}
                        <li
                            data-testid="synced-graph"
                            class="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-4 space-y-3"
                        >
                            <div class="flex flex-wrap items-center gap-2">
                                <span
                                    class="text-sm font-medium text-gray-950 dark:text-white truncate"
                                    >{g.name}</span
                                >
                                <span
                                    data-testid="synced-role"
                                    class="rounded-full px-2 py-0.5 text-sm {g.role ===
                                    'owner'
                                        ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                                        : 'bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400'}"
                                    >{g.role === "owner"
                                        ? "Owner"
                                        : "Player"}</span
                                >
                                {#if !g.onDevice}
                                    <span
                                        class="text-sm text-gray-400 dark:text-gray-500"
                                        data-testid="synced-not-local"
                                        >Not on this device</span
                                    >
                                {/if}
                            </div>
                            <p
                                class="truncate font-mono text-sm text-gray-400 dark:text-gray-500 select-all"
                                data-testid="synced-id"
                            >
                                {g.id}
                            </p>
                            {#if rowMessage[g.id]}
                                <p
                                    data-testid="synced-graph-status"
                                    role={rowMessage[g.id].tone === "error"
                                        ? "alert"
                                        : "status"}
                                    class="text-sm {rowMessage[g.id].tone ===
                                    'error'
                                        ? 'text-red-600'
                                        : 'text-gray-600 dark:text-gray-400'}"
                                >
                                    {rowMessage[g.id].text}
                                </p>
                            {/if}
                            {#if g.storage}
                                <p
                                    class="text-sm text-gray-500 dark:text-gray-400"
                                    data-testid="synced-storage"
                                >
                                    {formatBytes(g.storage.docBytes)} notes · {formatBytes(
                                        g.storage.assetBytes,
                                    )} assets
                                </p>
                            {/if}
                            {#if !g.onDevice && g.nameSource === "placeholder"}
                                <!-- The row could not be labelled yet. Say why and what changes it: the
                                     keys are locked here; the graph is being read; it has no name at all;
                                     the relay did not answer; or this account holds no key for it (ADR
                                     0031, amended). The line must never read as a key failure: "Encrypted
                                     name" once sent a user towards Reset (2026-09-01). -->
                                <p
                                    class="text-sm text-gray-400 dark:text-gray-500"
                                    data-testid="synced-name-encrypted"
                                    aria-live="polite"
                                >
                                    {#if !vaultUnlocked}
                                        Unlock keys on this device to see its
                                        name.
                                    {:else if nameReads[g.id] === "reading"}
                                        Reading its name from the graph…
                                    {:else if nameReads[g.id] === "unnamed"}
                                        This graph has no name yet. Add it to
                                        this device and open it to give it one.
                                    {:else if nameReads[g.id] === "unreachable"}
                                        Its name could not be read: the sync
                                        server's relay did not answer. It appears
                                        once any member opens the graph, or once
                                        you add it here.
                                    {:else}
                                        This account holds no key for this graph
                                        yet, so its name cannot be read here.
                                    {/if}
                                </p>
                            {/if}
                            {#if g.role === "owner"}
                                {#if g.members}
                                    <ul
                                        data-testid="synced-members"
                                        class="space-y-1 border-t border-gray-100 dark:border-white/10 pt-3"
                                    >
                                        {#each g.members as m (m.userId)}
                                            <li
                                                class="flex items-center gap-2 text-sm"
                                            >
                                                <span
                                                    class="text-gray-700 dark:text-gray-300 truncate"
                                                    >{m.email}</span
                                                >
                                                <span
                                                    class="rounded-full bg-gray-100 dark:bg-white/10 px-2 py-0.5 text-sm text-gray-600 dark:text-gray-400"
                                                >
                                                    {m.role === "owner"
                                                        ? "Owner"
                                                        : "Player"}
                                                </span>
                                            </li>
                                        {/each}
                                    </ul>
                                {:else}
                                    <p
                                        class="text-sm text-gray-400 dark:text-gray-500 border-t border-gray-100 dark:border-white/10 pt-3"
                                    >
                                        Could not load the member list.
                                    </p>
                                {/if}
                            {/if}
                            <div
                                class="flex flex-wrap gap-2 border-t border-gray-100 dark:border-white/10 pt-3"
                            >
                                {#if !g.onDevice}
                                    <button
                                        data-testid="graphs-add-device"
                                        onclick={() => addToDevice(g)}
                                        class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                        >Add to this device</button
                                    >
                                {/if}
                                {#if g.role === "owner"}
                                    <button
                                        data-testid="graphs-invite"
                                        onclick={() =>
                                            inviteToGraph(
                                                g.id,
                                                g.onDevice ? g.name : undefined,
                                            )}
                                        class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                        >Invite</button
                                    >
                                    <button
                                        data-testid="graphs-transfer"
                                        onclick={() => startTransfer(g)}
                                        class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                        >Transfer ownership</button
                                    >
                                    <button
                                        data-testid="graphs-delete"
                                        onclick={() => {
                                            deleteText = "";
                                            deleteConfirm = g;
                                            deleteError = null;
                                            deleteText = "";
                                        }}
                                        class="shrink-0 rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                                        >Delete</button
                                    >
                                {:else}
                                    <button
                                        data-testid="graphs-leave"
                                        onclick={() => (leaveConfirm = g)}
                                        class="shrink-0 rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                                        >Leave</button
                                    >
                                {/if}
                            </div>
                        </li>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
</div>

{#if importDialog}
    <ImportGraphDialog
        {registry}
        syncTarget={syncPlusRequired ? null : importSyncTarget()}
        syncUnavailableReason={syncPlusRequired
            ? "Synced graphs need Sync+. Start your trial from Billing first."
            : undefined}
        getWrapKey={importWrapKey}
        ensureVaultReady={ensureVaultReadyForSyncedImport}
        assetLimits={syncAccount?.entitlement.limits ?? null}
        opfsDestination={dev && page.url.searchParams.get("fs") === "opfs"}
        onclose={() => (importDialog = false)}
        onimported={onImported}
        onsettled={onImportSettled}
    />
{/if}

{#if inviteDialog}
    <InviteDialog
        api={inviteDialog.api}
        graphId={inviteDialog.graphId}
        graphName={inviteDialog.graphName}
        keyring={inviteDialog.keyring}
        onclose={(result) => {
            const invitedGraphId = inviteDialog?.graphId;
            inviteDialog = null;
            if (result && invitedGraphId)
                setRowStatus(
                    invitedGraphId,
                    `Invite sent to ${result.sentTo}.`,
                );
        }}
    />
{/if}

{#if showReset}
    <ResetDialog
        onclose={() => (showReset = false)}
        oncomplete={onResetComplete}
    />
{/if}

{#if transferDialog}
    <TransferOwnershipDialog
        api={transferDialog.api}
        graphId={transferDialog.graph.id}
        graphName={transferDialog.graph.name}
        candidates={transferDialog.candidates}
        onclose={(result) => {
            const transferredGraphId = transferDialog?.graph.id;
            transferDialog = null;
            if (result && transferredGraphId) {
                setRowStatus(
                    transferredGraphId,
                    `Ownership transferred to ${result.email}. You stay on as a player.`,
                );
                void refreshSynced();
            }
        }}
    />
{/if}

{#if deleteConfirm}
    <Modal
        open={true}
        title="Delete graph"
        busy={deleteBusy}
        busyReason="Deleting…"
        onclose={() => (deleteConfirm = null)}
        onsubmit={executeDelete}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Permanently delete <span
                    class="font-medium text-gray-900 dark:text-gray-200"
                    >{deleteConfirm!.name}</span
                >? This deletes the graph from the sync server
                <span class="font-medium text-gray-900 dark:text-gray-200"
                    >for every member</span
                >
                - the encrypted notes are discarded and cannot be recovered.
                {#if deletePlayerCount > 0}
                    <span class="font-medium text-red-600">
                        {deletePlayerCount} other member{deletePlayerCount === 1
                            ? ""
                            : "s"} will lose access too.</span
                    >
                {:else}
                    You are the only member.
                {/if}
            </p>
            {#if deleteConfirm!.onDevice}
                <p
                    class="text-sm text-gray-600 dark:text-gray-400"
                    data-testid="delete-local-note"
                >
                    The synced copy in the local browser cache is deleted with
                    it. Files you mirrored to a local folder are not deleted.
                </p>
            {:else}
                <p
                    class="text-sm text-gray-600 dark:text-gray-400"
                    data-testid="delete-remote-note"
                >
                    This graph is not on this device — the deletion happens on
                    the sync server, and on every member's next sync.
                </p>
            {/if}
            <div>
                <label
                    for="delete-confirm"
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                >
                    Type <span
                        class="font-semibold text-gray-700 dark:text-gray-300"
                        >DELETE</span
                    > to confirm
                </label>
                <input
                    id="delete-confirm"
                    data-testid="graphs-delete-input"
                    bind:value={deleteText}
                    autocomplete="off"
                    aria-invalid={deleteError ? "true" : undefined}
                    aria-describedby={deleteError ? "delete-error" : undefined}
                    class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 {deleteError
                        ? 'border-red-400 dark:border-red-500/60'
                        : 'border-gray-300 dark:border-gray-700'}"
                />
            </div>
            <!-- A transient failure used to close the dialog and throw away the typed DELETE,
                 reporting into a banner some distance up the page. Retry keeps its context. -->
            {#if deleteError}
                <p
                    id="delete-error"
                    role="alert"
                    class="text-sm text-red-600"
                    data-testid="graphs-delete-error"
                >
                    {deleteError}
                </p>
            {/if}
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                onclick={() => (deleteConfirm = null)}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="submit"
                disabled={deleteBusy || deleteText !== "DELETE"}
                data-testid="graphs-delete-confirm"
                class="min-w-44 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{deleteBusy ? "Deleting…" : "Permanently delete"}</button
            >
        {/snippet}
    </Modal>
{/if}

{#if createDialog}
    <Modal
        open={true}
        title="New synced graph"
        busy={createBusy}
        busyReason="Creating…"
        onclose={() => (createDialog = false)}
        onsubmit={() => void createServerGraph(createName.trim())}
    >
        {#snippet body()}
            <div>
                <label
                    for="create-graph-name"
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                    >Graph name</label
                >
                <input
                    id="create-graph-name"
                    data-testid="create-graph-name"
                    bind:value={createName}
                    placeholder="e.g. Work Notes"
                    autocomplete="off"
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                />
                <p
                    id="create-graph-hint"
                    class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                >
                    {createName.trim() === ""
                        ? "Give the graph a name to create it."
                        : "Every member will see this name. You can rename it later."}
                </p>
            </div>
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                onclick={() => (createDialog = false)}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="submit"
                disabled={createBusy || createName.trim() === ""}
                aria-describedby="create-graph-hint"
                data-testid="create-graph-confirm"
                class="min-w-36 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >{createBusy ? "Creating…" : "Create graph"}</button
            >
        {/snippet}
    </Modal>
{/if}

{#if localSettings}
    <GraphSettingsDialog
        graphId={localSettings.record.id}
        name={localSettings.record.name}
        settings={localSettings.settings}
        assetTools={localSettings.assetTools}
        nameHelp="Changes the display name only; the folder on disk keeps its name."
        onsave={(result) => void saveLocalSettings(result)}
        onclose={() => (localSettings = null)}
    />
{/if}

{#if syncedSettings}
    <GraphSettingsDialog
        graphId={syncedSettings.record.id}
        name={syncedSettings.name}
        settings={syncedSettings.settings}
        storageInfo={syncedGraphs.find(
            (g) => g.id === syncedSettings?.record.id,
        )?.storage ?? null}
        onsave={(result) => void saveSyncedSettings(result)}
        onclose={() => {
            syncedSettings?.session.close();
            syncedSettings = null;
        }}
    />
{/if}

{#if renameDialog}
    <RenameGraphDialog
        name={renameDialog.name}
        help={renameDialog.backend === "server"
            ? "Changes the graph name for all members."
            : "Changes the display name only; the folder on disk retains its name."}
        onsave={(newName) => performRename(renameDialog!, newName)}
        onclose={() => (renameDialog = null)}
    />
{/if}

{#if forgetConfirm}
    <Modal
        open={true}
        title="Forget graph"
        onclose={() => (forgetConfirm = null)}
        onsubmit={executeForget}
    >
        {#snippet body()}
            {#if forgetConfirm!.backend === "server"}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Forget <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{forgetConfirm!.name}</span
                    >? This deletes the graph's local copy from this browser's
                    cache. The graph remains on the sync server - add it back
                    any time. Deleting the graph for all members (owner only) is
                    done from the Synced graphs panel.
                </p>
            {:else}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Forget <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{forgetConfirm!.name}</span
                    >? Forgetting will remove the graph from this list. Delete
                    the files on disk manually if you require full deletion.
                </p>
            {/if}
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                onclick={() => (forgetConfirm = null)}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="submit"
                data-testid="graphs-forget-confirm"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                >Forget</button
            >
        {/snippet}
    </Modal>
{/if}

{#if leaveConfirm}
    <Modal
        open={true}
        title="Leave graph"
        busy={leaveBusy}
        busyReason="Leaving…"
        onclose={() => (leaveConfirm = null)}
        onsubmit={executeLeave}
    >
        {#snippet body()}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Leave <span class="font-medium text-gray-900 dark:text-gray-200"
                    >{leaveConfirm!.name}</span
                >? You lose access until the owner invites you again. The graph
                itself, and the other members, are untouched.
            </p>
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                onclick={() => (leaveConfirm = null)}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="submit"
                disabled={leaveBusy}
                data-testid="graphs-leave-confirm"
                class="min-w-32 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{leaveBusy ? "Leaving…" : "Leave graph"}</button
            >
        {/snippet}
    </Modal>
{/if}

<!-- Last in the document so it stacks above the import and create dialogs that ask for it. -->
{#if unlockThen}
    <UnlockDialog onunlocked={runUnlockThen} onclose={cancelUnlock} />
{/if}
