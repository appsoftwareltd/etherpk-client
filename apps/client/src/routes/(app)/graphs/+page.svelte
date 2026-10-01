<script lang="ts">
    /**
     * The knowledge-graph picker: list the graphs this browser knows, open one, create a
     * Local graph from a folder, or create/join a synced (Server-backed, E2EE) graph. Backend
     * is fixed at creation (ADR 0007).
     *
     * Two tabs: Graphs, and Sync (`?tab=sync`). A device can hold connections to several Sync
     * Servers at once (ADR 0111), and this page shows them all: the Graphs tab has a group per
     * server, and the Sync tab a sub-tab per server (`&server=<host>`) with its account, its keys
     * and its copies in this browser. No server is "the current one": each is a SyncServerView,
     * and every action names the server it acts on. Local folder graphs belong to no server.
     */
    import { onMount, tick, untrack } from "svelte";

    import { dev } from "$app/environment";
    import { afterNavigate, goto, replaceState } from "$app/navigation";
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
        createIdbGraphRegistry,
        createIdbGraphStoragePort,
        createWebFsDirectoryAdapter,
        describeDeviceStorage,
        ensurePermission,
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
        clearSyncAccount,
        createAccountKeys,
        createSyncApi,
        defaultCustomSyncUrl,
        defaultServerForNewGraph,
        ensureGraphKeys,
        forgetSyncConnection,
        isManagedSyncConfigured,
        listSyncConnections,
        readLastNewGraphServer,
        readSyncAccount,
        rememberNewGraphServer,
        saveCustomSyncConnection,
        saveManagedSyncConnection,
        serverHost,
        getVaultWrapKey,
        lockVault,
        type ResolvedSyncConnection,
        acceptInvite as acceptInviteFlow,
        inviteGraphName,
        type PendingInvite,
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
        SyncApiError,
        SYNC_CONNECTIONS_CHANGED_EVENT,
        SYNC_CONNECTIONS_STORAGE_KEY,
        VaultLockedError,
    } from "$lib/sync";
    import {
        PUBLIC_DOCS_URL,
        formatBytes,
        safeReturnPath,
    } from "@appsoftwareltd/etherpk-shared";
    import { managedSignInHref } from "$lib/auth/sign-in-links";
    import {
        EnvelopeError,
        fromBase64Url,
        openVault,
        type GraphKeyring,
    } from "$lib/crypto";
    import { promptRecoveryCode } from "$lib/sync/recovery-code-prompt";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import { describeConnectionCheckFailure } from "$lib/sync/connection-check";
    import InviteDialog from "$lib/sync/ui/InviteDialog.svelte";
    import UnlockDialog from "$lib/sync/ui/UnlockDialog.svelte";
    import ResetDialog from "$lib/sync/ui/ResetDialog.svelte";
    import TransferOwnershipDialog from "$lib/sync/ui/TransferOwnershipDialog.svelte";
    import RenameGraphDialog from "$lib/sync/ui/RenameGraphDialog.svelte";
    import GraphSettingsDialog from "$lib/sync/ui/GraphSettingsDialog.svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { delayedFlag } from "@appsoftwareltd/etherpk-shared/delayed";
    import {
        acceptUnlessUnsent,
        discardUnlessUnsent,
        saveUnsentChangesFile,
        staleCopyUnsentChanges,
        type UnsentDocument,
    } from "$lib/sync/unsent-changes";
    import ImportGraphDialog, {
        type ImportSyncTarget,
    } from "$lib/import/ui/ImportGraphDialog.svelte";
    import {
        importMarkers,
        type ImportMarker,
    } from "$lib/import/import-marker";
    import { clearManagedAccessToken } from "$lib/auth/managed-token";
    import GraphPickerRow from "$lib/workspace/GraphPickerRow.svelte";
    import SyncServerGroup, {
        type SyncServerGroupActions,
    } from "$lib/workspace/SyncServerGroup.svelte";
    import SyncServerSettings, {
        type SyncServerSettingsActions,
    } from "$lib/workspace/SyncServerSettings.svelte";
    import {
        SyncServerView,
        refusedCredential,
    } from "$lib/workspace/sync-server-view.svelte";
    import {
        CUSTOM_SERVER_ICON,
        LOCAL_GRAPHS_ICON,
        MANAGED_SERVER_ICON,
    } from "$lib/workspace/graphs-page-icons";
    import { forgetGraphOnDevice } from "$lib/workspace/graph-device-memory";
    import { isDemoGraph } from "$lib/demo/demo-graph";
    import {
        copyServer,
        countCopiesByServer,
        loadSyncedGraphViews,
        serverGroupVisible,
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

    /**
     * Which tab shows: the graphs, or the Sync settings. Kept in the address as `?tab=sync`,
     * replaced rather than pushed, so Back leaves the page rather than walking between tabs. Held
     * here as well because a shallow `replaceState` changes the address bar but not `page.url`;
     * a real navigation to this page reads it back from the address (`afterNavigate` below).
     */
    let activeTab = $state<"graphs" | "sync">(tabIn(page.url));
    /** The Sync tab's sub-tab as the address names it (`&server=`): a server's host, or `add`. */
    let requestedSyncPanel = $state<string | null>(
        page.url.searchParams.get("server"),
    );

    function tabIn(url: URL): "graphs" | "sync" {
        return url.searchParams.get("tab") === "sync" ? "sync" : "graphs";
    }

    afterNavigate(({ to }) => {
        if (!to?.url) return;
        activeTab = tabIn(to.url);
        requestedSyncPanel = to.url.searchParams.get("server");
    });

    /** One view per Sync Server this device holds (ADR 0111), in the order they were added. */
    let servers = $state.raw<SyncServerView[]>([]);
    /** The stored connections have been read: until then, no servers means "not known yet". */
    let connectionsRead = $state(false);
    /** Managed Sync, when this device holds a connection to it. */
    const managedServer = $derived(
        servers.find((server) => server.connection.kind === "managed") ?? null,
    );
    /** Managed Sync first, then the rest in the order they were added: the groups and sub-tabs alike. */
    const orderedServers = $derived(
        managedServer
            ? [
                  managedServer,
                  ...servers.filter((server) => server !== managedServer),
              ]
            : servers,
    );
    /** The server whose account stands for the device where one must: Managed Sync, else the first added. */
    const primaryServer = $derived(orderedServers[0] ?? null);
    /** The Sync tab's sub-tab: the one the address asks for when it exists, else the primary server, else Add. */
    const syncPanel = $derived.by((): SyncServerView | "add" => {
        if (requestedSyncPanel === "add") return "add";
        return (
            orderedServers.find(
                (server) => server.host === requestedSyncPanel,
            ) ??
            primaryServer ??
            "add"
        );
    });

    function serverFor(
        origin: string | null | undefined,
    ): SyncServerView | null {
        return origin
            ? (servers.find((server) => server.origin === origin) ?? null)
            : null;
    }

    // Adding a Sync Server: Managed Sync's sign-in, or a custom server's address and access token.
    let connectionMode = $state<"managed" | "custom">(
        managedSyncAvailable ? "managed" : "custom",
    );
    let serverBaseUrl = $state(configuredCustomSyncUrl);
    let token = $state("");
    // What is wrong with each Custom server field, said at the field (rule 6).
    let syncUrlError = $state<string | null>(null);
    let syncTokenError = $state<{ message: string; tokensUrl?: string } | null>(
        null,
    );
    let syncSaving = $state(false);
    /** The add form offers Managed Sync: this Client offers it and the device does not hold it yet. */
    const addOffersManaged = $derived(
        managedSyncAvailable && managedServer === null,
    );
    /** The typed server's origin, for links to its pages; null until the address parses. */
    const customServerOrigin = $derived.by(() => {
        const typed = serverBaseUrl.trim();
        if (!/^https?:\/\//i.test(typed)) return null;
        try {
            return new URL(typed).origin;
        } catch {
            return null;
        }
    });

    // Dialog state. The Recovery Code ritual is NOT here - it is hosted in the app shell so
    // a background import can finish on any route (promptRecoveryCode, ADR 0035).
    let inviteDialog = $state<{
        server: SyncServerView;
        graphId: string;
        graphName?: string;
        keyring: GraphKeyring;
    } | null>(null);
    let unlockThen = $state<null | (() => Promise<void>)>(null);
    /** The server whose keys the open unlock dialog unlocks. */
    let unlockOrigin = $state<string | null>(null);
    // Set alongside unlockThen when a caller is AWAITING the unlock rather than resuming
    // after it, so cancelling the dialog fails that caller instead of hanging it forever.
    let unlockCancelled: null | (() => void) = null;
    /** The server whose Reset encryption keys dialog is open. */
    let resetServer = $state<SyncServerView | null>(null);

    /**
     * Imports a closed or reloaded tab cut off partway (import-marker.ts), with what each left:
     * a synced graph partly uploaded, or a folder partly written.
     */
    let interruptedImports = $state<ImportMarker[]>([]);
    /** Graphs an import was cut off partway through, for their rows' Import interrupted badge. */
    const interruptedGraphIds = $derived(
        new Set(
            interruptedImports.flatMap((item) =>
                item.graphId ? [item.graphId] : [],
            ),
        ),
    );
    /** The interrupted import whose Delete waits for its confirmation, and one being deleted. */
    let confirmingPartialDelete = $state<string | null>(null);
    let deletingPartial = $state<string | null>(null);

    function forgetInterruptedImport(item: ImportMarker) {
        importMarkers().forget(item.id);
        interruptedImports = interruptedImports.filter(
            (other) => other.id !== item.id,
        );
    }

    /**
     * Remove what an interrupted synced import left on its server. A graph already gone is done. A
     * marker from before imports recorded their server names none, and is taken to be the primary
     * server's.
     */
    async function deletePartialImport(item: ImportMarker) {
        const server =
            serverFor(item.serverOrigin) ??
            (item.serverOrigin ? null : primaryServer);
        if (!item.graphId || deletingPartial) return;
        if (!server) {
            setStatus(
                item.serverOrigin
                    ? `This device is no longer connected to ${serverHost(item.serverOrigin)}. Add it again on the Sync tab to delete the partial graph.`
                    : noSyncConnectionMessage(),
                "error",
            );
            return;
        }
        deletingPartial = item.id;
        try {
            await server.api.deleteGraph(item.graphId).catch((err: unknown) => {
                if (!(err instanceof SyncApiError && err.status === 404))
                    throw err;
            });
            forgetInterruptedImport(item);
            setStatus(
                `Deleted the partial graph left by the import of "${item.name}".`,
            );
            await refresh();
        } catch (err) {
            setStatus(
                describeSyncFailure(err, "delete the partial graph"),
                "error",
            );
        } finally {
            deletingPartial = null;
            confirmingPartialDelete = null;
        }
    }

    /** The invite whose Decline is waiting for its confirmation, and one being withdrawn. */
    let decliningInvite = $state<string | null>(null);
    let withdrawingInvite = $state<string | null>(null);

    /**
     * Every synced graph's copy this browser holds, under any account and for any server, whatever
     * hides it (another account, a withdrawn membership, a sign-out, a forgotten server): what each
     * server's Remove would remove, and what tells a returning browser from a first visit.
     */
    let heldCopies = $state.raw<GraphRecord[]>([]);
    const copyCounts = $derived(
        countCopiesByServer(
            heldCopies,
            servers.map((server) => server.origin),
        ),
    );
    /**
     * Removing synced graphs from this browser, once the check has run: one server's copies (null:
     * the copies of servers this device no longer holds), with the unsent changes in each and
     * whether they were downloaded. `grew`: more became unsent while the dialog was open, so it asks
     * again. Null while closed.
     */
    let removeSynced = $state<{
        server: SyncServerView | null;
        held: Array<{ graph: GraphRecord; unsent: UnsentDocument[] }>;
        downloaded: boolean;
        grew: boolean;
    } | null>(null);
    /** Whose copies are being checked before removal: a server's origin, or `unheld`. */
    let removeCopiesChecking = $state<string | null>(null);
    let removeSyncedBusy = $state(false);
    /**
     * Where Sync settings go back to once a connection is made: the page that sent the person
     * here to connect (`?return=`), checked like any other return path.
     */
    const returnTo = $derived(
        safeReturnPath(page.url.searchParams.get("return"), "") || null,
    );
    const corporateBillingUrl = $derived(
        (page.data.corporateBillingUrl as string | null | undefined) ?? null,
    );
    const corporateAccountUrl = $derived(
        (page.data.corporateAccountUrl as string | null | undefined) ?? null,
    );
    /** A plan still being confirmed is said only once confirming takes long enough to notice. */
    const showPlanPending = delayedFlag(
        () => servers.some((server) => server.shownPlanNotice === "pending"),
        300,
    );
    /** What somebody `server`'s account invites must have there, for the invite dialog to name. */
    function inviteeNeeds(server: SyncServerView) {
        return {
            account:
                server.account?.authentication.mode === "standalone"
                    ? "an account on this server"
                    : "an EtherPK account",
            // An older server does not say; the stricter reading names the step that may be missing.
            verifiedEmail: server.account?.invitesNeedVerifiedEmail ?? true,
        };
    }
    let transferDialog = $state<{
        server: SyncServerView;
        graph: SyncedGraphView;
        candidates: SyncedMember[];
    } | null>(null);
    let leaveConfirm = $state<{
        server: SyncServerView;
        graph: SyncedGraphView;
    } | null>(null);
    /**
     * An invite to a graph this browser still holds a copy of with changes the server never
     * received. Accepting discards the copy, so the person sees what would be lost, can download
     * it, and confirms or cancels.
     */
    let staleCopy = $state<{
        server: SyncServerView;
        invite: PendingInvite;
        unsent: UnsentDocument[];
        graphName: string;
        downloaded: boolean;
        /** More became unsent after the dialog opened, so the count was taken again. */
        grew?: boolean;
    } | null>(null);
    /** The invite whose local copy is being checked, so a second press does not start another. */
    let checkingInvite = $state<string | null>(null);
    let leaveBusy = $state(false);
    let deleteConfirm = $state<{
        server: SyncServerView;
        graph: SyncedGraphView;
    } | null>(null);
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
    /** The server the open create dialog creates on: chosen in it when the device holds several. */
    let createOrigin = $state<string | null>(null);
    let createName = $state("");
    let createBusy = $state(false);
    /** What Create is waiting on, for the dialog's busy line. */
    let createStage = $state("Creating…");
    /** Reported inside the create dialog, which stays open with the name typed. */
    let createError = $state<string | null>(null);
    /** "New synced graph" was pressed and is waiting on the account checks. */
    let createPending = $state(false);
    // Import a graph from a Logseq / Obsidian / EtherPK / AS Notes source folder.
    let importDialog = $state(false);
    /** The graph list could not be read at all, which is not the same as there being none. */
    let registryUnreadable = $state(false);
    /** The registry has answered once (or failed to): until then an empty list means nothing. */
    let graphsListed = $state(false);
    /**
     * The first refresh has finished, every server included, or took too long to wait for: what a
     * browser with nothing of its own waits on before it is called a first visit.
     */
    let initialRefreshDone = $state(false);

    /** Local folder graphs, apart from the demo: they belong to no Sync Server. */
    const localGraphs = $derived(
        ordinaryGraphs.filter((graph) => graph.backend !== "server"),
    );

    /** This device's records of the graphs on `server`. */
    function recordsFor(server: SyncServerView): GraphRecord[] {
        return graphs.filter(
            (graph) =>
                graph.backend === "server" &&
                graph.serverScope?.serverOrigin === server.origin,
        );
    }

    /** The registry and the stored connections have been read; before that nothing below is known. */
    const listReady = $derived(graphsListed && connectionsRead);
    /**
     * Whether this is a first visit is known: at once for a browser holding graphs of its own, else
     * only once every server has answered, so the first-run card and a returning browser's lists
     * never replace each other on screen. The Graphs tab shows a skeleton until then, the server's
     * render included, which has no stored connections to read.
     */
    const firstRunKnown = $derived(
        listReady &&
            (registryUnreadable ||
                localGraphs.length > 0 ||
                heldCopies.length > 0 ||
                initialRefreshDone),
    );
    /**
     * A browser with nothing of its own yet: no graphs but the demo, no synced graph held for any
     * server (signed in or not), and none on any server's account. The page then says so in one card
     * (the first-run card) rather than showing empty lists.
     */
    const firstRun = $derived(
        firstRunKnown &&
            !registryUnreadable &&
            localGraphs.length === 0 &&
            heldCopies.length === 0 &&
            servers.every((server) => server.graphs.length === 0),
    );
    /**
     * Every server's plan stands in the way of a new graph, so New synced graph is disabled; the
     * plan line in each server's group says why. A server that is signed out or not answering does
     * not count: pressing the button then starts the way back in.
     */
    const createDisabled = $derived(
        servers.length > 0 &&
            servers.every(
                (server) =>
                    server.authState === "authenticated" &&
                    server.createBlockedReason !== null,
            ),
    );
    /** The disabled button's reason, for its tooltip: the one server's own, or where to look. */
    const createDisabledReason = $derived(
        !createDisabled
            ? null
            : servers.length === 1
              ? servers[0].createBlockedReason
              : "None of your Sync Servers can take a new graph now. Each one's group below says why.",
    );
    const SECONDARY_BUTTON =
        "inline-flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 pointer-coarse:min-h-11 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5";

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
            ? (deleteConfirm.graph.members ?? []).filter(
                  (m) => m.role === "player" && m.status !== "invited",
              ).length
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

    /**
     * Whether this device's way to a synced graph is the EtherPK account rather than a custom
     * server: it holds Managed Sync, or, holding no server yet, Managed Sync is offered here.
     */
    function signsInToManagedSync(): boolean {
        if (servers.length > 0) return managedServer !== null;
        return managedSyncAvailable && connectionMode !== "custom";
    }

    /** The key this device holds for `origin`'s account, or null while it is locked here. */
    function heldKey(origin: string): Uint8Array | null {
        return getVaultWrapKey(origin);
    }

    /**
     * The account confirmed on `origin`, for a record written under it. A flow started on one server
     * finishes on that server, whatever else the page does meanwhile.
     */
    function requireServerScope(origin: string): ServerGraphScope {
        const scope = readSyncAccount(origin);
        if (!scope)
            throw new Error(
                `Sign in to ${serverHost(origin)} before adding a synced graph from it.`,
            );
        return scope;
    }

    /**
     * What an action that needs a sync connection says when this device has none. With Managed
     * Sync it is the EtherPK account, and a synced graph of one's own needs Sync+ (ADR 0068);
     * with a custom server it is the server's address and an access token.
     */
    function noSyncConnectionMessage(): string {
        if (signsInToManagedSync()) {
            return supported
                ? "Synced graphs need an EtherPK account with Sync+. Sign in to create one, or open a folder on this computer instead."
                : "Synced graphs need an EtherPK account with Sync+. Sign in to create one.";
        }
        return "Connect this device to a Sync Server first: add its address and an access token in Sync settings.";
    }

    /** The same way in: the same kind of connection, address and access token. */
    function sameCredential(
        a: ResolvedSyncConnection,
        b: ResolvedSyncConnection,
    ): boolean {
        return (
            a.kind === b.kind &&
            a.serverBaseUrl === b.serverBaseUrl &&
            (a.kind === "managed" || a.token === b.token)
        );
    }

    /**
     * Match the page's server views to the stored connections: keep each one still held, make one
     * for a server just added, and stop the timers of one forgotten. A custom server saved again
     * with a new token gets a fresh view, since its Sync API carries the token.
     */
    function reconcileServers() {
        const held = listSyncConnections();
        const next = held.map((connection) => {
            const existing = servers.find(
                (server) => server.origin === connection.origin,
            );
            return existing && sameCredential(existing.connection, connection)
                ? existing
                : new SyncServerView(connection);
        });
        for (const server of servers)
            if (!next.includes(server)) server.dispose();
        servers = next;
        connectionsRead = true;
    }

    /**
     * Read everything again: the servers held, each one's account, this browser's graphs, and each
     * server's list, invites and vault. The accounts are checked alongside the first registry read,
     * so local graphs never wait on a slow server.
     */
    async function refresh() {
        reconcileServers();
        const checked = Promise.all(
            servers.map((server) => server.checkAccount()),
        );
        const listed = await listRegistry();
        await checked;
        if (!listed) return;
        await Promise.all(servers.map((server) => refreshServer(server)));
    }

    /**
     * Refresh after a connection was added or dropped outside this page: in another tab, or from
     * the header menu. A server added while the Add sub-tab is open is what that form was for, so
     * its own sub-tab opens.
     */
    async function refreshAfterOutsideChange() {
        const before = new Set(servers.map((server) => server.origin));
        await refresh();
        const added = orderedServers.find(
            (server) => !before.has(server.origin),
        );
        if (added && activeTab === "sync" && syncPanel === "add")
            showSyncPanel(added);
    }

    /** Read this browser's graphs and synced copies. False when the list cannot be read at all. */
    async function listRegistry(): Promise<boolean> {
        try {
            graphs = await registry.listGraphs();
        } catch (err) {
            // A registry that cannot be read is not a registry that is empty, and the two used
            // to look identical: the list rejected, everything after it was skipped, and the
            // page said "No graphs yet" to someone whose graphs were all still there (2026-09-09).
            registryUnreadable = true;
            graphsListed = true;
            setStatus(
                `Your graphs could not be read from this browser's storage, so none are listed. Nothing has been deleted. (${(err as Error).message})`,
                "error",
            );
            return false;
        }
        registryUnreadable = false;
        graphsListed = true;
        heldCopies = (
            await createIdbGraphStoragePort()
                .getAll()
                .catch(() => [] as GraphRecord[])
        ).filter((record) => record.backend === "server");
        return true;
    }

    /**
     * Read one server's list, invites and vault. A server that refused this device gets none of
     * them, and one that did not answer is not asked again until Try again: its group lists the
     * copies this browser holds meanwhile.
     */
    async function refreshServer(server: SyncServerView) {
        if (server.authState !== "authenticated") {
            server.error = null;
            return;
        }
        // Independent fetches: the list does not wait behind the invites call.
        await Promise.all([
            refreshInvites(server),
            refreshSynced(server),
            server.refreshVault(),
        ]);
    }

    /** Try a server again: its account, then everything that hangs off it. */
    async function retryServer(server: SyncServerView) {
        await server.checkAccount();
        await listRegistry();
        await refreshServer(server);
    }

    /**
     * Re-read the plans, the pending invites and the owned graphs' rosters when the tab comes back
     * into view. The page stays open for days: a card fixed or a plan lapsed in another tab, or an
     * invite sent, accepted, declined or cancelled on another device, otherwise showed only after a
     * reload. Quiet on purpose: nothing says "Checking…", and the rosters are read at most every
     * thirty seconds, since each owned graph's roster is a request of its own.
     */
    let lastSharingRefresh = 0;
    function onVisible() {
        if (document.visibilityState !== "visible") return;
        for (const server of servers) void server.recheckPlan();
        if (Date.now() - lastSharingRefresh < 30_000) return;
        lastSharingRefresh = Date.now();
        for (const server of servers) {
            if (server.authState !== "authenticated") continue;
            void refreshInvites(server);
            void refreshSynced(server);
        }
    }

    /**
     * The vault's keyrings while it is unlocked here, so the synced list can read the server's
     * name envelope for graphs this device never opened (ADR 0031, amended 2026-09-17).
     * Null when the vault is locked, absent or unreadable: the list then keeps the id
     * placeholder, and the row copy says what would change that.
     */
    async function heldKeyrings(
        server: SyncServerView,
    ): Promise<GraphKeyring[] | null> {
        try {
            const opened = await openHeldVault({
                api: server.api,
                origin: server.origin,
            });
            return opened?.vault.keyrings ?? null;
        } catch (err) {
            console.warn(
                "[graphs] could not open the vault to read graph names",
                err,
            );
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
            createGraphNamePublisher({
                api,
                keyring,
                graphId: view.id,
            }).publish(view.name);
        }
    }

    /**
     * A graph not on this device whose server row carries no name envelope has to be asked
     * directly, once: open its root document far enough to read the meta map, publish what
     * it says so no device ever has to do this again, and label the row. One at a time, each
     * bounded by the session's connect timeout, and only while the keys are unlocked here. A
     * read the relay did not answer is not recorded, so the next refresh tries it again.
     */
    async function readUnlabelledNames(
        server: SyncServerView,
        keyrings: GraphKeyring[],
        views: SyncedGraphView[],
    ) {
        const pending = unlabelledGraphsToRead(views, keyrings).filter(
            ({ view }) => !server.nameReadsDone.has(view.id),
        );
        for (const { view } of pending) server.nameReads[view.id] = "reading";
        for (const { view, keyring } of pending) {
            server.nameReadsDone.add(view.id);
            const publisher = createGraphNamePublisher({
                api: server.api,
                keyring,
                graphId: view.id,
            });
            let name: string | undefined;
            try {
                const session = await openSyncedGraphMetaSession(
                    await metaSessionDepsFor(
                        view.id,
                        view.rootDocId,
                        server.origin,
                        {
                            keyring,
                            publishName: publisher.publish,
                        },
                    ),
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
                server.nameReadsDone.delete(view.id);
                server.nameReads[view.id] = "unreachable";
                continue;
            }
            if (name) {
                const read = name;
                server.graphs = server.graphs.map((g) =>
                    g.id === view.id
                        ? { ...g, name: read, nameSource: "document" as const }
                        : g,
                );
                delete server.nameReads[view.id];
            } else {
                server.nameReads[view.id] = "unnamed";
            }
        }
    }

    /**
     * `server`'s memberships, cross-referenced with the local registry for names (the server never
     * knows them, ADR 0024), and the registry reconciled with them.
     */
    async function refreshSynced(server: SyncServerView) {
        server.loading = true;
        try {
            const keyrings = await heldKeyrings(server);
            const overview = await loadSyncedGraphViews(server.api, graphs, {
                keyrings: keyrings ?? undefined,
            });
            const scope = readSyncAccount(server.origin);
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
            server.ownedStorage = overview.ownedStorage;
            server.graphs = overview.graphs;
            server.listed = true;
            server.error = null;
            if (keyrings) {
                backfillNameEnvelopes(server.api, keyrings, overview.graphs);
                void readUnlabelledNames(server, keyrings, overview.graphs);
            }
        } catch (err) {
            server.graphs = [];
            server.listed = false;
            if (refusedCredential(err)) {
                // Signed out since the account check: that is what the group says, not a
                // connection failure.
                server.error = null;
                server.markSignedOut();
            } else {
                server.error = describeSyncFailure(
                    err,
                    `load your synced graphs from ${server.host}`,
                );
            }
        } finally {
            server.loading = false;
        }
    }

    async function refreshInvites(server: SyncServerView) {
        let listed: PendingInvite[];
        try {
            listed = await server.api.listInvites();
        } catch {
            listed = [];
        }
        server.invites = listed;
        if (listed.length > 0) void readInviteNames(server, listed);
    }

    /**
     * Name each invite's graph from its sealed keyring. Needs the keys unlocked here; locked,
     * the invite says "a shared graph" and the name arrives with Accept. Best-effort: a vault
     * that will not open leaves the names out rather than failing the list.
     */
    async function readInviteNames(
        server: SyncServerView,
        listed: PendingInvite[],
    ) {
        if (listed.length === 0 || !server.heldKey()) return;
        try {
            const opened = await openHeldVault({
                api: server.api,
                origin: server.origin,
            });
            if (!opened) return;
            const named: Record<string, string> = {};
            for (const invite of listed) {
                const name = await inviteGraphName(
                    invite,
                    opened.vault.identityPrivateKey,
                );
                if (name) named[invite.id] = name;
            }
            server.inviteNames = named;
        } catch (err) {
            console.warn(
                "[graphs] could not open the vault to name pending invites",
                err,
            );
        }
    }

    /**
     * Decline an invite: it goes from the list and cannot be accepted any more; the owner
     * would need to invite again. An invite already withdrawn (cancelled by its owner, or
     * declined in another tab) comes off the list with a word to that effect.
     */
    async function declineInvite(
        server: SyncServerView,
        invite: PendingInvite,
    ) {
        if (withdrawingInvite) return;
        withdrawingInvite = invite.id;
        try {
            await server.api.withdrawInvite(invite.id);
            server.invites = server.invites.filter(
                (pending) => pending.id !== invite.id,
            );
            setStatus("Invite declined.");
        } catch (err) {
            if (err instanceof SyncApiError && err.status === 404) {
                server.invites = server.invites.filter(
                    (pending) => pending.id !== invite.id,
                );
                setStatus("That invite had already been withdrawn.");
            } else {
                setStatus(
                    describeSyncFailure(err, "decline the invite"),
                    "error",
                );
            }
        } finally {
            withdrawingInvite = null;
            decliningInvite = null;
        }
    }

    /** Cancel an invite this owner sent: the invitee can no longer accept it. */
    async function cancelInvite(
        server: SyncServerView,
        graph: SyncedGraphView,
        member: SyncedMember,
    ) {
        if (!member.inviteId || withdrawingInvite) return;
        withdrawingInvite = member.inviteId;
        clearRowStatus(graph.id);
        try {
            await server.api.withdrawInvite(member.inviteId);
            setRowStatus(graph.id, `Invite to ${member.email} cancelled.`);
        } catch (err) {
            if (err instanceof SyncApiError && err.status === 404) {
                setRowStatus(
                    graph.id,
                    `${member.email} is no longer invited: they accepted or declined meanwhile.`,
                );
            } else {
                setRowStatus(
                    graph.id,
                    describeSyncFailure(err, "cancel the invite"),
                    "error",
                );
            }
        } finally {
            withdrawingInvite = null;
            await refreshSynced(server);
        }
    }

    /**
     * Run `action` if `server`'s vault is unlocked here, else open the unlock dialog for that server
     * and resume after.
     */
    async function requireUnlockedVault(
        server: SyncServerView,
        action: () => Promise<void>,
    ): Promise<void> {
        if (server.heldKey()) {
            await action();
            return;
        }
        // No vault on the account (fresh, or just reset): an unlock prompt would ask for a
        // Recovery Code that does not exist. Explain instead of dead-ending the user.
        if (server.vaultExists === false) {
            setStatus(
                "This account has no encryption keys yet - they are created with your first synced graph.",
                "error",
            );
            return;
        }
        supersedePendingUnlock();
        unlockOrigin = server.origin;
        unlockThen = action;
    }

    /** Fail whoever was awaiting the dialog before handing it to a new caller. */
    function supersedePendingUnlock() {
        const cancelled = unlockCancelled;
        unlockCancelled = null;
        cancelled?.();
    }

    /**
     * Settle the account's encryption keys on `server` BEFORE anything is written for a new synced
     * graph there. Documents and assets reach the server during an import while the Graph Key that
     * opens them lives only in this tab, so a keyless account mints and commits its vault first
     * (ADR 0029 rung 1) and a locked one unlocks first. A vault not yet known is asked about now;
     * an unknown answer (the check failed, e.g. the server is unreachable) must not block: let the
     * attempt run and report the real error.
     */
    async function ensureAccountKeysReady(
        server: SyncServerView,
    ): Promise<void> {
        if (server.heldKey()) return;
        if (server.vaultExists === null) await server.refreshVault();
        if (server.vaultExists === true) {
            await unlockVaultInteractively(server.origin);
            server.syncUnlocked();
            return;
        }
        if (server.vaultExists !== false) return;
        // Say it on the page as well as in the dialog: the ritual interrupts what they asked for.
        setStatus(
            "This account had no encryption keys, so they are being created now. Nothing is uploaded until you save your Recovery Code.",
        );
        await mintAccountKeysWithRitual(
            server,
            "This account had no encryption keys, so EtherPK has just created them. Nothing is uploaded to the sync server until you have saved this code.",
        );
    }

    /**
     * Mint `server`'s account keys and hold until the Recovery Code is acknowledged, because the
     * acknowledgement is what writes the vault. Resolves with the keys usable on this device.
     */
    async function mintAccountKeysWithRitual(
        server: SyncServerView,
        reason?: string,
    ): Promise<void> {
        let created: Awaited<ReturnType<typeof createAccountKeys>>;
        try {
            created = await createAccountKeys(server.api);
        } catch (err) {
            // Another device minted first: join those keys rather than starting a rival account.
            if (
                (err as Error).message.includes("already has encryption keys")
            ) {
                server.vaultExists = true;
                await unlockVaultInteractively(server.origin);
                server.syncUnlocked();
                return;
            }
            throw err;
        }
        await new Promise<void>((resolve, reject) => {
            promptRecoveryCode({
                code: created.recoveryCode,
                arrival: "first",
                reason,
                ...recoveryCodeServer(server.origin),
                commit: created.commit,
                then: (err) => (err ? reject(err) : resolve()),
            });
        });
        server.cacheKey(created.deviceKey);
        server.vaultExists = true;
    }

    /**
     * Which server and account a Recovery Code belongs to, for the dialog and the saved file to
     * name (ADR 0111): the second server's code must never read as a replacement for the first's.
     */
    function recoveryCodeServer(origin: string): {
        serverOrigin: string;
        account: string | null;
    } {
        return {
            serverOrigin: origin,
            account: serverFor(origin)?.account?.principal.email ?? null,
        };
    }

    /**
     * Await an interactive unlock. Callers that cannot be resumed by a callback - a running
     * import asking for the key, a pre-flight before creating anything server-side - hold this
     * promise until the dialog succeeds, and are rejected if the user cancels.
     */
    function unlockVaultInteractively(origin: string): Promise<Uint8Array> {
        const cached = heldKey(origin);
        if (cached) return Promise.resolve(cached);
        return new Promise<Uint8Array>((resolve, reject) => {
            unlockCancelled = () =>
                reject(
                    new Error(
                        "Unlock your keys with your Recovery Code to continue.",
                    ),
                );
            unlockOrigin = origin;
            unlockThen = async () => {
                const key = heldKey(origin);
                if (key) resolve(key);
                else
                    reject(
                        new Error("The keys on this device are still locked."),
                    );
            };
        });
    }

    /**
     * The import dialog's synced destinations: every server this device holds, each able to take
     * the graph or saying why not. An import goes to the server chosen when it starts and stays
     * there: its keys, its Recovery Code and its record belong to that server's account (ADR 0111).
     */
    function importTargets(): ImportSyncTarget[] {
        return orderedServers.map((server) => {
            const scope =
                server.authState === "authenticated"
                    ? readSyncAccount(server.origin)
                    : null;
            return {
                origin: server.origin,
                deps: scope
                    ? {
                          api: server.api,
                          serverBaseUrl: server.connection.serverBaseUrl,
                          serverScope: scope,
                      }
                    : null,
                unavailableReason:
                    server.createBlockedReason ??
                    (scope ? null : `Checking your account on ${server.host}…`),
                assetLimits: server.account?.entitlement.limits ?? null,
            };
        });
    }

    /** Why no server can take an imported graph, when none can. */
    const importUnavailableReason = $derived(
        servers.length === 0
            ? signsInToManagedSync()
                ? "Sign in with an EtherPK account that has Sync+ to import into a synced graph."
                : "Connect this device to a Sync Server on the Sync tab to import into a synced graph."
            : "None of your Sync Servers can take a new graph now. The Graphs tab says why for each.",
    );

    /**
     * Keys must be in hand before an import creates anything on its server. The plan check comes
     * first for the same reason as in createServerGraph: the destination was offered from a plan
     * that may have changed since.
     */
    async function importVaultReady(origin: string): Promise<void> {
        const server = serverFor(origin);
        if (!server) throw new Error(noSyncConnectionMessage());
        await server.accountCheck;
        if (server.createBlockedReason)
            throw new Error(server.createBlockedReason);
        await ensureAccountKeysReady(server);
        rememberNewGraphServer(origin);
    }

    /**
     * Show a tab, replacing the address rather than adding a history entry for it. The address is
     * read from the window: after an earlier shallow replace, `page.url` still carries parameters
     * that have since come off (`?sync=connect`, `?managed=…`). The Sync tab keeps its sub-tab.
     */
    function showTab(tab: "graphs" | "sync") {
        activeTab = tab;
        const url = new URL(window.location.href);
        if (tab === "sync") url.searchParams.set("tab", "sync");
        else {
            url.searchParams.delete("tab");
            url.searchParams.delete("server");
        }
        replaceState(url.pathname + url.search + url.hash, page.state);
    }

    /** Show the Sync tab on one server's sub-tab, or Add, with the choice kept in the address. */
    function showSyncPanel(panel: SyncServerView | "add") {
        requestedSyncPanel = panel === "add" ? "add" : panel.host;
        activeTab = "sync";
        const url = new URL(window.location.href);
        url.searchParams.set("tab", "sync");
        url.searchParams.set("server", requestedSyncPanel);
        replaceState(url.pathname + url.search + url.hash, page.state);
    }

    /**
     * Open the Sync tab on `panel` with the caret where the next step is: on Add, the Managed Sync
     * sign-in while it is offered, else the server address, else the token; on a server, its tab.
     */
    async function openSyncPanel(panel: SyncServerView | "add") {
        if (panel === "add") primeAddForm();
        showSyncPanel(panel);
        await tick();
        const root = document.getElementById("graphs-sync-settings");
        root?.scrollIntoView({ block: "nearest" });
        const next =
            panel !== "add"
                ? root?.querySelector<HTMLElement>(
                      '[data-testid="sync-server-tab"][aria-selected="true"]',
                  )
                : addOffersManaged && connectionMode === "managed"
                  ? root?.querySelector<HTMLElement>(
                        '[data-testid="managed-sync-connect"]',
                    )
                  : document.getElementById(
                        serverBaseUrl.trim() ? "sync-token" : "sync-url",
                    );
        next?.focus();
    }

    /**
     * The header's Connect Sync: Managed Sync's own sub-tab when the device holds it but is signed
     * out there, where Sign in is; otherwise the form to add a server. Decided once the account
     * checks have answered.
     */
    async function openConnectSync() {
        activeTab = "sync";
        await Promise.all(servers.map((server) => server.accountCheck));
        await openSyncPanel(
            managedServer?.authState === "signed-out" ? managedServer : "add",
        );
    }

    // The header's Connect Sync and the notices that send people here open the Sync tab. Read on
    // every change of address, not once at mount: a click while this page is open navigates to
    // the same route, which does not remount it. The parameter then comes off, so the next click
    // opens it again and a reload does not.
    $effect(() => {
        if (page.url.searchParams.get("sync") !== "connect") return;
        const url = new URL(page.url);
        url.searchParams.delete("sync");
        url.searchParams.set("tab", "sync");
        // After a macrotask, as announceArrival does: on a first load the router is still starting.
        setTimeout(() => {
            replaceState(url.pathname + url.search, {});
            untrack(() => void openConnectSync());
        }, 0);
    });

    /** Prime the add form: Managed Sync while it is offered and not held, else a custom server. */
    function primeAddForm() {
        if (addOffersManaged) {
            connectionMode = "managed";
            return;
        }
        connectionMode = "custom";
        if (!serverBaseUrl.trim()) serverBaseUrl = configuredCustomSyncUrl;
    }

    /**
     * A custom server refused its access token: the add form, filled in with that server's
     * address, takes a new one. Saving the same address replaces the connection in place.
     */
    async function reconnect(server: SyncServerView) {
        connectionMode = "custom";
        serverBaseUrl = server.connection.serverBaseUrl;
        token = "";
        syncUrlError = null;
        syncTokenError = null;
        showSyncPanel("add");
        await tick();
        document.getElementById("sync-token")?.focus();
    }

    function connectManagedSync() {
        if (!managedSyncAvailable) {
            setStatus(
                "Managed Sync is not available from this Client.",
                "error",
            );
            return;
        }
        // Held beside any custom server the device already holds.
        saveManagedSyncConnection();
        // Back to the page that sent the person here to connect, if one did; otherwise to this
        // page, which then says the sign-in worked.
        window.location.href = managedSignInHref(returnTo);
    }

    /**
     * Disconnect Managed Sync on this device: its keys lock and the Client's session ends, and the
     * connection stays held, signed out. Custom servers this device holds are untouched.
     */
    async function disconnectManagedSync() {
        const origin = managedServer?.origin;
        clearManagedAccessToken();
        if (origin) {
            lockVault(origin);
            clearSyncAccount(origin);
        }
        await fetch("/auth/logout", { method: "POST" });
        window.location.href = "/graphs?tab=sync&managed=disconnected";
    }

    /** The server whose Forget waits for its confirmation, and one being forgotten. */
    let confirmingForget = $state<string | null>(null);
    let forgettingServer = $state<string | null>(null);

    /**
     * Forget a server on this device: its connection, the account confirmed there and its keys
     * held here. Nothing on the server changes. Its synced graphs' copies stay in this browser,
     * hidden, until the server is added again or they are removed under This browser. Forgetting
     * Managed Sync also ends the Client's session, so a silent sign-in cannot add it straight back.
     */
    async function forgetServer(server: SyncServerView) {
        if (forgettingServer) return;
        const { connection } = server;
        forgettingServer = connection.origin;
        try {
            lockVault(connection.origin);
            clearSyncAccount(connection.origin);
            if (connection.kind === "managed") {
                clearManagedAccessToken();
                await fetch("/auth/logout", { method: "POST" }).catch(
                    () => undefined,
                );
            }
            ownConnectionChange(() => forgetSyncConnection(connection.origin));
            confirmingForget = null;
            setStatus(
                connection.kind === "managed"
                    ? `Forgot ${server.host} on this device. Your EtherPK account and its graphs are unchanged.`
                    : `Forgot ${server.host} on this device. Its access token stays active until you revoke it on the server.`,
            );
            await refresh();
            // Its sub-tab is gone: the Sync tab moves to the primary server, else Add.
            showSyncPanel(primaryServer ?? "add");
        } finally {
            forgettingServer = null;
        }
    }

    /**
     * A write to the stored connections made by this page, which refreshes itself afterwards. The
     * write announces itself synchronously to this tab (SYNC_CONNECTIONS_CHANGED_EVENT), and the
     * listener that keeps the page in step with the header menu skips it while this is set.
     */
    let changingConnections = false;
    function ownConnectionChange<T>(write: () => T): T {
        changingConnections = true;
        try {
            return write();
        } finally {
            changingConnections = false;
        }
    }

    /**
     * A one-shot arrival notice: a sign-out, a disconnect or a sign-in that ended on this page
     * says so here, then the parameter comes off the address so a reload does not repeat it.
     */
    function announceArrival() {
        const managed = page.url.searchParams.get("managed");
        const sync = page.url.searchParams.get("sync");
        const notice =
            managed === "signed-out"
                ? "You are signed out of EtherPK in this browser."
                : managed === "disconnected"
                  ? "This device is disconnected and its keys are locked. Your EtherPK account and the Sync Server stay signed in."
                  : managed === "connected"
                    ? "Signed in to EtherPK."
                    : sync === "disconnected"
                      ? "This device is disconnected from that Sync Server. Its access token stays active until you revoke it on the server."
                      : null;
        if (!notice) return;
        setStatus(notice);
        const url = new URL(page.url);
        url.searchParams.delete("managed");
        if (sync === "disconnected") url.searchParams.delete("sync");
        // After a macrotask: on a first load SvelteKit's router finishes starting after this
        // page mounts, and replaceState before then throws in development.
        setTimeout(() => replaceState(url.pathname + url.search, {}), 0);
    }

    /** Signed out of `server`, an action that needs the account starts the way back in instead. */
    function startSignIn(server: SyncServerView) {
        if (server.connection.kind === "managed") {
            connectManagedSync();
            return;
        }
        setStatus(
            `${server.host} did not accept this device's access token. Add a new one on the Sync tab, then try again.`,
            "error",
        );
        void reconnect(server);
    }

    function prepareManagedSignOut() {
        // The form navigation continues through Corporate and Server. Clear in-memory and local
        // identity state before leaving so no authenticated UI survives if navigation is delayed.
        // Only Managed Sync's account signs out: a custom server's is its own.
        clearManagedAccessToken();
        const origin = managedServer?.origin;
        if (origin) {
            lockVault(origin);
            clearSyncAccount(origin);
        }
    }

    /** The rules a Custom server field is held to before anything is sent. */
    function syncFieldErrors(url: string, pat: string) {
        return {
            url: !url
                ? "Enter the Sync Server's address."
                : !/^https?:\/\//i.test(url)
                  ? "Start the address with https://, or http:// for a server on this computer."
                  : null,
            token: pat
                ? null
                : {
                      message:
                          "Enter a Personal Access Token from the Sync Server.",
                  },
        };
    }

    async function focusFirstSyncError() {
        await tick();
        document
            .getElementById(syncUrlError ? "sync-url" : "sync-token")
            ?.focus();
    }

    /**
     * Save a Custom server connection once the server has accepted it. The account lookup answers
     * before anything is written, so a mistyped, revoked or graph-limited token, or the app's own
     * address pasted as the server's, is said at its field while the form is still open.
     */
    async function saveSyncConfig() {
        if (syncSaving) return;
        const url = serverBaseUrl.trim();
        const pat = token.trim();
        const errors = syncFieldErrors(url, pat);
        syncUrlError = errors.url;
        syncTokenError = errors.token;
        if (syncUrlError || syncTokenError) {
            await focusFirstSyncError();
            return;
        }
        syncSaving = true;
        try {
            await createSyncApi({ baseUrl: url, token: pat }).me();
        } catch (err) {
            const failure = describeConnectionCheckFailure(err, url);
            if (failure.field === "token") {
                syncTokenError = {
                    message: failure.message,
                    tokensUrl: failure.tokensUrl,
                };
            } else {
                syncUrlError = failure.message;
            }
            await focusFirstSyncError();
            return;
        } finally {
            syncSaving = false;
        }
        // Beside any other server this device holds, replacing only one to the same server (a new
        // token for it).
        const saved = ownConnectionChange(() =>
            saveCustomSyncConnection(url, pat),
        );
        token = "";
        setStatus(`Connected to ${new URL(url).host}.`);
        await refresh();
        // The server's own sub-tab, now it has one.
        const server = serverFor(saved.origin);
        if (server) showSyncPanel(server);
        // Sent here by a page that needed this connection: go back to it once it works.
        if (returnTo && server?.authState === "authenticated")
            void goto(returnTo);
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
            // Closing the picker rejects with an AbortError whose message names the browser API;
            // it is a choice, not a failure, so it is said plainly and not as an error.
            if (err instanceof DOMException && err.name === "AbortError") {
                setStatus(
                    "Could not open a folder. User cancelled folder selection.",
                );
                return;
            }
            setStatus(
                `Could not open a folder: ${(err as Error).message}`,
                "error",
            );
        }
    }

    /**
     * Step 1 of creation: ask for a name, and with more than one server held, which server. The
     * account checks answer first, so a server whose plan cannot take the graph is offered with its
     * reason rather than refused after the name is typed. The keys wait for Create, when the server
     * is known.
     */
    function startCreateServerGraph() {
        if (createPending) return;
        if (servers.length === 0) {
            // Nothing to create a synced graph through yet, so start the way to one rather than
            // refusing: the EtherPK sign-in, which comes back here.
            if (signsInToManagedSync()) {
                connectManagedSync();
                return;
            }
            // A custom server's address and token, asked for where they are typed.
            setStatus(
                serverBaseUrl.trim()
                    ? "Connect this device to a Sync Server to create a synced graph: enter an access token from it below."
                    : "Connect this device to a Sync Server to create a synced graph: enter its address and an access token below.",
            );
            void openSyncPanel("add");
            return;
        }
        createPending = true;
        void (async () => {
            try {
                // The plans are only known once the account checks have answered; a click that
                // lands before then waits for them rather than racing them (it then either
                // proceeds or is refused, exactly as a later click would be).
                await Promise.all(servers.map((server) => server.accountCheck));
                const usable = orderedServers.filter(
                    (server) => server.createBlockedReason === null,
                );
                if (servers.length === 1) {
                    const only = servers[0];
                    // Signed out, or the token refused: naming a graph could only fail later.
                    if (only.authState === "signed-out") {
                        startSignIn(only);
                        return;
                    }
                    if (only.createBlockedReason) {
                        setStatus(only.createBlockedReason, "error");
                        return;
                    }
                } else if (usable.length === 0) {
                    setStatus(
                        "None of your Sync Servers can take a new graph now. Each one's group below says why.",
                        "error",
                    );
                    return;
                }
                createName = "";
                createError = null;
                createOrigin = defaultServerForNewGraph(
                    usable.map((server) => server.origin),
                    readLastNewGraphServer(),
                    managedServer?.origin ?? null,
                );
                createDialog = true;
            } finally {
                createPending = false;
            }
        })();
    }

    /**
     * Create the graph on the server chosen. Its plan is checked again and its keys settled first,
     * in front of the person: naming a graph this device cannot key, then creating it server-side
     * only to fail, used to leave an empty graph against the owner's allowance, and on a keyless
     * account the code ritual belongs before the graph, not after it.
     */
    async function createServerGraph() {
        const name = createName.trim();
        const server = serverFor(createOrigin);
        if (createBusy || !name) return;
        if (!server) {
            createError = "Choose the Sync Server to store the graph on.";
            return;
        }
        createBusy = true;
        createError = null;
        try {
            createStage = "Checking your plan…";
            await server.accountCheck;
            if (server.createBlockedReason) {
                createError = server.createBlockedReason;
                return;
            }
            createStage = "Preparing your encryption keys…";
            await ensureAccountKeysReady(server);
            createStage = "Creating…";
            const graph = await server.api.createGraph(); // server stores no name (ADR 0024)
            const keys = await withGraphCleanupOnFailure(
                server.api,
                graph.id,
                () =>
                    ensureGraphKeys(server.api, graph.id, () =>
                        unlockVaultInteractively(server.origin),
                    ),
            );
            const { recoveryCodeJustGenerated, deviceKey, commit } = keys;
            server.cacheKey(deviceKey);
            // The name lands in the local registry now; the first open seeds it into the
            // encrypted meta map (ADR 0031), where it becomes canonical for every member.
            await registry.insertGraph({
                id: graph.id,
                name,
                backend: "server",
                createdAt: Date.now(),
                handle: { rootDocId: graph.rootDocId },
                serverScope: requireServerScope(server.origin),
                membershipActive: true,
            });
            rememberNewGraphServer(server.origin);
            createDialog = false;
            if (recoveryCodeJustGenerated) {
                // Prevention (ADR 0029): the vault is written only once the code is acknowledged.
                // Creation still navigates on confirm - unlike an import, the user has been
                // waiting on a dialog and has gone nowhere.
                promptRecoveryCode({
                    code: recoveryCodeJustGenerated,
                    arrival: "first",
                    ...recoveryCodeServer(server.origin),
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
            createError = describeSyncFailure(err, "create a synced graph");
        } finally {
            createBusy = false;
            createStage = "Creating…";
        }
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
    function onImportSettled(
        result: {
            graphId: string;
            recoveryCode?: string;
            commit?: () => Promise<void>;
            deviceKey?: Uint8Array;
        },
        origin: string | null,
    ) {
        if (result.deviceKey && origin) {
            const server = serverFor(origin);
            if (server) server.cacheKey(result.deviceKey);
        }
        // An import runs in the background and finishes wherever the user has wandered to. When
        // that is this page, the new graph would otherwise be missing from both lists until a
        // reload - the local registry is read on mount, and the synced panel with it.
        void refresh();
        if (result.recoveryCode && origin) {
            promptRecoveryCode({
                code: result.recoveryCode,
                arrival: "first",
                ...recoveryCodeServer(origin),
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
            console.warn(
                "[index] could not discard the search index of",
                graphId,
                error,
            ),
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
            console.warn(
                "[index] could not sweep unlisted search indexes",
                error,
            );
        }
    }

    /** A synced registry record's root document id, which lives on its handle. */
    function rootDocIdOf(graph: GraphRecord): string {
        return (graph.handle as { rootDocId: string }).rootDocId;
    }

    /** The unsent documents the open dialog listed for `graphId`: what the person agreed to lose. */
    function agreedUnsent(graphId: string): string[] {
        return discardUnsent?.graphId === graphId
            ? discardUnsent.unsent.map((document) => document.docId)
            : [];
    }

    /**
     * Read what this browser holds for a synced graph that the server never received, before a
     * dialog offers to delete it. A failed read opens nothing: deleting what could not be checked
     * is exactly the loss this guards against.
     */
    async function checkUnsentBeforeDiscard(
        graphId: string,
        rootDocId: string,
        name: string,
    ): Promise<boolean> {
        discardChecking = graphId;
        try {
            discardUnsent = {
                graphId,
                unsent: await staleCopyUnsentChanges(graphId, rootDocId),
                downloaded: false,
            };
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
        if (
            graph.backend === "server" &&
            !(await checkUnsentBeforeDiscard(
                graph.id,
                rootDocIdOf(graph),
                graph.name,
            ))
        )
            return;
        forgetConfirm = graph;
    }

    async function askLeave(server: SyncServerView, graph: SyncedGraphView) {
        if (discardChecking) return;
        discardUnsent = null;
        if (
            !(await checkUnsentBeforeDiscard(
                graph.id,
                graph.rootDocId,
                graph.name,
            ))
        )
            return;
        leaveConfirm = { server, graph };
    }

    /**
     * Start removing the synced graphs this browser holds for `server` (null: for servers the
     * device no longer holds), under any account: count what each copy holds that the server never
     * received first. A copy that cannot be checked stops it, since deleting what could not be
     * checked is the loss the check exists to prevent.
     */
    async function startRemoveCopies(server: SyncServerView | null) {
        if (removeCopiesChecking || removeSynced) return;
        removeCopiesChecking = server?.origin ?? "unheld";
        try {
            const held = servers.map((each) => each.origin);
            const copies = (await createIdbGraphStoragePort().getAll()).filter(
                (record) =>
                    record.backend === "server" &&
                    copyServer(record, held) === (server?.origin ?? null),
            );
            const checked: Array<{
                graph: GraphRecord;
                unsent: UnsentDocument[];
            }> = [];
            for (const graph of copies) {
                checked.push({
                    graph,
                    unsent: await staleCopyUnsentChanges(
                        graph.id,
                        rootDocIdOf(graph),
                    ),
                });
            }
            if (checked.length === 0) {
                await listRegistry();
                setStatus(
                    server
                        ? `No synced graphs from ${server.host} are stored in this browser.`
                        : "No synced graphs from other Sync Servers are stored in this browser.",
                );
                return;
            }
            removeSynced = {
                server,
                held: checked,
                downloaded: false,
                grew: false,
            };
        } catch (err) {
            setStatus(
                `Could not check this browser's synced graphs for changes the server has not received, so nothing was removed: ${(err as Error).message}. Try again.`,
                "error",
            );
        } finally {
            removeCopiesChecking = null;
        }
    }

    function downloadRemoveSyncedUnsent() {
        if (!removeSynced) return;
        for (const { graph, unsent } of removeSynced.held) {
            if (unsent.length > 0) saveUnsentChangesFile(unsent, graph.name);
        }
        removeSynced = { ...removeSynced, downloaded: true };
    }

    /**
     * Remove them: each copy goes only if what is unsent in it is what the dialog showed
     * (`discardUnlessUnsent` counts again), and the keys held here for their server are locked.
     * Other servers' copies and keys are untouched. The graphs stay on their server.
     */
    async function executeRemoveSynced() {
        const pending = removeSynced;
        if (!pending || removeSyncedBusy) return;
        removeSyncedBusy = true;
        const grew: Array<{ graph: GraphRecord; unsent: UnsentDocument[] }> =
            [];
        let removed = 0;
        const where = pending.server
            ? pending.server.host
            : "Sync Servers this device no longer holds";
        try {
            for (const { graph, unsent } of pending.held) {
                const outcome = await discardUnlessUnsent(
                    { graphId: graph.id, rootDocId: rootDocIdOf(graph) },
                    {
                        inspect: staleCopyUnsentChanges,
                        discard: () => forgetGraphOnDevice(graph),
                        agreed: unsent.map((document) => document.docId),
                    },
                );
                if (outcome.kind === "confirm")
                    grew.push({ graph, unsent: outcome.unsent });
                else removed += 1;
            }
            if (pending.server) pending.server.lock();
            else {
                const origins = new Set(
                    pending.held.flatMap(
                        ({ graph }) => graph.serverScope?.serverOrigin ?? [],
                    ),
                );
                for (const origin of origins) lockVault(origin);
            }
            removeSynced =
                grew.length > 0
                    ? { ...pending, held: grew, downloaded: false, grew: true }
                    : null;
            await refresh();
            if (grew.length === 0) {
                const copies =
                    removed === 1
                        ? "copy of 1 synced graph"
                        : `copies of ${removed} synced graphs`;
                setStatus(
                    `Removed this browser's ${copies} from ${where}, and locked the keys held here for ${pending.server ? "it" : "them"}. The graphs are still on the sync server.`,
                );
            }
        } catch (err) {
            removeSynced = null;
            await refresh();
            setStatus(
                `${describeSyncFailure(err, `remove the synced graphs from ${where} from this browser`)} ${removed} of ${pending.held.length} were removed - try again for the rest.`,
                "error",
            );
        } finally {
            removeSyncedBusy = false;
        }
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
                    {
                        inspect: staleCopyUnsentChanges,
                        discard: () => forgetGraphOnDevice(graph),
                        agreed: agreedUnsent(graph.id),
                    },
                );
                if (outcome.kind === "confirm") {
                    // More became unsent since the dialog opened: count it again and ask again.
                    discardUnsent = {
                        graphId: graph.id,
                        unsent: outcome.unsent,
                        downloaded: false,
                        grew: true,
                    };
                    return;
                }
            } else {
                await forgetGraphOnDevice(graph);
            }
            forgetConfirm = null;
            discardUnsent = null;
            await refresh();
        } catch (err) {
            forgetError = describeSyncFailure(err, "forget the graph");
        } finally {
            forgetBusy = false;
        }
    }

    /**
     * The held server a synced record lives on, or null with its row told why: the page never
     * acts on a graph through a server other than its own.
     */
    function serverOfRecord(graph: GraphRecord): SyncServerView | null {
        const server = serverFor(graph.serverScope?.serverOrigin);
        if (!server) {
            setRowStatus(
                graph.id,
                "This device is not connected to the Sync Server that stores this graph. Add it on the Sync tab.",
                "error",
            );
        }
        return server;
    }

    /** Open the rename dialog — a synced rename needs the vault (it writes the meta map). */
    function renameGraph(graph: GraphRecord) {
        if (graph.backend !== "server") {
            renameDialog = graph;
            return;
        }
        const server = serverOfRecord(graph);
        if (!server) return;
        void requireUnlockedVault(server, async () => {
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
        origin: string,
        options: {
            keyring?: GraphKeyring;
            publishName?: (name: string) => void;
        } = {},
    ): Promise<SyncedMetaSessionDeps> {
        const connection = resolveSyncedGraphConnection(graphId, origin);
        if (!connection)
            throw new Error(
                `This device is not connected to ${serverHost(origin)}. Connect to it on the Sync tab.`,
            );
        const { api } = connection;
        let keyring = options.keyring;
        if (!keyring) {
            if (!heldKey(origin)) throw new Error("Unlock your vault first.");
            const opened = await openHeldVault({ api, origin });
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
                createGraphNamePublisher({ api, keyring: held, graphId })
                    .publish,
        };
    }

    /** The deps for a graph already in the local registry (rootDocId and server live on its record). */
    function recordMetaDeps(
        graph: GraphRecord,
    ): Promise<SyncedMetaSessionDeps> {
        return metaSessionDepsFor(
            graph.id,
            (graph.handle as { rootDocId: string }).rootDocId,
            graph.serverScope!.serverOrigin,
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
        const server = serverOfRecord(graph);
        if (!server) return;
        void requireUnlockedVault(server, async () => {
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
                clearRowStatus(graph.id);
            } catch (err) {
                setRowStatus(
                    graph.id,
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

    function inviteToGraph(
        server: SyncServerView,
        graphId: string,
        graphName?: string,
    ) {
        void requireUnlockedVault(server, async () => {
            const wrapKey = server.heldKey()!;
            try {
                const existing = await server.api.getVault();
                if (!existing) throw new Error("No vault on this device");
                const opened = await openVault(
                    fromBase64Url(existing.vault),
                    wrapKey,
                );
                server.cacheKey(opened.vaultKey); // self-heal: the vault key survives re-keys
                const keyring = opened.vault.keyrings.find(
                    (k) => k.graphId === graphId,
                );
                if (!keyring) throw new Error("You do not hold this graph key");
                inviteDialog = { server, graphId, graphName, keyring };
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
    function startTransfer(server: SyncServerView, graph: SyncedGraphView) {
        clearRowStatus(graph.id);
        // Only somebody who has accepted holds the graph's key and can take it over.
        const candidates = (graph.members ?? []).filter(
            (m) => m.role === "player" && m.status !== "invited",
        );
        transferDialog = { server, graph, candidates };
    }

    /**
     * Register a server graph this device doesn't know yet. The record takes the name the
     * server's name envelope gave the row, or its root document read once (ADR 0031,
     * amended), or failing that the
     * one read from the encrypted meta map here; opening the graph refreshes it either way.
     * The same write repairs a record stranded under a previous account scope, and the
     * workspace's "Set it up here" runs it too (register-synced-graph.ts).
     */
    function addToDevice(server: SyncServerView, graph: SyncedGraphView) {
        const origin = server.origin;
        // Unlock-gated so the graph's REAL name can be read at add time — otherwise a
        // re-added graph shows the placeholder until first open, and a rename done before
        // Forget looks lost.
        void requireUnlockedVault(server, async () => {
            setRowStatus(graph.id, "Adding to this device…");
            // The row is already named: no root document download is needed.
            let name: string | undefined =
                graph.nameSource !== "placeholder" ? graph.name : undefined;
            if (!name) {
                try {
                    const session = await openSyncedGraphMetaSession(
                        await metaSessionDepsFor(
                            graph.id,
                            graph.rootDocId,
                            origin,
                        ),
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
                    if (
                        err instanceof EnvelopeError ||
                        err instanceof VaultLockedError
                    ) {
                        setRowStatus(
                            graph.id,
                            describeSyncFailure(
                                err,
                                "add the graph to this device",
                            ),
                            "error",
                        );
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
                    { registry, scope: requireServerScope(origin) },
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

    async function askDelete(server: SyncServerView, graph: SyncedGraphView) {
        if (discardChecking) return;
        discardUnsent = null;
        deleteText = "";
        deleteError = null;
        if (
            !(await checkUnsentBeforeDiscard(
                graph.id,
                graph.rootDocId,
                graph.name,
            ))
        )
            return;
        deleteConfirm = { server, graph };
    }

    /**
     * Permanently delete an owned graph (confirmed by typing DELETE). Every member loses it, and
     * this browser's copy goes with its outbox, so the same unsent guard as Forget and Leave: the
     * count is taken again here, and a read that fails deletes nothing.
     */
    async function executeDelete() {
        const pending = deleteConfirm;
        if (!pending || deleteBusy || deleteText !== "DELETE") return;
        const { server, graph } = pending;
        deleteBusy = true;
        deleteError = null;
        try {
            const outcome = await discardUnlessUnsent(
                { graphId: graph.id, rootDocId: graph.rootDocId },
                {
                    inspect: staleCopyUnsentChanges,
                    discard: async () => {
                        await server.api.deleteGraph(graph.id);
                        await forgetGraphOnDevice({
                            id: graph.id,
                            backend: "server",
                        });
                    },
                    agreed: agreedUnsent(graph.id),
                },
            );
            if (outcome.kind === "confirm") {
                // Nothing deleted; the typed DELETE stays for the second confirmation.
                discardUnsent = {
                    graphId: graph.id,
                    unsent: outcome.unsent,
                    downloaded: false,
                    grew: true,
                };
                return;
            }
            discardUnsent = null;
            deleteConfirm = null;
            deleteText = "";
            await refresh();
            setStatus(
                `"${graph.name}" has been permanently deleted from ${server.host}.`,
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
        const pending = leaveConfirm;
        if (leaveBusy || !pending) return;
        const { server, graph } = pending;
        leaveBusy = true;
        try {
            // Leaving deletes this browser's copy with its outbox, so the same guard as Forget:
            // nothing unsent is lost without the person having seen it counted.
            const outcome = await discardUnlessUnsent(
                { graphId: graph.id, rootDocId: graph.rootDocId },
                {
                    inspect: staleCopyUnsentChanges,
                    discard: async () => {
                        await server.api.leaveGraph(graph.id);
                        await forgetGraphOnDevice({
                            id: graph.id,
                            backend: "server",
                        });
                    },
                    agreed: agreedUnsent(graph.id),
                },
            );
            if (outcome.kind === "confirm") {
                discardUnsent = {
                    graphId: graph.id,
                    unsent: outcome.unsent,
                    downloaded: false,
                    grew: true,
                };
                return;
            }
            discardUnsent = null;
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
    async function acceptInvite(server: SyncServerView, invite: PendingInvite) {
        if (checkingInvite) return;
        checkingInvite = invite.id;
        try {
            const outcome = await acceptUnlessUnsent(invite, {
                inspect: staleCopyUnsentChanges,
                accept: () => acceptInviteDiscardingCopy(server, invite),
            });
            if (outcome.kind === "confirm") {
                const record = await registry
                    .getGraph(invite.graphId)
                    .catch(() => null);
                staleCopy = {
                    server,
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
            pending.server,
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
        server: SyncServerView,
        invite: PendingInvite,
        agreed: readonly string[] = [],
        graphName?: string,
    ): Promise<void> {
        return requireUnlockedVault(server, async () => {
            const wrapKey = server.heldKey()!;
            try {
                const existing = await server.api.getVault();
                if (!existing) throw new Error("No vault on this device");
                const opened = await openVault(
                    fromBase64Url(existing.vault),
                    wrapKey,
                );
                server.cacheKey(opened.vaultKey); // self-heal: the vault key survives re-keys
                let accepted:
                    | Awaited<ReturnType<typeof acceptInviteFlow>>
                    | undefined;
                const outcome = await discardUnlessUnsent(invite, {
                    inspect: staleCopyUnsentChanges,
                    agreed,
                    discard: async () => {
                        accepted = await acceptInviteFlow(
                            server.api,
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
                        const record = await registry
                            .getGraph(invite.graphId)
                            .catch(() => null);
                        staleCopy = {
                            server,
                            invite,
                            unsent: outcome.unsent,
                            graphName:
                                graphName ?? record?.name ?? "Shared graph",
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
                    serverScope: requireServerScope(server.origin),
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
        const server = serverFor(unlockOrigin);
        unlockThen = null;
        unlockCancelled = null;
        unlockOrigin = null;
        server?.syncUnlocked();
        if (action) await action();
        // The keys now open the name envelopes: label the graphs this device never added.
        if (server?.vaultUnlocked && server.authState === "authenticated")
            void refreshSynced(server);
    }

    /**
     * Mint the account's keys and Recovery Code on their own. Waiting for the first synced graph
     * made the ritual a surprise at the end of a long import, and left an account that had just
     * been reset with no way to get a code at all until it uploaded something.
     */
    function createKeys(server: SyncServerView) {
        void (async () => {
            try {
                await mintAccountKeysWithRitual(
                    server,
                    `These are your account's new encryption keys on ${server.host}. Every synced graph you create or join on this Sync Server from now on is protected by them.`,
                );
                setStatus(
                    `Encryption keys created on ${server.host}. Your synced graphs there will use them from now on.`,
                );
            } catch (err) {
                setStatus(
                    describeSyncFailure(err, "create encryption keys"),
                    "error",
                );
            }
        })();
    }

    function regenerateKit(server: SyncServerView) {
        const origin = server.origin;
        void requireUnlockedVault(server, async () => {
            let prepared: RecoveryCodeRegeneration;
            try {
                prepared = await regenerateRecoveryCode(
                    server.api,
                    server.heldKey()!,
                );
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
                ...recoveryCodeServer(origin),
                reason: `Your current code for ${server.host} still works. When you continue, it stops working for good and only this new code can unlock your keys there. Codes for other Sync Servers are not affected. Save this one first.`,
                commit: async () => {
                    deviceKey = await prepared.commit();
                },
                cancel: () => setStatus("Your Recovery Code is unchanged."),
                then: (err) => {
                    if (err) {
                        void settleFailedRegenerate(prepared, err, server);
                        return;
                    }
                    // Cached only now: for a legacy vault the upgrade minted this key at commit.
                    server.cacheKey(deviceKey!);
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
        server: SyncServerView,
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
            server.cacheKey(active);
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
        unlockOrigin = null;
        cancelled?.();
    }

    /**
     * Reveal this account's own identity fingerprint, so an invitee can read it out and the
     * inviter's comparison in InviteDialog can be completed.
     * Needs the vault open, because the identity key lives inside it.
     */
    function showOwnFingerprint(server: SyncServerView) {
        server.fingerprintPending = true;
        void requireUnlockedVault(server, async () => {
            try {
                server.fingerprint = await accountIdentityFingerprint(
                    server.api,
                    async () => server.heldKey()!,
                );
                if (!server.fingerprint) {
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
                server.fingerprintPending = false;
            }
        }).finally(() => {
            // requireUnlockedVault resolves without running the action when the user cancels.
            server.fingerprintPending = false;
        });
    }

    /** Unlock on its own, so the keys can be restored without regenerating the Recovery Code. */
    function unlockKeys(server: SyncServerView) {
        // Straight to the dialog, even with a key held here: that key may be one a reset on
        // another device left out of date, and a successful unlock replaces it.
        supersedePendingUnlock();
        unlockOrigin = server.origin;
        unlockThen = async () => {
            server.syncUnlocked();
            setStatus(`Keys for ${server.host} unlocked on this device.`);
        };
    }

    async function onResetComplete() {
        const server = resetServer;
        resetServer = null;
        if (!server) return;
        // Forget this server's synced graphs here and its unlocked vault; a fresh identity is
        // minted next time. Other servers' graphs and keys have nothing to do with this reset.
        for (const g of recordsFor(server)) await registry.removeGraph(g.id);
        server.lock();
        server.vaultExists = false; // eager — refresh() re-checks, but don't flash the old button
        await refresh();
        setStatus(
            `Your encryption keys on ${server.host} have been reset. Create a new synced graph there to start over.`,
        );
    }

    /** Arrow keys, Home and End move between the two tabs, as the ARIA tabs pattern expects. */
    function onTabKeydown(event: KeyboardEvent) {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const next =
            event.key === "Home"
                ? "graphs"
                : event.key === "End"
                  ? "sync"
                  : activeTab === "graphs"
                    ? "sync"
                    : "graphs";
        showTab(next);
        void tick().then(() =>
            document
                .getElementById(
                    next === "sync" ? "graphs-tab-sync" : "graphs-tab-graphs",
                )
                ?.focus(),
        );
    }

    /** The same keys move between the Sync tab's sub-tabs: one per server, then Add. */
    function onSyncTabKeydown(event: KeyboardEvent) {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const panels: Array<SyncServerView | "add"> = [
            ...orderedServers,
            "add",
        ];
        const at = panels.indexOf(syncPanel);
        const index =
            event.key === "Home"
                ? 0
                : event.key === "End"
                  ? panels.length - 1
                  : (at +
                        (event.key === "ArrowRight" ? 1 : panels.length - 1)) %
                    panels.length;
        showSyncPanel(panels[index]);
        void tick().then(() =>
            document
                .querySelector<HTMLElement>(
                    '#sync-server-tabs [role="tab"][aria-selected="true"]',
                )
                ?.focus(),
        );
    }

    /** What a server's group asks of the page. */
    function groupActions(server: SyncServerView): SyncServerGroupActions {
        return {
            open: (record) => void openGraph(record),
            add: (view) => addToDevice(server, view),
            rename: (record) => renameGraph(record),
            settings: (record) => openSyncedSettings(record),
            forget: (record) => void askForget(record),
            invite: (view, record) =>
                inviteToGraph(
                    server,
                    view.id,
                    record ? record.name : undefined,
                ),
            transfer: (view) => startTransfer(server, view),
            delete: (view) => void askDelete(server, view),
            leave: (view) => void askLeave(server, view),
            cancelInvite: (view, member) =>
                void cancelInvite(server, view, member),
            acceptInvite: (invite) => void acceptInvite(server, invite),
            declineInvite: (invite) => void declineInvite(server, invite),
            beginDecline: (inviteId) => (decliningInvite = inviteId),
            signIn: () => startSignIn(server),
            reconnect: () => void reconnect(server),
            retry: () => void retryServer(server),
            showSettings: () => void openSyncPanel(server),
        };
    }

    /** What a server's sub-tab on the Sync tab asks of the page. */
    function settingsActions(
        server: SyncServerView,
    ): SyncServerSettingsActions {
        return {
            signIn: () => startSignIn(server),
            reconnect: () => void reconnect(server),
            prepareSignOut: prepareManagedSignOut,
            disconnect: () => void disconnectManagedSync(),
            beginForget: () => (confirmingForget = server.origin),
            cancelForget: () => (confirmingForget = null),
            forget: () => void forgetServer(server),
            checkPlan: () => void server.recheckPlan({ manual: true }),
            createKeys: () => createKeys(server),
            regenerate: () => regenerateKit(server),
            unlock: () => unlockKeys(server),
            showFingerprint: () => showOwnFingerprint(server),
            reset: () => (resetServer = server),
            removeCopies: () => void startRemoveCopies(server),
        };
    }

    onMount(() => {
        // Arriving from a managed sign-out that started on the account site or the Sync portal:
        // no Client page ran on the way here, so the keys lock now, as a sign-out started here
        // locks them. The active account still names whose keys they are.
        if (page.url.searchParams.get("managed") === "signed-out") {
            const managed = listSyncConnections().find(
                (held) => held.kind === "managed",
            );
            if (managed) lockVault(managed.origin);
        }
        announceArrival();
        void importMarkers()
            .findInterrupted()
            .then((found) => (interruptedImports = found));
        // A connection made or dropped in another tab reaches this one through the storage event;
        // this page's own changes either refresh it themselves or navigate away.
        const onStorage = (event: StorageEvent) => {
            if (
                event.key !== SYNC_CONNECTIONS_STORAGE_KEY &&
                event.key !== null
            )
                return;
            void refreshAfterOutsideChange();
        };
        window.addEventListener("storage", onStorage);
        // This tab's own header menu can forget or add a connection too.
        const onConnectionsChanged = () => {
            // This page's own writes refresh it themselves.
            if (changingConnections) return;
            const held = listSyncConnections();
            const same =
                held.length === servers.length &&
                held.every((connection, index) =>
                    sameCredential(connection, servers[index].connection),
                );
            if (!same) void refreshAfterOutsideChange();
        };
        window.addEventListener(
            SYNC_CONNECTIONS_CHANGED_EVENT,
            onConnectionsChanged,
        );
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
        // A server that never answers must not hold a first visit on the skeleton for good: after
        // a few seconds the page decides without it, and its group says it is still loading.
        const patience = setTimeout(() => (initialRefreshDone = true), 6_000);
        void refresh()
            .finally(() => {
                clearTimeout(patience);
                initialRefreshDone = true;
            })
            .then(sweepIndexPools)
            .catch((error) =>
                console.warn("[graphs] the first refresh failed", error),
            );
        return () => {
            clearTimeout(patience);
            for (const server of servers) server.dispose();
            stopRecoveries();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener(
                SYNC_CONNECTIONS_CHANGED_EVENT,
                onConnectionsChanged,
            );
        };
    });
</script>

<svelte:head><title>Knowledge graphs · EtherPK</title></svelte:head>
<svelte:document onvisibilitychange={onVisible} />

{#snippet loadingSkeleton(label: string)}
    <!-- Mirrors the list it stands in for: a heading line, then a card of rows. The server renders
         it too, since it has no stored connections to read, so nothing that is not so ever shows
         first (a "Sign in" panel flashed for signed-in people, 2026-09-29). -->
    <div data-testid="graphs-loading" class="space-y-3" role="status">
        <span class="sr-only">{label}</span>
        <div
            class="h-7 w-40 rounded-md bg-gray-200 motion-safe:animate-pulse dark:bg-white/10"
            aria-hidden="true"
        ></div>
        <div
            class="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/5"
            aria-hidden="true"
        >
            {#each [0, 1, 2] as row (row)}
                <div class="flex items-center gap-3 px-4 py-3">
                    <div class="flex-1 space-y-2">
                        <div
                            class="h-4 w-48 max-w-full rounded bg-gray-200 motion-safe:animate-pulse dark:bg-white/10"
                        ></div>
                        <div
                            class="h-4 w-28 rounded bg-gray-100 motion-safe:animate-pulse dark:bg-white/5"
                        ></div>
                    </div>
                    <div
                        class="h-8 w-20 rounded-lg bg-gray-200 motion-safe:animate-pulse dark:bg-white/10"
                    ></div>
                </div>
            {/each}
        </div>
    </div>
{/snippet}

{#snippet serverIcon(server: SyncServerView, size: string)}
    <svg
        class="{size} shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        aria-hidden="true"
    >
        <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d={server.connection.kind === "managed"
                ? MANAGED_SERVER_ICON
                : CUSTOM_SERVER_ICON}
        />
    </svg>
{/snippet}

<div class="mx-auto max-w-5xl px-4 py-8 space-y-6">
    <header class="flex min-h-9 flex-wrap items-center justify-between gap-3">
        <h1 class="text-2xl font-semibold text-gray-950 dark:text-white">
            Knowledge graphs
        </h1>
        <!-- Offered once the page knows what this browser holds: before then, which actions apply
             (the demo, a folder) is not known. All four share one style: none of them is the right
             first step for everyone. The ones that create a graph of your own come first, the demo
             last. -->
        {#if listReady}
            <div data-testid="graphs-actions" class="flex flex-wrap gap-2">
                {#if supported}
                    <button
                        data-testid="graphs-open-folder"
                        onclick={openFolder}
                        class={SECONDARY_BUTTON}
                        >Open folder (Local Graph)</button
                    >
                {/if}
                <button
                    data-testid="graphs-create-server"
                    onclick={startCreateServerGraph}
                    disabled={createDisabled}
                    aria-disabled={createDisabled}
                    aria-describedby={createDisabled
                        ? orderedServers
                              .map((_, index) => `graphs-plan-notice-${index}`)
                              .join(" ")
                        : undefined}
                    aria-busy={createPending}
                    title={createDisabledReason ?? undefined}
                    class="aria-busy:cursor-progress disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-500 dark:disabled:border-white/10 dark:disabled:bg-white/5 dark:disabled:text-gray-400 {SECONDARY_BUTTON}"
                    >New synced graph</button
                >
                <button
                    data-testid="graphs-import"
                    onclick={() => (importDialog = true)}
                    class={SECONDARY_BUTTON}>Import</button
                >
                {#if demoAvailable}
                    <a
                        data-testid="graphs-try-demo"
                        href="/demo"
                        class={SECONDARY_BUTTON}>Try the demo</a
                    >
                {/if}
            </div>
        {/if}
    </header>

    <!-- Arrow keys move between the tabs (onTabKeydown); only the selected one is in the tab order. -->
    <div
        role="tablist"
        tabindex="-1"
        aria-label="Graphs and sync settings"
        onkeydown={onTabKeydown}
        class="flex gap-1 border-b border-gray-200 dark:border-white/10"
    >
        <button
            type="button"
            role="tab"
            id="graphs-tab-graphs"
            data-testid="graphs-tab"
            aria-selected={activeTab === "graphs"}
            aria-controls="graphs-panel"
            tabindex={activeTab === "graphs" ? 0 : -1}
            onclick={() => showTab("graphs")}
            class="-mb-px border-b-2 px-3 py-2 text-sm font-medium pointer-coarse:min-h-11 {activeTab ===
            'graphs'
                ? 'border-gray-900 text-gray-950 dark:border-white dark:text-white'
                : 'border-transparent text-gray-600 hover:text-gray-950 dark:text-gray-400 dark:hover:text-white'}"
            >Graphs</button
        >
        <button
            type="button"
            role="tab"
            id="graphs-tab-sync"
            data-testid="graphs-sync-settings-toggle"
            aria-selected={activeTab === "sync"}
            aria-controls="graphs-sync-settings"
            tabindex={activeTab === "sync" ? 0 : -1}
            onclick={() => showTab("sync")}
            class="-mb-px border-b-2 px-3 py-2 text-sm font-medium pointer-coarse:min-h-11 {activeTab ===
            'sync'
                ? 'border-gray-900 text-gray-950 dark:border-white dark:text-white'
                : 'border-transparent text-gray-600 hover:text-gray-950 dark:text-gray-400 dark:hover:text-white'}"
            >Sync</button
        >
    </div>

    <!--
        One slot carries every page-level outcome, announced, just under the tabs, so it is in
        view whichever tab caused it. Per-row outcomes report on their row.
    -->
    {#if status}
        <p
            data-testid="graphs-status"
            role={statusTone === "error" ? "alert" : "status"}
            class="text-sm {statusTone === 'error'
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-600 dark:text-gray-400'}"
        >
            {status}
        </p>
    {/if}

    <!--
        A browser that cannot open a folder, said next to the buttons. A first visit gets the
        first-run card instead, which names only the actions this browser has and says the same;
        this notice is for a browser that already has graphs, with the way to a synced graph when
        none is set up.
    -->
    {#if !supported && firstRunKnown && !firstRun}
        <div
            class="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
            data-testid="graphs-unsupported"
        >
            <p>
                This browser cannot open a folder on this computer. Folders need
                a Chromium-based desktop browser: Chrome, Edge or Brave. Synced
                graphs work in any browser.
            </p>
            {#if servers.length === 0}
                <button
                    type="button"
                    onclick={() =>
                        signsInToManagedSync()
                            ? connectManagedSync()
                            : void openSyncPanel("add")}
                    class="mt-2 rounded-lg border border-amber-400 px-3 py-1.5 text-sm font-medium hover:bg-amber-100 dark:border-amber-500/50 dark:hover:bg-amber-900/40"
                    >{signsInToManagedSync()
                        ? "Sign in"
                        : "Connect to a Sync Server"}</button
                >
            {/if}
        </div>
    {/if}

    {#if managedSyncAvailable}
        <!-- The form attribute on the Sign out button associates it with this external form, which
             keeps it out of the Sync tab's add-server form. -->
        <form
            id="managed-global-logout"
            method="POST"
            action="/auth/logout/managed"
        ></form>
    {/if}

    {#if activeTab === "graphs"}
        <div
            role="tabpanel"
            id="graphs-panel"
            aria-labelledby="graphs-tab-graphs"
            class="space-y-8"
        >
            {#if interruptedImports.length > 0}
                <section
                    data-testid="interrupted-imports"
                    aria-labelledby="interrupted-imports-heading"
                    class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-400/20 dark:bg-amber-400/10"
                >
                    <h2
                        id="interrupted-imports-heading"
                        class="text-sm font-semibold text-amber-950 dark:text-amber-100"
                    >
                        Imports that did not finish
                    </h2>
                    <ul class="mt-2 space-y-3">
                        {#each interruptedImports as item (item.id)}
                            <li
                                data-testid="interrupted-import"
                                class="text-sm leading-5 text-amber-900 dark:text-amber-100"
                            >
                                <p>
                                    The import of "{item.name}" stopped partway,
                                    when its tab was closed or reloaded.
                                    {#if item.destination === "server" && item.graphId}
                                        Its partly imported graph is on {item.serverOrigin
                                            ? serverHost(item.serverOrigin)
                                            : "the Sync Server"}, listed with
                                        that server's synced graphs as Import
                                        interrupted.
                                    {:else if item.destination === "server"}
                                        It had not uploaded anything.
                                    {:else}
                                        The folder "{item.folderName ??
                                            "you chose"}" holds part of it:
                                        empty it before importing into it again,
                                        or choose another folder.
                                    {/if}
                                </p>
                                <div
                                    class="mt-2 flex flex-wrap items-center gap-2"
                                >
                                    {#if item.destination === "server" && item.graphId && confirmingPartialDelete === item.id}
                                        <span
                                            >Delete it from {item.serverOrigin
                                                ? serverHost(item.serverOrigin)
                                                : "the Sync Server"}? This
                                            cannot be undone.</span
                                        >
                                        <button
                                            type="button"
                                            data-testid="interrupted-import-delete-confirm"
                                            disabled={deletingPartial ===
                                                item.id}
                                            onclick={() =>
                                                void deletePartialImport(item)}
                                            class="rounded-lg border border-red-300 px-3 py-1.5 font-medium text-red-700 hover:bg-red-50 disabled:cursor-progress dark:border-red-500/40 dark:text-red-300 dark:hover:bg-red-950/30"
                                            >{deletingPartial === item.id
                                                ? "Deleting…"
                                                : "Delete permanently"}</button
                                        >
                                        <button
                                            type="button"
                                            onclick={() =>
                                                (confirmingPartialDelete =
                                                    null)}
                                            class="rounded-lg border border-amber-300 px-3 py-1.5 hover:bg-amber-100 dark:border-amber-400/30 dark:hover:bg-amber-400/10"
                                            >Cancel</button
                                        >
                                    {:else if item.destination === "server" && item.graphId}
                                        <button
                                            type="button"
                                            data-testid="interrupted-import-delete"
                                            onclick={() =>
                                                (confirmingPartialDelete =
                                                    item.id)}
                                            class="rounded-lg border border-amber-300 px-3 py-1.5 font-medium hover:bg-amber-100 dark:border-amber-400/30 dark:hover:bg-amber-400/10"
                                            >Delete the partial graph</button
                                        >
                                        <button
                                            type="button"
                                            data-testid="interrupted-import-keep"
                                            onclick={() =>
                                                forgetInterruptedImport(item)}
                                            class="rounded-lg border border-amber-300 px-3 py-1.5 hover:bg-amber-100 dark:border-amber-400/30 dark:hover:bg-amber-400/10"
                                            >Keep it</button
                                        >
                                    {:else}
                                        <button
                                            type="button"
                                            data-testid="interrupted-import-dismiss"
                                            onclick={() =>
                                                forgetInterruptedImport(item)}
                                            class="rounded-lg border border-amber-300 px-3 py-1.5 hover:bg-amber-100 dark:border-amber-400/30 dark:hover:bg-amber-400/10"
                                            >Dismiss</button
                                        >
                                    {/if}
                                </div>
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
                            <p
                                class="mt-2 text-sm text-amber-800 dark:text-amber-200"
                            >
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

            {#snippet pickerRow(graph: GraphRecord)}
                <GraphPickerRow
                    {graph}
                    message={rowMessage[graph.id] ?? null}
                    onopen={() => void openGraph(graph)}
                    onrename={() => renameGraph(graph)}
                    onsettings={() => void openLocalSettings(graph)}
                    onforget={() => void askForget(graph)}
                    onreset={() => void goto("/demo?reset=1")}
                />
            {/snippet}

            {#if !firstRunKnown}
                {@render loadingSkeleton("Loading your graphs…")}
            {:else}
                {#if firstRun}
                    <!-- A browser with nothing of its own yet. The header carries every way to a
                         graph, so the card names those actions rather than repeating them. -->
                    <div
                        data-testid="graphs-first-run"
                        class="rounded-xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-5 space-y-3"
                    >
                        <p
                            data-testid="first-run-summary"
                            class="text-sm text-gray-700 dark:text-gray-300"
                        >
                            You don't have any graphs yet. Choose
                            {#if supported}<span class="font-medium text-gray-950 dark:text-white"
                                    >Open folder</span
                                >,{/if}
                            <span class="font-medium text-gray-950 dark:text-white"
                                >New synced graph</span
                            >
                            or <span class="font-medium text-gray-950 dark:text-white">Import</span> to
                            create a graph.
                        </p>
                        {#if !supported}
                            <p class="text-sm text-gray-500 dark:text-gray-400">
                                Folders need a Chromium-based desktop browser:
                                Chrome, Edge or Brave.
                            </p>
                        {/if}
                        <p
                            data-testid="first-run-import"
                            class="text-sm text-gray-500 dark:text-gray-400"
                        >
                            You can import graphs from Logseq, Obsidian, EtherPK
                            and AS Notes.
                            <a
                                href="{PUBLIC_DOCS_URL}/importing-a-knowledge-base"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="font-medium text-gray-700 underline dark:text-gray-200"
                                >Importing an existing knowledge base</a
                            >
                        </p>
                    </div>
                {/if}

                <!-- Folders on this computer, and the demo: they belong to no Sync Server, and the
                     demo shows beside the first-run card too. -->
                {#if localGraphs.length > 0 || demoGraph || registryUnreadable}
                    <section
                        data-testid="graphs-on-device"
                        aria-labelledby="local-graphs-heading"
                        class="space-y-3"
                    >
                        <div>
                            <h2
                                id="local-graphs-heading"
                                class="flex items-center gap-2 text-lg font-semibold text-gray-950 dark:text-white"
                            >
                                Local graphs
                                <svg
                                    class="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="1.5"
                                    aria-hidden="true"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d={LOCAL_GRAPHS_ICON}
                                    />
                                </svg>
                            </h2>
                            <p
                                class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                            >
                                Folders on this computer, in plain Markdown
                                files, and the demo.
                            </p>
                        </div>
                        {#if registryUnreadable}
                            <!-- "None" and "could not be read" are different sentences, and only one of
                                 them should let someone believe their graphs are gone. -->
                            <p
                                class="rounded-xl border border-red-200 px-4 py-6 text-center text-sm text-red-600 dark:border-red-500/30 dark:text-red-400"
                                data-testid="graphs-unreadable"
                            >
                                Your graphs could not be read from this
                                browser's storage. Nothing has been deleted.
                            </p>
                        {:else if localGraphs.length > 0}
                            <ul
                                data-testid="graphs-list"
                                class="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-white/5"
                            >
                                {#each localGraphs as graph (graph.id)}
                                    {@render pickerRow(graph)}
                                {/each}
                            </ul>
                        {/if}
                        {#if demoGraph}
                            <ul
                                data-testid="graphs-demo-list"
                                class="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-white/10 dark:bg-white/5"
                            >
                                {@render pickerRow(demoGraph)}
                            </ul>
                        {/if}
                    </section>
                {/if}

                <!-- A group per Sync Server (ADR 0111), so which server a graph lives on never needs
                     asking. On a first visit a server with nothing to say leaves it to the card. -->
                {#each orderedServers as server, index (server.origin)}
                    {@const records = recordsFor(server)}
                    {#if serverGroupVisible( { firstRun, rows: server.graphs.length + records.length, invites: server.invites.length, failed: server.error !== null, authState: server.authState, kind: server.connection.kind, planLine: server.showsPlanLine }, )}
                        <SyncServerGroup
                            {server}
                            planNoticeId={`graphs-plan-notice-${index}`}
                            {records}
                            {interruptedGraphIds}
                            {rowMessage}
                            {discardChecking}
                            {withdrawingInvite}
                            {checkingInvite}
                            {decliningInvite}
                            {corporateBillingUrl}
                            showPending={showPlanPending.current}
                            actions={groupActions(server)}
                        />
                    {/if}
                {/each}

                {#if !firstRun && servers.length === 0}
                    <!-- A returning browser with no Sync Server: the way to one, where its graphs would be. -->
                    <section
                        data-testid="synced-graphs"
                        aria-labelledby="synced-graphs-heading"
                        class="space-y-3"
                    >
                        <div>
                            <h2
                                id="synced-graphs-heading"
                                class="flex items-center gap-2 text-lg font-semibold text-gray-950 dark:text-white"
                            >
                                Synced graphs
                                <svg
                                    class="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="1.5"
                                    aria-hidden="true"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d={MANAGED_SERVER_ICON}
                                    />
                                </svg>
                            </h2>
                            <p
                                class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                            >
                                End-to-end encrypted: the server only ever sees
                                ciphertext.
                            </p>
                        </div>
                        <div
                            data-testid="synced-graphs-connect"
                            class="rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/5"
                        >
                            <p class="text-sm text-gray-700 dark:text-gray-300">
                                {signsInToManagedSync()
                                    ? "Sign in with your EtherPK account to see and create synced graphs. Graphs of your own need Sync+. Graphs others share with you work on any plan."
                                    : "Connect this device to a Sync Server to see and create synced graphs."}
                            </p>
                            <button
                                type="button"
                                onclick={() =>
                                    signsInToManagedSync()
                                        ? connectManagedSync()
                                        : void openSyncPanel("add")}
                                class="mt-3 {SECONDARY_BUTTON}"
                                >{signsInToManagedSync()
                                    ? "Sign in"
                                    : "Connect to a Sync Server"}</button
                            >
                        </div>
                    </section>
                {:else if !firstRun}
                    <p
                        class="text-sm text-gray-500 dark:text-gray-400"
                        data-testid="synced-graphs-import-hint"
                    >
                        Synced graphs are end-to-end encrypted: their servers
                        only ever see ciphertext. To move a local graph to
                        synced storage, create a new graph with
                        <button
                            type="button"
                            class="font-medium text-gray-700 underline dark:text-gray-200"
                            onclick={() => (importDialog = true)}>Import</button
                        >.
                    </p>
                {/if}
            {/if}
        </div>
    {:else}
        <div
            role="tabpanel"
            id="graphs-sync-settings"
            data-testid="graphs-sync-settings"
            aria-labelledby="graphs-tab-sync"
            class="space-y-6"
        >
            {#if !listReady}
                {@render loadingSkeleton("Loading your Sync Servers…")}
            {:else}
                <section
                    data-testid="sync-servers"
                    aria-labelledby="sync-servers-heading"
                    class="space-y-4"
                >
                    <div>
                        <h2 id="sync-servers-heading" class="sr-only">
                            Sync Servers
                        </h2>
                        <p class="text-sm text-gray-500 dark:text-gray-400">
                            Each Sync Server keeps its own account, encryption
                            keys and Recovery Code. A synced graph always syncs
                            through the server it was created on.
                        </p>
                    </div>

                    {#if servers.length > 0}
                        <!-- A sub-tab per server, so a key reset or a removal plainly acts on one
                             server; arrow keys move between them (onSyncTabKeydown). -->
                        <div
                            id="sync-server-tabs"
                            role="tablist"
                            tabindex="-1"
                            aria-label="Sync Servers"
                            onkeydown={onSyncTabKeydown}
                            class="flex flex-wrap gap-1"
                        >
                            {#each orderedServers as server, index (server.origin)}
                                {@const selected = syncPanel === server}
                                <button
                                    type="button"
                                    role="tab"
                                    id="sync-server-tab-{index}"
                                    data-testid="sync-server-tab"
                                    data-origin={server.origin}
                                    aria-selected={selected}
                                    aria-controls="sync-server-panel"
                                    tabindex={selected ? 0 : -1}
                                    onclick={() => showSyncPanel(server)}
                                    class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium pointer-coarse:min-h-11 {selected
                                        ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white'}"
                                >
                                    {@render serverIcon(server, "h-4 w-4")}
                                    {server.host}
                                    {#if server.authState === "signed-out" || server.authState === "unavailable"}
                                        <!-- A cue that this server needs attention, named for screen readers. -->
                                        <span
                                            class="h-2 w-2 rounded-full bg-amber-500"
                                            aria-hidden="true"
                                        ></span>
                                        <span class="sr-only"
                                            >({server.authState === "signed-out"
                                                ? "signed out"
                                                : "not answering"})</span
                                        >
                                    {/if}
                                </button>
                            {/each}
                            <button
                                type="button"
                                role="tab"
                                id="sync-server-tab-add"
                                data-testid="sync-add-server"
                                aria-selected={syncPanel === "add"}
                                aria-controls="sync-server-panel"
                                tabindex={syncPanel === "add" ? 0 : -1}
                                onclick={() => void openSyncPanel("add")}
                                class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium pointer-coarse:min-h-11 {syncPanel ===
                                'add'
                                    ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-950 dark:text-gray-300 dark:hover:bg-white/10 dark:hover:text-white'}"
                            >
                                <svg
                                    class="h-4 w-4"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    stroke-width="1.5"
                                    aria-hidden="true"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M12 4.5v15m7.5-7.5h-15"
                                    />
                                </svg>
                                Add a Sync Server
                            </button>
                        </div>
                    {/if}

                    <div
                        id="sync-server-panel"
                        role={servers.length > 0 ? "tabpanel" : undefined}
                        aria-labelledby={servers.length === 0
                            ? undefined
                            : syncPanel === "add"
                              ? "sync-server-tab-add"
                              : `sync-server-tab-${orderedServers.indexOf(syncPanel)}`}
                    >
                        {#if syncPanel === "add"}
                            <form
                                id="sync-add-server-form"
                                data-testid="sync-add-server-form"
                                onsubmit={(e) => {
                                    e.preventDefault();
                                    void saveSyncConfig();
                                }}
                                class="space-y-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-white/5 p-5"
                            >
                                <h3
                                    class="text-base font-semibold text-gray-950 dark:text-white"
                                >
                                    Add a Sync Server
                                </h3>
                                {#if addOffersManaged}
                                    <div
                                        class="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1 dark:bg-white/10"
                                        role="tablist"
                                        aria-label="Kind of Sync Server"
                                    >
                                        <button
                                            type="button"
                                            role="tab"
                                            aria-selected={connectionMode ===
                                                "managed"}
                                            onclick={() =>
                                                (connectionMode = "managed")}
                                            class="rounded-md px-3 py-2 text-sm font-medium {connectionMode ===
                                            'managed'
                                                ? 'bg-white text-gray-950 shadow-sm dark:bg-(--gk-surface-2) dark:text-white'
                                                : 'text-gray-600 dark:text-gray-300'}"
                                            >Managed Sync</button
                                        >
                                        <button
                                            type="button"
                                            role="tab"
                                            aria-selected={connectionMode ===
                                                "custom"}
                                            onclick={() =>
                                                (connectionMode = "custom")}
                                            class="rounded-md px-3 py-2 text-sm font-medium {connectionMode ===
                                            'custom'
                                                ? 'bg-white text-gray-950 shadow-sm dark:bg-(--gk-surface-2) dark:text-white'
                                                : 'text-gray-600 dark:text-gray-300'}"
                                            >Custom server</button
                                        >
                                    </div>
                                {/if}

                                {#if addOffersManaged && connectionMode === "managed"}
                                    <div
                                        class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-white/10 dark:bg-white/5"
                                    >
                                        <p
                                            class="text-sm font-medium text-gray-950 dark:text-white"
                                        >
                                            EtherPK Managed Sync
                                        </p>
                                        <p
                                            class="mt-1 text-sm leading-5 text-gray-600 dark:text-gray-300"
                                        >
                                            Sign in with your EtherPK account to
                                            connect this device. There is no
                                            server address or access token to
                                            copy, and your graph content stays
                                            end-to-end encrypted. Graphs of your
                                            own need Sync+. Graphs others share
                                            with you work on any plan.
                                        </p>
                                        <div class="mt-3 flex flex-wrap gap-2">
                                            <button
                                                type="button"
                                                data-testid="managed-sync-connect"
                                                onclick={connectManagedSync}
                                                class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                                                >Continue to secure sign in</button
                                            >
                                        </div>
                                    </div>
                                {:else}
                                    <div>
                                        <label
                                            for="sync-url"
                                            class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                                            >Sync server URL</label
                                        >
                                        <input
                                            id="sync-url"
                                            data-testid="sync-url"
                                            bind:value={serverBaseUrl}
                                            oninput={() => {
                                                // Once a field has errored it re-checks as it is corrected.
                                                if (syncUrlError)
                                                    syncUrlError =
                                                        syncFieldErrors(
                                                            serverBaseUrl.trim(),
                                                            token.trim(),
                                                        ).url;
                                            }}
                                            placeholder="https://sync.example.com"
                                            aria-invalid={syncUrlError
                                                ? "true"
                                                : undefined}
                                            aria-describedby={syncUrlError
                                                ? "sync-url-help sync-url-error"
                                                : "sync-url-help"}
                                            class="block w-full rounded-lg border {syncUrlError
                                                ? 'border-red-500'
                                                : 'border-gray-300 dark:border-gray-700'} bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                                        />
                                        <p
                                            id="sync-url-help"
                                            class="mt-1 text-sm text-gray-500 dark:text-gray-400"
                                        >
                                            Include the scheme. Use http:// for
                                            a local server, https:// for a
                                            hosted one. A server this device
                                            already holds gets the new token.
                                        </p>
                                        {#if syncUrlError}
                                            <p
                                                id="sync-url-error"
                                                data-testid="sync-url-error"
                                                class="mt-1 text-sm text-red-600 dark:text-red-400"
                                            >
                                                {syncUrlError}
                                            </p>
                                        {/if}
                                    </div>
                                    <div>
                                        <label
                                            for="sync-token"
                                            class="mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-300"
                                            >Personal Access Token</label
                                        >
                                        <input
                                            id="sync-token"
                                            data-testid="sync-token"
                                            type="password"
                                            bind:value={token}
                                            oninput={() => {
                                                if (syncTokenError)
                                                    syncTokenError =
                                                        syncFieldErrors(
                                                            serverBaseUrl.trim(),
                                                            token.trim(),
                                                        ).token;
                                            }}
                                            placeholder="epk_pat_…"
                                            aria-invalid={syncTokenError
                                                ? "true"
                                                : undefined}
                                            aria-describedby={syncTokenError
                                                ? "sync-token-error sync-token-help"
                                                : "sync-token-help"}
                                            class="block w-full rounded-lg border {syncTokenError
                                                ? 'border-red-500'
                                                : 'border-gray-300 dark:border-gray-700'} bg-white dark:bg-white/10 px-3 py-2 text-sm font-mono text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                                        />
                                        {#if syncTokenError}
                                            <p
                                                id="sync-token-error"
                                                data-testid="sync-token-error"
                                                class="mt-1 text-sm text-red-600 dark:text-red-400"
                                            >
                                                {syncTokenError.message}
                                                {#if syncTokenError.tokensUrl}
                                                    <a
                                                        href={syncTokenError.tokensUrl}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        class="font-medium underline"
                                                        >Access tokens</a
                                                    >
                                                {/if}
                                            </p>
                                        {/if}
                                    </div>
                                    <p
                                        id="sync-token-help"
                                        class="text-sm text-gray-500 dark:text-gray-400"
                                        data-testid="sync-token-help"
                                    >
                                        {#if customServerOrigin}
                                            Make a token on the server's <a
                                                href="{customServerOrigin}/account/tokens"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="font-medium underline"
                                                >Access tokens page</a
                                            >, or
                                            <a
                                                href="{customServerOrigin}/register"
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                class="font-medium underline"
                                                >create an account</a
                                            > there first.
                                        {:else}
                                            Make a token on the Sync Server's
                                            Access tokens page.
                                        {/if}
                                        A token lets this device sync, but can never
                                        decrypt your notes. The server gives you
                                        its own Recovery Code: a code you saved for
                                        another server does not cover it.
                                    </p>
                                    <div class="flex justify-end gap-2">
                                        {#if primaryServer}
                                            <button
                                                type="button"
                                                onclick={() => {
                                                    syncUrlError = null;
                                                    syncTokenError = null;
                                                    showSyncPanel(
                                                        primaryServer,
                                                    );
                                                }}
                                                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-950 dark:text-gray-400 dark:hover:text-white"
                                                >Cancel</button
                                            >
                                        {/if}
                                        <button
                                            type="submit"
                                            data-testid="sync-save"
                                            aria-busy={syncSaving}
                                            class="aria-busy:cursor-progress rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                                            >{syncSaving
                                                ? "Checking the connection…"
                                                : "Save custom server"}</button
                                        >
                                    </div>
                                {/if}
                            </form>
                        {:else}
                            {@const server = syncPanel}
                            <SyncServerSettings
                                {server}
                                heldCount={copyCounts.perServer[
                                    server.origin
                                ] ?? 0}
                                {corporateBillingUrl}
                                {corporateAccountUrl}
                                showPending={showPlanPending.current}
                                confirmingForget={confirmingForget ===
                                    server.origin}
                                forgetting={forgettingServer === server.origin}
                                removeChecking={removeCopiesChecking ===
                                    server.origin}
                                actions={settingsActions(server)}
                            />
                        {/if}
                    </div>
                </section>

                <section
                    data-testid="device-storage"
                    aria-labelledby="device-storage-heading"
                    class="space-y-2 rounded-xl border border-gray-200 bg-white p-4 dark:border-white/10 dark:bg-white/5"
                >
                    <h2
                        id="device-storage-heading"
                        class="text-base font-semibold text-gray-950 dark:text-white"
                    >
                        This browser
                    </h2>
                    {#if deviceStorage?.persisted === true}
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-persisted"
                        >
                            This browser has agreed to keep EtherPK's data on
                            this device rather than clear it to free up space.
                        </p>
                    {:else if deviceStorage?.persisted === false}
                        <!-- The honest version of "your data is safe here": on a phone it is not, unless the
                             browser has been given a reason to keep it. -->
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-best-effort"
                        >
                            This browser may clear EtherPK's data on this device
                            to free up space. Information about graphs and
                            passkeys in this browser is also kept in local
                            storage (which survives browser data eviction),
                            though graphs will re-download from the sync server.
                            {#if !installedApp}
                                Installing EtherPK, or bookmarking it, can
                                encourage the browser to keep the data.
                            {/if}
                        </p>
                    {:else}
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-unknown"
                        >
                            This browser does not say whether it will keep
                            EtherPK's data when space runs low. Information
                            about graphs and passkeys in this browser is also
                            kept in local storage (which survives browser data
                            eviction).
                        </p>
                    {/if}
                    {#if deviceStorage?.usage !== null && deviceStorage?.usage !== undefined}
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="device-storage-usage"
                        >
                            EtherPK is using {formatBytes(deviceStorage.usage)} here{deviceStorage.quota !==
                            null
                                ? ` of the ${formatBytes(deviceStorage.quota)} this browser allows`
                                : ""}.
                        </p>
                    {/if}
                    {#if servers.length > 0}
                        <p class="text-sm text-gray-500 dark:text-gray-400">
                            To remove synced graphs from this browser, use
                            Copies in this browser on each server's tab above.
                        </p>
                    {/if}
                    {#if copyCounts.unheld > 0}
                        <!-- Copies a forgotten server left: no tab offers them any more. -->
                        <p
                            class="text-sm text-gray-500 dark:text-gray-400"
                            data-testid="unheld-copies"
                        >
                            This browser also holds copies of {copyCounts.unheld ===
                            1
                                ? "1 synced graph"
                                : `${copyCounts.unheld} synced graphs`}
                            from Sync Servers this device is no longer connected
                            to. They stay hidden until you add the server again,
                            but anyone who uses this browser can read them.
                        </p>
                        <button
                            type="button"
                            data-testid="remove-unheld-copies"
                            onclick={() => void startRemoveCopies(null)}
                            disabled={removeCopiesChecking === "unheld"}
                            aria-busy={removeCopiesChecking === "unheld"}
                            class="{SECONDARY_BUTTON} aria-busy:cursor-progress"
                            >{removeCopiesChecking === "unheld"
                                ? "Checking for unsent changes…"
                                : "Remove them from this browser"}</button
                        >
                    {/if}
                </section>
            {/if}
        </div>
    {/if}
</div>

{#if importDialog}
    <!-- Each server is offered with why it cannot take the graph, when it cannot; a background
         import finishes on the server it started on. -->
    <ImportGraphDialog
        {registry}
        syncTargets={importTargets()}
        defaultSyncOrigin={defaultServerForNewGraph(
            orderedServers
                .filter(
                    (server) =>
                        server.authState === "authenticated" &&
                        server.createBlockedReason === null,
                )
                .map((server) => server.origin),
            readLastNewGraphServer(),
            managedServer?.origin ?? null,
        )}
        syncUnavailableReason={importUnavailableReason}
        getWrapKey={unlockVaultInteractively}
        ensureVaultReady={importVaultReady}
        opfsDestination={dev && page.url.searchParams.get("fs") === "opfs"}
        onclose={() => (importDialog = false)}
        onimported={onImported}
        onsettled={onImportSettled}
    />
{/if}

{#if inviteDialog}
    <InviteDialog
        api={inviteDialog.server.api}
        graphId={inviteDialog.graphId}
        graphName={inviteDialog.graphName}
        keyring={inviteDialog.keyring}
        ownEmail={inviteDialog.server.account?.principal.email ?? null}
        inviteeNeeds={inviteeNeeds(inviteDialog.server)}
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

{#if resetServer}
    <ResetDialog
        serverOrigin={resetServer.origin}
        onclose={() => (resetServer = null)}
        oncomplete={onResetComplete}
    />
{/if}

{#if transferDialog}
    <TransferOwnershipDialog
        api={transferDialog.server.api}
        graphId={transferDialog.graph.id}
        graphName={transferDialog.graph.name}
        candidates={transferDialog.candidates}
        onclose={(result) => {
            const transferred = transferDialog;
            transferDialog = null;
            if (result && transferred) {
                setRowStatus(
                    transferred.graph.id,
                    `Ownership transferred to ${result.email}. You stay on as a player.`,
                );
                void refreshSynced(transferred.server);
            }
        }}
    />
{/if}

{#if deleteConfirm}
    {@const target = deleteConfirm.graph}
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
            {@render unsentWarning("Deleting the graph", target.name, false)}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Permanently delete <span
                    class="font-medium text-gray-900 dark:text-gray-200"
                    >{target.name}</span
                >? This deletes the graph from {deleteConfirm?.server.host ??
                    "the sync server"}
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
            {#if target.onDevice}
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
                Computers running the Headless Client for this graph drop their
                copy the next time it starts.
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
            {#if discardUnsent?.graphId === target.id && discardUnsent.unsent.length > 0}
                <button
                    type="button"
                    data-testid="discard-unsent-download"
                    onclick={() => downloadDiscardUnsent(target.name)}
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
    {@const chosenServer = serverFor(createOrigin)}
    <Modal
        open={true}
        title="New synced graph"
        busy={createBusy}
        busyReason={createStage}
        onclose={() => (createDialog = false)}
        onsubmit={() => void createServerGraph()}
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
            {#if servers.length > 1}
                <!-- More than one server: the graph lives on the one chosen here, for good. A
                     server that cannot take it now stays listed, saying why. -->
                <fieldset data-testid="create-graph-server">
                    <legend
                        class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >Sync Server</legend
                    >
                    <div class="space-y-2">
                        {#each orderedServers as server, index (server.origin)}
                            {@const reason = server.createBlockedReason}
                            <label
                                class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200"
                            >
                                <input
                                    type="radio"
                                    name="create-graph-server"
                                    value={server.origin}
                                    bind:group={createOrigin}
                                    disabled={createBusy || reason !== null}
                                    data-testid="create-graph-server-option"
                                    data-origin={server.origin}
                                    aria-describedby={reason
                                        ? `create-server-reason-${index}`
                                        : undefined}
                                    class="mt-0.5"
                                />
                                <!-- An unavailable choice recedes by colour, never opacity; its reason
                                     keeps full contrast. -->
                                <span class="flex min-w-0 flex-col">
                                    <span
                                        class="inline-flex items-center gap-1.5 font-medium {reason
                                            ? 'text-gray-500 dark:text-gray-400'
                                            : ''}"
                                    >
                                        {@render serverIcon(server, "h-4 w-4")}
                                        {server.host}
                                    </span>
                                    {#if reason}
                                        <span
                                            id="create-server-reason-{index}"
                                            class="text-gray-600 dark:text-gray-300"
                                            >{reason}</span
                                        >
                                    {:else}
                                        <span
                                            class="text-gray-500 dark:text-gray-400"
                                        >
                                            {server.connection.kind ===
                                            "managed"
                                                ? "Managed Sync"
                                                : "Custom server"}{server.accountLabel
                                                ? `, as ${server.accountLabel}`
                                                : ""}
                                        </span>
                                    {/if}
                                </span>
                            </label>
                        {/each}
                    </div>
                    <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">
                        A synced graph stays on the server it is created on.
                    </p>
                </fieldset>
            {:else if chosenServer}
                <p
                    class="text-sm text-gray-500 dark:text-gray-400"
                    data-testid="create-graph-server-note"
                >
                    It is stored on {chosenServer.host}, end-to-end encrypted.
                </p>
            {/if}
            {#if createError}
                <p
                    role="alert"
                    data-testid="create-graph-error"
                    class="text-sm text-red-600 dark:text-red-400"
                >
                    {createError}
                </p>
            {/if}
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
                disabled={createBusy ||
                    createName.trim() === "" ||
                    !chosenServer}
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
        nameHelp="Changes the display name only - the folder on disk keeps its name."
        onsave={(result) => void saveLocalSettings(result)}
        onclose={() => (localSettings = null)}
    />
{/if}

{#if syncedSettings}
    <GraphSettingsDialog
        graphId={syncedSettings.record.id}
        name={syncedSettings.name}
        settings={syncedSettings.settings}
        storageInfo={servers
            .flatMap((server) => server.graphs)
            .find((g) => g.id === syncedSettings?.record.id)?.storage ?? null}
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
            : "Changes the display name only - the folder on disk retains its name."}
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
                Changes to {count === 1
                    ? "1 document"
                    : `${count.toLocaleString()} documents`} in this browser have
                not reached the sync server yet. {action} deletes them.
            </p>
            <p>
                {canSync
                    ? "To keep them, open the graph while online and wait until it shows Synced, or download them first."
                    : "To keep a copy, download them first: the graph and everything the server holds for it go too."}
            </p>
            {#if discardUnsent.grew}
                <p role="status" data-testid="discard-unsent-grew">
                    More changes arrived since this opened - the count is
                    current.
                </p>
            {/if}
            {#if discardUnsent.downloaded}
                <p role="status">
                    Downloaded as “{graphName} unsent changes.md”.
                </p>
            {/if}
        </div>
    {/if}
{/snippet}

{#if removeSynced}
    {@const withUnsent = removeSynced.held.filter(
        (entry) => entry.unsent.length > 0,
    )}
    {@const unsentDocuments = withUnsent.reduce(
        (sum, entry) => sum + entry.unsent.length,
        0,
    )}
    {@const where = removeSynced.server
        ? removeSynced.server.host
        : "Sync Servers this device no longer holds"}
    <Modal
        open={true}
        title={removeSynced.server
            ? `Remove synced graphs from ${removeSynced.server.host}`
            : "Remove synced graphs from other Sync Servers"}
        busy={removeSyncedBusy}
        busyReason="Removing…"
        onclose={() => (removeSynced = null)}
        onsubmit={executeRemoveSynced}
    >
        {#snippet body()}
            <div class="space-y-3">
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    This removes this browser's copy of {removeSynced!.held
                        .length === 1
                        ? "1 synced graph"
                        : `${removeSynced!.held.length} synced graphs`} from {where}:
                    the documents, search indexes and remembered tabs. It also
                    locks the keys held here for
                    {removeSynced!.server ? "that server" : "those servers"}.
                    The graphs stay on the sync server, and copies from other
                    Sync Servers are not touched.
                </p>
                {#if unsentDocuments > 0}
                    <p
                        role="alert"
                        class="text-sm text-red-600"
                        data-testid="remove-synced-unsent"
                    >
                        {removeSynced!.grew
                            ? "More changes were made while this was open. "
                            : ""}Changes to {unsentDocuments === 1
                            ? "1 document"
                            : `${unsentDocuments} documents`} in
                        {withUnsent
                            .map((entry) => `"${entry.graph.name}"`)
                            .join(", ")} never reached the sync server and are lost
                        if you remove {withUnsent.length === 1 ? "it" : "them"}.
                        {removeSynced!.downloaded
                            ? "You have downloaded them."
                            : "Download them first to keep them."}
                    </p>
                {/if}
            </div>
        {/snippet}
        {#snippet footer()}
            <button
                type="button"
                data-autofocus
                onclick={() => (removeSynced = null)}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
                >Cancel</button
            >
            {#if unsentDocuments > 0}
                <button
                    type="button"
                    data-testid="remove-synced-download"
                    onclick={downloadRemoveSyncedUnsent}
                    class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Download unsent changes</button
                >
            {/if}
            <button
                type="submit"
                disabled={removeSyncedBusy}
                data-testid="remove-synced-confirm"
                class="rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{unsentDocuments > 0
                    ? "Discard changes and remove"
                    : "Remove"}</button
            >
        {/snippet}
    </Modal>
{/if}

{#if forgetConfirm}
    {@const unsentCount =
        discardUnsent?.graphId === forgetConfirm.id
            ? discardUnsent.unsent.length
            : 0}
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
                        >? This deletes the graph's local copy and its search
                        index from this browser.
                        {unsentCount > 0
                            ? "The graph stays on the sync server without the changes above."
                            : "The graph remains on the sync server - add it back any time."}
                        Deleting the graph for all members (owner only) is done with
                        Delete on its row.
                    </p>
                </div>
            {:else}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Forget <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{forgetConfirm!.name}</span
                    >? Forgetting removes the graph from this list and its
                    search index from this browser. Delete the files on disk
                    manually if you require full deletion.
                </p>
            {/if}
            {#if forgetError}
                <p
                    role="alert"
                    data-testid="graphs-forget-error"
                    class="mt-3 text-sm text-red-600"
                >
                    {forgetError}
                </p>
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
    {@const leaving = leaveConfirm.graph}
    {@const unsentCount =
        discardUnsent?.graphId === leaving.id ? discardUnsent.unsent.length : 0}
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
                {@render unsentWarning("Leaving", leaving.name)}
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Leave <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{leaving.name}</span
                    >? You lose access until the owner invites you again. The
                    graph itself, and the other members, are untouched. The copy
                    in this browser, and its search index, are deleted.
                    Computers running the Headless Client for this graph drop
                    their copy the next time it starts.
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
                    onclick={() => downloadDiscardUnsent(leaving.name)}
                    class="rounded-lg border border-gray-300 dark:border-white/15 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Download unsent changes</button
                >
            {/if}
            <button
                type="submit"
                disabled={leaveBusy}
                data-testid="graphs-leave-confirm"
                class="min-w-32 rounded-lg bg-red-600 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >{leaveBusy
                    ? "Leaving…"
                    : unsentCount > 0
                      ? "Discard changes and leave"
                      : "Leave graph"}</button
            >
        {/snippet}
    </Modal>
{/if}

{#if staleCopy}
    {@const count = staleCopy.unsent.length}
    {@const documents =
        count === 1 ? "1 document" : `${count.toLocaleString()} documents`}
    <Modal
        open={true}
        title="Unsent changes in this browser"
        onclose={() => (staleCopy = null)}
        onsubmit={() => void confirmStaleCopyDiscard()}
    >
        {#snippet body()}
            <div data-testid="invite-unsent-changes" class="space-y-3">
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    This browser still holds a copy of <span
                        class="font-medium text-gray-900 dark:text-gray-200"
                        >{staleCopy!.graphName}</span
                    >
                    with changes to {documents} that the server never received. Accepting
                    the invite replaces the copy with the server's version, and those
                    changes are lost.
                </p>
                <p class="text-sm text-gray-600 dark:text-gray-400">
                    Download them first to keep them. Cancel keeps everything
                    and leaves the invite waiting.
                </p>
                {#if staleCopy!.grew}
                    <p
                        role="status"
                        data-testid="invite-unsent-grew"
                        class="text-sm text-gray-600 dark:text-gray-400"
                    >
                        More changes arrived since this opened - the count is
                        current.
                    </p>
                {/if}
                {#if staleCopy!.downloaded}
                    <p
                        role="status"
                        class="text-sm text-gray-600 dark:text-gray-400"
                    >
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
{#if unlockThen && unlockOrigin}
    <UnlockDialog
        serverOrigin={unlockOrigin}
        onunlocked={runUnlockThen}
        onclose={cancelUnlock}
    />
{/if}
