<script lang="ts">
    /**
     * The Import wizard (plan: 2026-07-16 Import New Graph Creation.md): pick a source
     * folder, confirm the detected format and a name, choose a destination backend, run.
     * Conversion is fully in-memory before the first write; the destination folder must
     * be empty (never-in-place). Under the ?fs=opfs dev gate the folder destination
     * materialises into OPFS instead of the un-automatable FSA picker.
     *
     * The dialog does NOT run the import - it starts an [[Activity]] and closes (ADR 0035).
     * Everything it does before that point needs to be here: the destination picker needs
     * the click's user gesture, and the empty-folder check must fail while there is still
     * a dialog to show the message in. After that the [[Activity Toast]] owns the run.
     */
    import { tick } from "svelte";
    import { ActivityConflictError, isRunning } from "$lib/activity/store";
    import { isFsaSupported, pickGraphDirectory } from "$lib/storage";
    import type {
        GraphRegistry,
        ServerGraphScope,
    } from "$lib/storage/graph-registry";
    import { getOpfsRoot } from "$lib/storage/fs/web-fs-adapter";
    import type { SyncApi } from "$lib/sync/sync-api";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import { PUBLIC_DOCS_URL } from "@appsoftwareltd/etherpk-shared";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import {
        ProtectionPassphraseError,
        parseProtectionRecord,
        unlockProtectionRecord,
        type ProtectionRecord,
    } from "$lib/crypto";
    import { PROTECTION_FILE } from "$lib/document/protection/protection-store";

    import { describeOversize, oversizeAssets } from "../asset-preflight";
    import { startImport } from "../import-activity";
    import {
        directoryHasEntries,
        prepareSource,
        type PreparedSource,
        type ServerImportResult,
    } from "../run-import";
    import { prepareZipSource } from "../zip-source";
    import { findFile, isJunkPath, isMarkdownPath } from "../source";
    import type { ImportFormat } from "../types";

    let {
        registry,
        syncTarget,
        syncUnavailableReason = "Connect this device to a sync server first.",
        getWrapKey,
        ensureVaultReady,
        assetLimits = null,
        opfsDestination = false,
        onclose,
        onimported,
        onsettled,
    }: {
        registry: GraphRegistry;
        /** null when the device has no sync config - the synced destination is unavailable. */
        syncTarget: {
            api: SyncApi;
            serverBaseUrl: string;
            serverScope: ServerGraphScope;
        } | null;
        /** Why the synced destination is unavailable, shown beside it and if a run is attempted. */
        syncUnavailableReason?: string;
        getWrapKey: () => Promise<Uint8Array>;
        /** Settles the account's encryption keys before a synced run creates anything. */
        ensureVaultReady?: () => Promise<void>;
        /** The account's per-asset allowance, when the device knows it. Drives the pre-flight. */
        assetLimits?: { assetBytes: number; assetChunks: number } | null;
        /** Dev/e2e gate (?fs=opfs): materialise into an OPFS folder instead of the FSA picker. */
        opfsDestination?: boolean;
        onclose: () => void;
        /** "Open" on the finished toast, or the fresh-account key ritual. Never fires on its own. */
        onimported: (result: { graphId: string } | ServerImportResult) => void;
        /** Runs the instant the import succeeds: caches the device key, starts the code ritual. */
        onsettled?: (result: { graphId: string } | ServerImportResult) => void;
    } = $props();

    const FORMAT_LABELS: Array<[ImportFormat, string]> = [
        ["logseq", "Logseq"],
        ["obsidian", "Obsidian"],
        ["etherpk", "EtherPK"],
        ["markdown", "Plain markdown"],
    ];

    const folderAvailable = $derived(isFsaSupported() || opfsDestination);

    let open = $state(true);
    let prepared = $state.raw<PreparedSource | null>(null);
    let format = $state<ImportFormat>("markdown");
    let name = $state("");
    let destination = $state<"folder" | "synced">("folder");
    /** Only ever true across the pre-flight awaits (the picker, the empty check). */
    let busy = $state(false);
    let error = $state<string | null>(null);
    /** The error is about the name, so the name field is where it is shown and focused. */
    let nameInvalid = $state(false);
    let sourceInput: HTMLInputElement | undefined = $state();
    let zipInput: HTMLInputElement | undefined = $state();
    let zipButton: HTMLButtonElement | undefined = $state();
    let nameInput: HTMLInputElement | undefined = $state();
    let runButton: HTMLButtonElement | undefined = $state();

    /**
     * The protection record a copy of a graph carries (ADR 0093), when it has files for its
     * protected documents to embed. A synced import gives every file a new reference, and the
     * ones sealed inside a protected document can only be updated with the key its passphrase
     * unwraps, so the passphrase is asked for here.
     */
    let sourceProtection = $state.raw<ProtectionRecord | null>(null);
    let protectionPassphrase = $state("");
    let passphraseInvalid = $state(false);
    let checkingPassphrase = $state(false);
    let passphraseInput: HTMLInputElement | undefined = $state();
    /** A folder import keeps every file's name, so only a synced one needs the passphrase. */
    const offerPassphrase = $derived(
        destination === "synced" && format === "etherpk" && sourceProtection !== null,
    );

    /**
     * Put focus where the dialog now wants it, once the change that moved it has rendered: the
     * control that had focus may have gone (the source buttons, once a source is picked) or been
     * disabled while busy, and either leaves focus behind the dialog.
     */
    async function focusAfterRender(target: () => HTMLElement | undefined): Promise<void> {
        await tick();
        target()?.focus();
    }

    /**
     * Files this account cannot store, known before anything uploads. Only meaningful for the
     * synced destination: a local folder has no allowance to exceed.
     */
    const oversize = $derived(
        destination === "synced" && prepared && assetLimits
            ? oversizeAssets(prepared.files, assetLimits)
            : [],
    );

    function close() {
        open = false;
        onclose();
    }

    function onSourcePicked() {
        const files = sourceInput?.files;
        const next = files ? prepareSource(files) : null;
        if (!next) {
            error = "That folder holds no files.";
            return;
        }
        accept(next);
    }

    /**
     * A zip - an [[Export]], or any zipped folder (ADR 0092). Read through its central directory,
     * so a large one costs one read of its tail here; a deflated entry is inflated now, one at a
     * time, and a stored one stays a slice of the picked file until a converter reads it.
     */
    async function onZipPicked() {
        const file = zipInput?.files?.[0];
        if (!file) return;
        busy = true;
        error = null;
        try {
            const next = await prepareZipSource(file);
            if (!next) {
                error = "That zip holds no files.";
                return;
            }
            accept(next);
        } catch (e) {
            error = `Could not read that zip: ${(e as Error).message}`;
        } finally {
            busy = false;
            // Busy disabled the button that had focus; a refused zip goes back to it.
            if (!prepared) void focusAfterRender(() => zipButton);
        }
    }

    function accept(next: PreparedSource) {
        error = null;
        prepared = next;
        format = next.format;
        sourceProtection = null;
        void readSourceProtection(next);
        if (!name.trim()) name = next.folderName;
        if (!folderAvailable) destination = "synced";
        // The source buttons are gone; the name is the next thing to check.
        void focusAfterRender(() => nameInput);
    }

    /**
     * The source's protection record, when its protected documents could embed any of its files.
     * A record this build cannot read offers nothing: the converter reports it, and no passphrase
     * would open it.
     */
    async function readSourceProtection(source: PreparedSource) {
        const file = findFile(source.files, `etherpk/${PROTECTION_FILE}`);
        const embeds = source.files.some(
            (f) => !isJunkPath(f.path) && !isMarkdownPath(f.path) && !f.path.startsWith("etherpk/"),
        );
        if (!file || !embeds) return;
        try {
            const record = parseProtectionRecord(await file.data.text());
            // Another source may have been picked while this one was read.
            if (prepared === source) sourceProtection = record;
        } catch {
            // Reported by the converter; there is nothing here to unlock.
        }
    }

    /** The destination directory: the FSA picker, or a fresh OPFS dir under the dev gate. */
    async function pickDestination(): Promise<FileSystemDirectoryHandle | null> {
        if (opfsDestination) {
            const root = await getOpfsRoot();
            return root.getDirectoryHandle(
                `graph-import-${crypto.randomUUID()}`,
                { create: true },
            );
        }
        try {
            return await pickGraphDirectory();
        } catch {
            return null; // the user cancelled the picker
        }
    }

    /**
     * Pre-flight, then hand off. Everything that can still fail *usefully in a dialog*
     * happens here; from `startImport` on, the toast is the surface and this closes.
     */
    async function runImport() {
        if (!prepared || busy) return;
        const trimmed = name.trim();
        if (!trimmed) {
            error = "Give the graph a name.";
            nameInvalid = true;
            void focusAfterRender(() => nameInput);
            return;
        }
        nameInvalid = false;
        passphraseInvalid = false;
        // At most one import at a time (per tab): two large ones double a memory footprint
        // that is already the likeliest thing to fall over on a real graph.
        if (isRunning("import")) {
            error =
                "An import is already running. Wait for it to finish, or cancel it first.";
            return;
        }
        busy = true;
        error = null;
        try {
            const reportDate = new Date().toISOString().slice(0, 10);
            const common = {
                files: prepared.files,
                format,
                name: trimmed,
                reportDate,
                onOpen: onimported,
                onSettled: onsettled,
            };

            if (destination === "folder") {
                // The picker needs the click's own user gesture, so it cannot move into the
                // Activity - by the time that runs the gesture is spent.
                const handle = await pickDestination();
                if (!handle) return;
                if (await directoryHasEntries(handle)) {
                    error =
                        "That folder is not empty. Import creates a new graph - choose or create an empty folder.";
                    return;
                }
                void startImport({
                    ...common,
                    destination: { kind: "filesystem", handle, registry },
                });
            } else {
                if (!syncTarget) {
                    error = syncUnavailableReason;
                    return;
                }
                // Unwrapped here, in front of the person, so a mistyped passphrase is refused at
                // the field rather than found in the report of a finished import.
                let protectionKey: Uint8Array | null = null;
                if (offerPassphrase && sourceProtection && protectionPassphrase !== "") {
                    checkingPassphrase = true;
                    try {
                        protectionKey = await unlockProtectionRecord(sourceProtection, protectionPassphrase);
                    } catch (e) {
                        if (!(e instanceof ProtectionPassphraseError)) throw e;
                        error =
                            "That passphrase does not open this graph’s protected documents. Check it, or clear the field to import them without their images.";
                        passphraseInvalid = true;
                        void focusAfterRender(() => passphraseInput);
                        return;
                    } finally {
                        checkingPassphrase = false;
                    }
                }
                // Ask for the keys here, in front of the user, rather than failing a long
                // background run - or creating a graph server-side it can never key.
                try {
                    await ensureVaultReady?.();
                } catch (e) {
                    // The run that would have overwritten the key will not start.
                    protectionKey?.fill(0);
                    throw e;
                }
                void startImport({
                    ...common,
                    destination: {
                        kind: "server",
                        deps: {
                            api: syncTarget.api,
                            registry,
                            serverBaseUrl: syncTarget.serverBaseUrl,
                            serverScope: syncTarget.serverScope,
                            getWrapKey,
                            protectionKey,
                        },
                    },
                });
            }
            open = false;
            onclose();
        } catch (e) {
            // Only a conflict or a pre-flight throw lands here; the run's own failures are
            // reported by its toast, since by then this dialog is gone.
            error =
                e instanceof ActivityConflictError
                    ? e.message
                    : describeSyncFailure(e, "start the import");
        } finally {
            busy = false;
            // A refusal is announced by its alert; focus goes back to Import, which busy had
            // disabled, so a keyboard user is still in the dialog to try again. A wrong
            // passphrase has already sent it to the field.
            if (error && !passphraseInvalid) void focusAfterRender(() => runButton);
        }
    }
</script>

<Modal
    {open}
    title="Import a graph"
    {busy}
    busyReason={checkingPassphrase ? "Checking the passphrase…" : "Starting…"}
    onclose={close}
    onsubmit={runImport}
>
    {#snippet body()}
        {#if !prepared}
            <p class="text-sm text-gray-600 dark:text-gray-300">
                Bring an existing EtherPK graph, Logseq graph or Obsidian vault
                export in as a new knowledge graph, from a folder or from a zip
                of one. The source is only read - your original stays untouched.
                <a
                    href="{PUBLIC_DOCS_URL}/importing-from-logseq-obsidian-or-etherpk"
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="import-guide"
                    class="font-medium underline">What import converts</a
                >
            </p>
            <input
                bind:this={sourceInput}
                data-testid="import-source-input"
                type="file"
                webkitdirectory
                multiple
                class="hidden"
                onchange={onSourcePicked}
            />
            <input
                bind:this={zipInput}
                data-testid="import-zip-input"
                type="file"
                accept=".zip,application/zip"
                class="hidden"
                onchange={onZipPicked}
            />
            <div class="flex flex-wrap gap-2">
                <button
                    type="button"
                    data-testid="import-choose-source"
                    data-autofocus
                    disabled={busy}
                    onclick={() => sourceInput?.click()}
                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Choose folder…</button
                >
                <button
                    bind:this={zipButton}
                    type="button"
                    data-testid="import-choose-zip"
                    disabled={busy}
                    onclick={() => zipInput?.click()}
                    class="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                    >Choose a zip…</button
                >
            </div>
        {:else}
            <p
                class="text-sm text-gray-600 dark:text-gray-300"
                data-testid="import-summary"
            >
                <span class="font-medium"
                    >{prepared.folderName || "Selected folder"}</span
                >: {prepared.markdownCount} markdown {prepared.markdownCount ===
                1
                    ? "file"
                    : "files"}, {prepared.otherCount} other.
            </p>
            <div>
                <label
                    for="import-format"
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                    >Source format (detected)</label
                >
                <select
                    id="import-format"
                    data-testid="import-format"
                    disabled={busy}
                    bind:value={format}
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                >
                    {#each FORMAT_LABELS as [value, label] (value)}
                        <option {value}>{label}</option>
                    {/each}
                </select>
            </div>
            <div>
                <label
                    for="import-name"
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                    >Graph name</label
                >
                <input
                    bind:this={nameInput}
                    id="import-name"
                    data-testid="import-name"
                    bind:value={name}
                    oninput={() => (nameInvalid = false)}
                    aria-invalid={nameInvalid}
                    aria-describedby={nameInvalid ? "import-error" : undefined}
                    disabled={busy}
                    autocomplete="off"
                    class="block w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:border-gray-950 dark:focus:border-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-950 dark:focus:ring-gray-400"
                />
            </div>
            <fieldset>
                <legend
                    class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                    >Where the new graph lives</legend
                >
                <div class="space-y-2">
                    <label
                        class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200"
                    >
                        <input
                            type="radio"
                            bind:group={destination}
                            value="folder"
                            disabled={busy || !folderAvailable}
                            data-testid="import-dest-folder"
                            class="mt-0.5"
                        />
                        <!-- An unavailable choice recedes by colour, never opacity; its reason keeps full
                             contrast, as the synced choice below does. -->
                        <span
                            ><span class="font-medium {folderAvailable ? '' : 'text-gray-500 dark:text-gray-400'}">Local folder</span> -
                            plain markdown files in a new, empty folder you
                            choose.{#if !folderAvailable}
                                <span class="block text-gray-600 dark:text-gray-300">Needs a Chromium-based desktop browser.</span>{/if}</span
                        >
                    </label>
                    <label
                        class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-200"
                    >
                        <input
                            type="radio"
                            bind:group={destination}
                            value="synced"
                            disabled={busy || !syncTarget}
                            data-testid="import-dest-synced"
                            aria-describedby={syncTarget ? undefined : "import-dest-synced-reason"}
                            class="mt-0.5"
                        />
                        <span
                            ><span class="font-medium {syncTarget ? '' : 'text-gray-500 dark:text-gray-400'}"
                                >Synced graph</span
                            > - end-to-end encrypted on your sync server, available
                            on all your devices.{#if !syncTarget}
                                <!-- Full contrast: the reason is what the reader needs from this line. -->
                                <span id="import-dest-synced-reason" data-testid="import-dest-synced-reason" class="block text-gray-600 dark:text-gray-300">{syncUnavailableReason}</span>{/if}</span
                        >
                    </label>
                </div>
            </fieldset>
            {#if offerPassphrase}
                <div data-testid="import-protection">
                    <label
                        for="import-protection-passphrase"
                        class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400"
                        >Protection passphrase (optional)</label
                    >
                    <p id="import-protection-help" class="mb-1.5 text-sm text-gray-600 dark:text-gray-300">
                        This graph has protected documents. Enter its passphrase to bring
                        the images and files inside them across too. Without it the
                        documents still arrive, but images inside them will not display.
                    </p>
                    <input
                        bind:this={passphraseInput}
                        id="import-protection-passphrase"
                        data-testid="import-protection-passphrase"
                        type="password"
                        bind:value={protectionPassphrase}
                        oninput={() => (passphraseInvalid = false)}
                        aria-invalid={passphraseInvalid}
                        aria-describedby={passphraseInvalid
                            ? "import-protection-help import-error"
                            : "import-protection-help"}
                        disabled={busy}
                        autocomplete="current-password"
                        class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {passphraseInvalid
                            ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                            : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                    />
                </div>
            {/if}
            <p class="text-sm text-gray-500 dark:text-gray-400">
                Anything that can't convert losslessly is listed on an Import
                Report page inside the new graph - nothing is silently dropped.
            </p>
        {/if}
        {#if oversize.length > 0}
            <p
                data-testid="import-oversize-warning"
                class="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200"
            >
                {oversize.length === 1
                    ? "1 file is"
                    : `${oversize.length} files are`} larger than your plan allows
                and cannot be uploaded: {oversize
                    .slice(0, 3)
                    .map(describeOversize)
                    .join(", ")}{oversize.length > 3
                    ? `, and ${oversize.length - 3} more`
                    : ""}. Importing continues without {oversize.length === 1
                    ? "it"
                    : "them"}; the import report lists {oversize.length === 1
                    ? "it"
                    : "them"} in the new graph.
            </p>
        {/if}
        {#if error}<p id="import-error" role="alert" class="text-sm text-red-600" data-testid="import-error">
                {error}
            </p>{/if}
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={close}
            disabled={busy}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 disabled:opacity-40"
            >Cancel</button
        >
        {#if prepared}
            <button
                bind:this={runButton}
                type="submit"
                disabled={busy ||
                    (destination === "synced" && !syncTarget) ||
                    (destination === "folder" && !folderAvailable)}
                data-testid="import-run"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
                >{busy ? "Starting…" : "Import"}</button
            >
        {/if}
    {/snippet}
</Modal>
