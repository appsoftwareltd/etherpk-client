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
    import { readKnownGraphFolders } from "$lib/storage/folder-ownership";
    import {
        findFolderOwner,
        openAsLocalGraphRefusal,
    } from "$lib/storage/server/mirror-takeover";
    import {
        discardIndexPool,
        discardUnlistedIndexPools,
    } from "$lib/document/index-pool-discard";
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
        VaultLockedError,
    } from "$lib/sync";
    import type { SyncAccountSummary } from "@appsoftwareltd/etherpk-shared";
    import { EnvelopeError, fromBase64Url, openVault, type GraphKeyring } from "$lib/crypto";
    import { promptRecoveryCode } from "$lib/sync/recovery-code-prompt";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import { ownerCanWrite, syncPlanNotice } from "$lib/sync/sync-plan-notice";
    import InviteDialog from "$lib/sync/ui/InviteDialog.svelte";
    import UnlockDialog from "$lib/sync/ui/UnlockDialog.svelte";
    import ResetDialog from "$lib/sync/ui/ResetDialog.svelte";
    import TransferOwnershipDialog from "$lib/sync/ui/TransferOwnershipDialog.svelte";
    import RenameGraphDialog from "$lib/sync/ui/RenameGraphDialog.svelte";
    import GraphSettingsDialog from "$lib/sync/ui/GraphSettingsDialog.svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import {
        acceptUnlessUnsent,
        discardUnlessUnsent,
        saveUnsentChangesFile,
        staleCopyUnsentChanges,
        type UnsentDocument,
    } from "$lib/sync/unsent-changes";
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
    /** The notice beside the plan line: a failed payment, a lapse, or the Sync+ offer. */
    const planNotice = $derived(
        syncAuthState === "authenticated" && syncAccount
            ? syncPlanNotice(syncAccount)
            : null,
    );
    /**
     * Why a synced graph cannot be created or imported here. It names no trial: Checkout gives
     * one only to an account that never subscribed, and a lapsed owner is the common case.
     */
    const syncPlusRequiredMessage = $derived(
        planNotice === "ended"
            ? "Synced graphs need Sync+. Restart it from Billing to create one."
            : planNotice === "unconfirmed"
              ? "Your plan cannot be confirmed right now, so no synced graph can be created. Try again in a few minutes."
              : "Synced graphs need Sync+. Start it from Billing to create one.",
    );
    /** Owned graphs refuse writes and new Players while the owner's plan is not active. */
    const ownedGraphsWritable = $derived(ownerCanWrite(syncAccount));
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
    /**
     * An invite to a graph this browser still holds a copy of with changes the server never
     * received. Accepting discards the copy, so the person sees what would be lost, can download
     * it, and confirms or cancels.
     */
    let staleCopy = $state<{
        invite: (typeof invites)[number];
        unsent: UnsentDocument[];
        graphName: string;
        downloaded: boolean;
        /** More became unsent after the dialog opened, so the count was taken again. */
        grew?: boolean;
    } | null>(null);
    /** The invite whose local copy is being checked, so a second press does not start another. */
    let checkingInvite = $state<string | null>(null);
    let leaveBusy = $state(false);
    let deleteConfirm = $state<SyncedGraphView | null>(null);
    let deleteText = $state("");
    let deleteBusy = $state(false);
    /** Reported inside the delete dialog, so a retry keeps the typed confirmation. */
    let deleteError = $state<string | null>(null);
    let renameDialog = $state<GraphRecord | null>(null);
    let forgetConfirm = $state<GraphRecord | null>(null);
    let forgetBusy = $state(false);
    /** Reported inside the Forget dialog, which stays open so the person can retry or cancel. */
    let forgetError = $state<string | null>(null);
    /**
     * What Forget or Leave would delete that the server never received: this browser's unsent
     * changes to the graph, read before the dialog opens and again at the moment of deleting,
     * because another tab may still be typing into it.
     */
    let discardUnsent = $state<{
        graphId: string;
        unsent: UnsentDocument[];
        downloaded: boolean;
        /** More became unsent after the dialog opened, so the count was taken again. */
        grew?: boolean;
    } | null>(null);
    /** The graph whose copy is being checked, so a second press does not start another check. */
    let discardChecking = $state<string | null>(null);
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

    /**
     * Re-read the plan when the tab comes back into view. The page stays open for days, and a
     * card fixed or a plan lapsed in another tab would otherwise show the old state until a reload.
     * Quiet on purpose: it never shows "Checking…" (the card would flicker on every tab switch)
     * and replaces the answer only with a fresh one for the same account. Signing out, failures
     * and account changes stay with the full refresh.
     */
    let planRecheck: Promise<void> | null = null;
    function recheckPlanQuietly() {
        if (
            document.visibilityState !== "visible" ||
            syncAuthState !== "authenticated" ||
            planRecheck
        )
            return;
        const api = syncApi();
        const principalId = syncAccount?.principal.id;
        if (!api || !principalId) return;
        planRecheck = api
            .me()
            .then((account) => {
                if (
                    syncAuthState === "authenticated" &&
                    account.principal.id === principalId
                )
                    syncAccount = account;
            })
            // Keeping the last answer is the right outcome for a failed background read.
            .catch(() => undefined)
            .finally(() => {
                planRecheck = null;
            });
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
        if (syncPlusRequired) throw new Error(syncPlusRequiredMessage);
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
            // Checked before anything is written into the folder. A synced graph's mirror is put
            // back to match that graph on its next pass, so work done in it (or in a folder
            // overlapping it) as a local graph would be lost or mixed with the mirror's; a folder
            // already open as a local graph is opened as that graph, not registered twice.
            const owner = await findFolderOwner(
                handle,
                await readKnownGraphFolders(),
            );
            if (owner?.kind === "mirror") {
                setStatus(openAsLocalGraphRefusal(handle.name, owner), "error");
                return;
            }
            if (owner?.kind === "local-graph" && owner.relation === "same") {
                await goto(`/g/${owner.graphId}`);
                return;
            }
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
                    setStatus(syncPlusRequiredMessage, "error");
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

    /**
     * The graph's search index goes from this browser with the graph: it holds the graph's note
     * text, block by block. Not awaited: the discard waits for a worker that is still letting go
     * of the pool, and a tab that still has the graph open keeps it, in which case the sweep the
     * next time this page loads discards it ({@link sweepIndexPools}).
     */
    function discardGraphIndex(graphId: string): void {
        void discardIndexPool(graphId).catch((error) =>
            console.warn("[index] could not discard the search index of", graphId, error),
        );
    }

    /**
     * Discard the search index of every graph this browser holds no record of: one a tab held
     * when it was deleted, left or forgotten, or one an older build left behind. Against every
     * record on the device, not the list this page shows: a signed-out, expired or other account
     * hides its synced graphs without them being gone, and sweeping against the visible list
     * would discard their indexes after every session expiry. A registry read of its own, so an
     * unreadable registry sweeps nothing rather than everything.
     */
    async function sweepIndexPools(): Promise<void> {
        try {
            await discardUnlistedIndexPools(await registry.listAllGraphIds());
        } catch (error) {
            console.warn("[index] could not sweep unlisted search indexes", error);
        }
    }

    /** A synced registry record's root document id, which lives on its handle. */
    function rootDocIdOf(graph: GraphRecord): string {
        return (graph.handle as { rootDocId: string }).rootDocId;
    }

    /** The unsent documents the open dialog listed for `graphId`: what the person agreed to lose. */
    function agreedUnsent(graphId: string): string[] {
        return discardUnsent?.graphId === graphId ? discardUnsent.unsent.map((document) => document.docId) : [];
    }

    /**
     * Read what this browser holds for a synced graph that the server never received, before a
     * dialog offers to delete it. A failed read opens nothing: deleting what could not be checked
     * is exactly the loss this guards against.
     */
    async function checkUnsentBeforeDiscard(graphId: string, rootDocId: string, name: string): Promise<boolean> {
        discardChecking = graphId;
        try {
            discardUnsent = { graphId, unsent: await staleCopyUnsentChanges(graphId, rootDocId), downloaded: false };
            return true;
        } catch (err) {
            setStatus(
                `Could not check this browser's copy of "${name}" for changes the server has not received, so nothing was changed: ${(err as Error).message}. Try again.`,
                "error",
            );
            return false;
        } finally {
            discardChecking = null;
        }
    }

    async function askForget(graph: GraphRecord) {
        if (discardChecking) return;
        discardUnsent = null;
        forgetError = null;
        if (graph.backend === "server" && !(await checkUnsentBeforeDiscard(graph.id, rootDocIdOf(graph), graph.name))) return;
        forgetConfirm = graph;
    }

    async function askLeave(graph: SyncedGraphView) {
        if (discardChecking) return;
        discardUnsent = null;
        if (!(await checkUnsentBeforeDiscard(graph.id, graph.rootDocId, graph.name))) return;
        leaveConfirm = graph;
    }

    function downloadDiscardUnsent(name: string) {
        if (!discardUnsent) return;
        saveUnsentChangesFile(discardUnsent.unsent, name);
        discardUnsent = { ...discardUnsent, downloaded: true };
    }

    /**
     * Forget (confirmed via dialog): local record only; a synced graph also drops its cache. The
     * cache holds the outbox, so its unsent changes go too: deleted only when there are none, or
     * when the person saw them counted and chose to discard them.
     */
    async function executeForget() {
        const graph = forgetConfirm;
        if (!graph || forgetBusy) return;
        forgetBusy = true;
        forgetError = null;
        try {
            if (graph.backend === "server") {
                const outcome = await discardUnlessUnsent(
                    { graphId: graph.id, rootDocId: rootDocIdOf(graph) },
                    { inspect: staleCopyUnsentChanges, discard: () => deleteGraphCache(graph.id), agreed: agreedUnsent(graph.id) },
                );
                if (outcome.kind === "confirm") {
                    // More became unsent since the dialog opened: count it again and ask again.
                    discardUnsent = { graphId: graph.id, unsent: outcome.unsent, downloaded: false, grew: true };
                    return;
                }
            }
            discardGraphIndex(graph.id);
            await registry.removeGraph(graph.id);
            if (getLastGraphId() === graph.id) clearLastGraphId();
            forgetConfirm = null;
            discardUnsent = null;
            await refresh();
        } catch (err) {
            forgetError = describeSyncFailure(err, "forget the graph");
        } finally {
            forgetBusy = false;
        }
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
                    // Keys that cannot open this graph are not "offline": adding it under a
                    // placeholder name would report success and hide the fault until the first
                    // open. Say so, and add nothing.
                    if (err instanceof EnvelopeError || err instanceof VaultLockedError) {
                        setRowStatus(graph.id, describeSyncFailure(err, "add the graph to this device"), "error");
                        return;
                    }
                    // Offline: keep the default; the first open heals the name.
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

    async function askDelete(graph: SyncedGraphView) {
        if (discardChecking) return;
        discardUnsent = null;
        deleteText = "";
        deleteError = null;
        if (!(await checkUnsentBeforeDiscard(graph.id, graph.rootDocId, graph.name))) return;
        deleteConfirm = graph;
    }

    /**
     * Permanently delete an owned graph (confirmed by typing DELETE). Every member loses it, and
     * this browser's copy goes with its outbox, so the same unsent guard as Forget and Leave: the
     * count is taken again here, and a read that fails deletes nothing.
     */
    async function executeDelete() {
        const graph = deleteConfirm;
        const api = syncApi();
        if (!graph || !api || deleteBusy || deleteText !== "DELETE") return;
        deleteBusy = true;
        deleteError = null;
        try {
            const outcome = await discardUnlessUnsent(
                { graphId: graph.id, rootDocId: graph.rootDocId },
                {
                    inspect: staleCopyUnsentChanges,
                    discard: async () => {
                        await api.deleteGraph(graph.id);
                        await deleteGraphCache(graph.id);
                    },
                    agreed: agreedUnsent(graph.id),
                },
            );
            if (outcome.kind === "confirm") {
                // Nothing deleted; the typed DELETE stays for the second confirmation.
                discardUnsent = { graphId: graph.id, unsent: outcome.unsent, downloaded: false, grew: true };
                return;
            }
            discardUnsent = null;
            discardGraphIndex(graph.id);
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
            // Leaving deletes this browser's copy with its outbox, so the same guard as Forget:
            // nothing unsent is lost without the person having seen it counted.
            const outcome = await discardUnlessUnsent(
                { graphId: graph.id, rootDocId: graph.rootDocId },
                {
                    inspect: staleCopyUnsentChanges,
                    discard: async () => {
                        await api.leaveGraph(graph.id);
                        await deleteGraphCache(graph.id);
                    },
                    agreed: agreedUnsent(graph.id),
                },
            );
            if (outcome.kind === "confirm") {
                discardUnsent = { graphId: graph.id, unsent: outcome.unsent, downloaded: false, grew: true };
                return;
            }
            discardUnsent = null;
            discardGraphIndex(graph.id);
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
            discardUnsent = null;
        } finally {
            leaveBusy = false;
        }
    }

    /**
     * Accept an invite. When this browser already holds a copy of the graph with changes the
     * server never received, nothing is accepted yet: the dialog below names what would be lost.
     * A failure to read the copy accepts nothing and deletes nothing.
     */
    async function acceptInvite(invite: (typeof invites)[number]) {
        if (checkingInvite) return;
        checkingInvite = invite.id;
        try {
            const outcome = await acceptUnlessUnsent(invite, {
                inspect: staleCopyUnsentChanges,
                accept: () => acceptInviteDiscardingCopy(invite),
            });
            if (outcome.kind === "confirm") {
                const record = await registry.getGraph(invite.graphId).catch(() => null);
                staleCopy = {
                    invite,
                    unsent: outcome.unsent,
                    graphName: record?.name ?? "Shared graph",
                    downloaded: false,
                };
            }
        } catch (err) {
            setStatus(
                `Could not check this browser's copy of the graph, so nothing was accepted or deleted: ${(err as Error).message}. Try again.`,
                "error",
            );
        } finally {
            checkingInvite = null;
        }
    }

    /** The person saw what would be lost and chose to accept anyway. */
    async function confirmStaleCopyDiscard() {
        const pending = staleCopy;
        if (!pending) return;
        // Closed first: accepting may need the unlock dialog, which must not stack on this one.
        staleCopy = null;
        await acceptInviteDiscardingCopy(
            pending.invite,
            pending.unsent.map((document) => document.docId),
            pending.graphName,
        );
    }

    function downloadStaleCopy() {
        if (!staleCopy) return;
        saveUnsentChangesFile(staleCopy.unsent, staleCopy.graphName);
        staleCopy = { ...staleCopy, downloaded: true };
    }

    /**
     * Accept, then replace any copy of the graph this browser holds with the server's: a copy
     * from an earlier membership (a tab that kept typing after the member was removed, or an
     * owner who deleted and re-shared) replayed now would land in the shared graph as if typed
     * today. Reached only when that copy has nothing unsent, or the person has confirmed
     * discarding the documents in `agreed`. The copy is checked again after any unlock prompt
     * and before the invite is accepted: another tab can have added unsent work in the meantime,
     * and then nothing is accepted and the dialog asks again with the new count.
     */
    function acceptInviteDiscardingCopy(
        invite: (typeof invites)[number],
        agreed: readonly string[] = [],
        graphName?: string,
    ): Promise<void> {
        const api = syncApi();
        if (!api) return Promise.resolve();
        return requireUnlockedVault(async () => {
            const heldKey = getCachedWrapKey()!;
            try {
                const existing = await api.getVault();
                if (!existing) throw new Error("No vault on this device");
                const opened = await openVault(
                    fromBase64Url(existing.vault),
                    heldKey,
                );
                setVaultWrapKey(opened.vaultKey); // self-heal: the vault key survives re-keys
                let accepted: Awaited<ReturnType<typeof acceptInviteFlow>> | undefined;
                const outcome = await discardUnlessUnsent(invite, {
                    inspect: staleCopyUnsentChanges,
                    agreed,
                    discard: async () => {
                        accepted = await acceptInviteFlow(
                            api,
                            invite,
                            opened.vault.identityPrivateKey,
                            opened.vaultKey,
                            existing.version,
                        );
                        await deleteGraphCache(accepted.graphId);
                    },
                });
                if (outcome.kind === "confirm" || !accepted) {
                    if (outcome.kind === "confirm") {
                        const record = await registry.getGraph(invite.graphId).catch(() => null);
                        staleCopy = {
                            invite,
                            unsent: outcome.unsent,
                            graphName: graphName ?? record?.name ?? "Shared graph",
                            downloaded: false,
                            grew: agreed.length > 0,
                        };
                    }
                    return;
                }
                discardGraphIndex(accepted.graphId);
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
        void refresh().then(sweepIndexPools);
        return stopRecoveries;
    });
</script>

<svelte:head><title>Knowledge graphs · EtherPK</title></svelte:head>
<svelte:document onvisibilitychange={recheckPlanQuietly} />

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
                {#if planNotice === "upsell"}
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
                            multiplayer and managed storage. Graphs shared with
                            you still work here.
                        </p>
                        {#if corporateBillingUrl}
                            <a
                                href={corporateBillingUrl}
                                data-sveltekit-reload
                                class="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                                >See Sync+</a
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
                    {#if planNotice === "payment_failed" || planNotice === "payment_overdue"}
                        <div
                            role="status"
                            data-testid="sync-payment-notice"
                            data-kind={planNotice}
                            class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
                        >
                            <p>
                                {planNotice === "payment_failed"
                                    ? "Your last Sync+ payment failed. Fix it from Billing to keep syncing: if it is not paid, the graphs you own become read-only."
                                    : "A Sync+ payment is overdue, so the graphs you own are read-only. You can still open, export and delete them. Fix the payment from Billing to make them writable again."}
                            </p>
                            {#if corporateBillingUrl}
                                <a
                                    href={corporateBillingUrl}
                                    data-sveltekit-reload
                                    class="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                                    >Fix payment</a
                                >
                            {/if}
                        </div>
                    {:else if planNotice === "ended"}
                        <div
                            role="status"
                            data-testid="sync-read-only-notice"
                            class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
                        >
                            <p>
                                Your Sync+ subscription has ended, so the graphs
                                you own are read-only. You can still open, export
                                and delete them. Owned graphs are deleted from the
                                managed service after a retention period, so export
                                anything you want to keep.
                            </p>
                            {#if corporateBillingUrl}
                                <a
                                    href={corporateBillingUrl}
                                    data-sveltekit-reload
                                    class="mt-2 inline-flex rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
                                    >Restart Sync+</a
                                >
                            {/if}
                        </div>
                    {:else if planNotice === "unconfirmed"}
                        <p
                            role="status"
                            data-testid="sync-plan-unconfirmed"
                            class="mt-2 text-sm leading-5 text-amber-800 dark:text-amber-200"
                        >
                            Your plan cannot be confirmed right now, so the
                            graphs you own are read-only for the moment. Nothing
                            is lost. Reload this page in a few minutes.
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
                            onclick={() => void acceptInvite(invite)}
                            aria-busy={checkingInvite === invite.id}
                            class="shrink-0 rounded-lg bg-gray-900 dark:bg-gray-100 px-3 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                            >{checkingInvite === invite.id ? "Checking…" : "Accept"}</button
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
                onforget={() => void askForget(graph)}
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
                                {#if g.role === "owner" && !ownedGraphsWritable}
                                    <span
                                        data-testid="synced-read-only"
                                        class="rounded-full bg-amber-50 px-2 py-0.5 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
                                        >Read-only</span
                                    >
                                {/if}
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
                                    <!-- The Server refuses new Players on a read-only
                                         owner's graph (quota policy), so Invite is not
                                         offered; the plan notice above says why. Transfer
                                         stays: it checks the recipient's allowance, and is
                                         one way to keep the graph writable. -->
                                    {#if ownedGraphsWritable}
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
                                    {/if}
                                    <button
                                        data-testid="graphs-transfer"
                                        onclick={() => startTransfer(g)}
                                        class="shrink-0 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                                        >Transfer ownership</button
                                    >
                                    <button
                                        data-testid="graphs-delete"
                                        disabled={discardChecking === g.id}
                                        onclick={() => void askDelete(g)}
                                        class="shrink-0 rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                                        >Delete</button
                                    >
                                {:else}
                                    <button
                                        data-testid="graphs-leave"
                                        disabled={discardChecking === g.id}
                                        onclick={() => void askLeave(g)}
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
            ? syncPlusRequiredMessage
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
        onclose={() => {
            deleteConfirm = null;
            discardUnsent = null;
        }}
        onsubmit={executeDelete}
    >
        {#snippet body()}
            {@render unsentWarning("Deleting the graph", deleteConfirm!.name, false)}
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
                    The synced copy in this browser, and its search index, are
                    deleted with it. Files you mirrored to a local folder are
                    not deleted.
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
            <p
                class="text-sm text-gray-600 dark:text-gray-400"
                data-testid="delete-agent-note"
            >
                Computers running the Headless Client for this graph drop
                their copy the next time it starts.
            </p>
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
                onclick={() => {
                    deleteConfirm = null;
                    discardUnsent = null;
                }}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            {#if discardUnsent?.graphId === deleteConfirm!.id && discardUnsent.unsent.length > 0}
                <button
                    type="button"
                    data-testid="discard-unsent-download"
                    onclick={() => downloadDiscardUnsent(deleteConfirm!.name)}
                    class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Download unsent changes</button
                >
            {/if}
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

<!-- What Forget or Leave would delete that the server never received. -->
{#snippet unsentWarning(action: string, graphName: string, canSync = true)}
    {#if discardUnsent && discardUnsent.unsent.length > 0}
        {@const count = discardUnsent.unsent.length}
        <div
            data-testid="discard-unsent-changes"
            class="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-100"
        >
            <p>
                Changes to {count === 1 ? "1 document" : `${count.toLocaleString()} documents`} in this browser have not
                reached the sync server yet. {action} deletes them.
            </p>
            <p>
                {canSync
                    ? "To keep them, open the graph while online and wait until it shows Synced, or download them first."
                    : "To keep a copy, download them first: the graph and everything the server holds for it go too."}
            </p>
            {#if discardUnsent.grew}
                <p role="status" data-testid="discard-unsent-grew">More changes arrived since this opened; the count is current.</p>
            {/if}
            {#if discardUnsent.downloaded}
                <p role="status">Downloaded as “{graphName} unsent changes.md”.</p>
            {/if}
        </div>
    {/if}
{/snippet}

{#if forgetConfirm}
    {@const unsentCount = discardUnsent?.graphId === forgetConfirm.id ? discardUnsent.unsent.length : 0}
    <Modal
        open={true}
        title="Forget graph"
        busy={forgetBusy}
        busyReason="Forgetting…"
        onclose={() => {
            forgetConfirm = null;
            discardUnsent = null;
            forgetError = null;
        }}
        onsubmit={executeForget}
    >
        {#snippet body()}
            {#if forgetConfirm!.backend === "server"}
                <div class="space-y-3">
                    {@render unsentWarning("Forgetting", forgetConfirm!.name)}
                    <p class="text-sm text-gray-600 dark:text-gray-400">
                        Forget <span
                            class="font-medium text-gray-900 dark:text-gray-200"
                            >{forgetConfirm!.name}</span
                        >? This deletes the graph's local copy and its search index
                        from this browser.
                        {unsentCount > 0
                            ? "The graph stays on the sync server without the changes above."
                            : "The graph remains on the sync server - add it back any time."}
                        Deleting the graph for all members (owner only) is
                        done from the Synced graphs panel.
                    </p>
                </div>
            {:else}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Forget <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{forgetConfirm!.name}</span
                    >? Forgetting removes the graph from this list and its search
                    index from this browser. Delete the files on disk manually if you
                    require full deletion.
                </p>
            {/if}
            {#if forgetError}
                <p role="alert" data-testid="graphs-forget-error" class="mt-3 text-sm text-red-600">{forgetError}</p>
            {/if}
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                data-autofocus={unsentCount > 0 ? "" : undefined}
                onclick={() => {
                    forgetConfirm = null;
                    discardUnsent = null;
                    forgetError = null;
                }}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            {#if unsentCount > 0}
                <button
                    type="button"
                    data-testid="discard-unsent-download"
                    onclick={() => downloadDiscardUnsent(forgetConfirm!.name)}
                    class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Download unsent changes</button
                >
                <button
                    type="submit"
                    disabled={forgetBusy}
                    data-testid="graphs-forget-confirm"
                    class="rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >Discard changes and forget</button
                >
            {:else}
                <button
                    type="submit"
                    disabled={forgetBusy}
                    data-testid="graphs-forget-confirm"
                    class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >Forget</button
                >
            {/if}
        {/snippet}
    </Modal>
{/if}

{#if leaveConfirm}
    {@const unsentCount = discardUnsent?.graphId === leaveConfirm.id ? discardUnsent.unsent.length : 0}
    <Modal
        open={true}
        title="Leave graph"
        busy={leaveBusy}
        busyReason="Leaving…"
        onclose={() => {
            leaveConfirm = null;
            discardUnsent = null;
        }}
        onsubmit={executeLeave}
    >
        {#snippet body()}
            <div class="space-y-3">
                {@render unsentWarning("Leaving", leaveConfirm!.name)}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Leave <span class="font-medium text-gray-900 dark:text-gray-200"
                        >{leaveConfirm!.name}</span
                    >? You lose access until the owner invites you again. The graph
                    itself, and the other members, are untouched. The copy in this
                    browser, and its search index, are deleted. Computers running the
                    Headless Client for this graph drop their copy the next time it
                    starts.
                </p>
            </div>
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                data-autofocus={unsentCount > 0 ? "" : undefined}
                onclick={() => {
                    leaveConfirm = null;
                    discardUnsent = null;
                }}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            {#if unsentCount > 0}
                <button
                    type="button"
                    data-testid="discard-unsent-download"
                    onclick={() => downloadDiscardUnsent(leaveConfirm!.name)}
                    class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Download unsent changes</button
                >
            {/if}
            <button
                type="submit"
                disabled={leaveBusy}
                data-testid="graphs-leave-confirm"
                class="min-w-32 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{leaveBusy ? "Leaving…" : unsentCount > 0 ? "Discard changes and leave" : "Leave graph"}</button
            >
        {/snippet}
    </Modal>
{/if}

{#if staleCopy}
    {@const count = staleCopy.unsent.length}
    {@const documents = count === 1 ? "1 document" : `${count.toLocaleString()} documents`}
    <Modal
        open={true}
        title="Unsent changes in this browser"
        onclose={() => (staleCopy = null)}
        onsubmit={() => void confirmStaleCopyDiscard()}
    >
        {#snippet body()}
            <div data-testid="invite-unsent-changes" class="space-y-3">
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    This browser still holds a copy of <span class="font-medium text-gray-900 dark:text-gray-200"
                        >{staleCopy!.graphName}</span
                    > with changes to {documents} that the server never received. Accepting the invite
                    replaces the copy with the server's version, and those changes are lost.
                </p>
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Download them first to keep them. Cancel keeps everything and leaves the invite waiting.
                </p>
                {#if staleCopy!.grew}
                    <p role="status" data-testid="invite-unsent-grew" class="text-sm text-gray-600 dark:text-gray-400">
                        More changes arrived since this opened; the count is current.
                    </p>
                {/if}
                {#if staleCopy!.downloaded}
                    <p role="status" class="text-sm text-gray-600 dark:text-gray-400">
                        Downloaded as “{staleCopy!.graphName} unsent changes.md”.
                    </p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                onclick={() => (staleCopy = null)}
                data-testid="invite-unsent-cancel"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="button"
                onclick={downloadStaleCopy}
                data-testid="invite-unsent-download"
                class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >Download unsent changes</button
            >
            <button
                type="submit"
                data-testid="invite-unsent-discard"
                class="rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700"
                >Discard changes to {documents} and accept</button
            >
        {/snippet}
    </Modal>
{/if}

<!-- Last in the document so it stacks above the import and create dialogs that ask for it. -->
{#if unlockThen}
    <UnlockDialog onunlocked={runUnlockThen} onclose={cancelUnlock} />
{/if}
