<script lang="ts" module>
    /** A way to an account that can take the graph: a sign-in, a sign-up or Billing. */
    export interface SyncPlusOfferButton {
        label: string;
        /** Told the name typed so far, so a return from Billing still has it. */
        run: (name: string) => void;
    }
</script>

<script lang="ts">
    /**
     * Import to Sync+ (plan: 2026-11-19 Import To Sync Plus): copies the folder graph the header
     * button was pressed in into a new synced graph. No folder is picked and no format asked: the
     * Client holds the folder's handle, and the folder is an EtherPK graph. What the dialog shows
     * besides follows the account (`importToSyncPlusStep`): Import when a server can take the
     * graph, the way to Sync+ when none can, and a wait while the account is being checked.
     *
     * Like the Import dialog it does not run the import: once the files are read and the keys are
     * settled it starts the [[Activity]] and closes, and the toast owns the run (ADR 0035).
     */
    import { tick } from "svelte";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { ActivityConflictError } from "#lib/activity/store.js";
    import {
        ProtectionPassphraseError,
        unlockProtectionRecord,
        type ProtectionRecord,
    } from "#lib/crypto/index.js";
    import { describeSyncFailure } from "#lib/sync/sync-error-copy.js";
    import { serverHost } from "#lib/sync/sync-connections.js";

    import { SyncPlusImportRefusal, type ImportToSyncPlusStep } from "../import-to-sync-plus";
    import { protectionToUnlock } from "../source-protection";
    import type { SourceFile } from "../types";

    let {
        graphName,
        initialName = graphName,
        step,
        offer,
        readSource,
        start,
        onclose,
    }: {
        /** The folder graph's name, for the dialog's title. */
        graphName: string;
        /** The new graph's name to start from: a name typed before leaving for Billing comes back. */
        initialName?: string;
        step: ImportToSyncPlusStep;
        /** For the `offer` step: what the plan asks, the reason nothing can take the graph, and the ways on. */
        offer: {
            text: string | null;
            pricingUrl: string | null;
            reason: string | null;
            buttons: SyncPlusOfferButton[];
        };
        /** The folder's files. Asks for permission to read it first, so it runs inside the press. */
        readSource: () => Promise<SourceFile[]>;
        /** Settle the keys and start the import; the dialog is closed by the caller once it has started. */
        start: (run: {
            origin: string;
            name: string;
            files: SourceFile[];
            protectionKey: Uint8Array | null;
        }) => Promise<void>;
        onclose: () => void;
    } = $props();

    // svelte-ignore state_referenced_locally
    let name = $state(initialName);
    let busy = $state(false);
    let error = $state<string | null>(null);
    let nameInvalid = $state(false);
    let checkingPassphrase = $state(false);
    /** Read once, at the first press, and kept: the second press after a passphrase is asked for reads nothing again. */
    let files = $state.raw<SourceFile[] | null>(null);
    /** The source's protection record when its passphrase is worth asking for; undefined until the files are read. */
    let protection = $state.raw<ProtectionRecord | null | undefined>(undefined);
    let passphrase = $state("");
    let passphraseInvalid = $state(false);
    let nameInput: HTMLInputElement | undefined = $state();
    let passphraseInput: HTMLInputElement | undefined = $state();
    let runButton: HTMLButtonElement | undefined = $state();

    const SECONDARY =
        "rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 pointer-coarse:min-h-11 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5";
    const PRIMARY =
        "rounded-lg bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 pointer-coarse:min-h-11 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200";

    const custom = $derived(step.kind === "import" && !step.managed ? serverHost(step.origin) : null);
    const title = $derived(custom ? `Import "${graphName}" to a synced graph` : `Import "${graphName}" to Sync+`);

    /** Where focus goes once a press has finished: a field the press found needs something. */
    let focusNext: (() => HTMLElement | undefined) | null = null;

    async function focusAfterRender(target: () => HTMLElement | undefined): Promise<void> {
        await tick();
        target()?.focus();
    }

    function describe(e: unknown): string {
        if (e instanceof SyncPlusImportRefusal || e instanceof ActivityConflictError) return e.message;
        return describeSyncFailure(e, "start the import");
    }

    /** The name to import under, or null when it is empty and the field now says so. */
    function checkedName(): string | null {
        const trimmed = name.trim();
        nameInvalid = trimmed === "";
        if (!nameInvalid) return trimmed;
        error = "Give the graph a name.";
        void focusAfterRender(() => nameInput);
        return null;
    }

    /**
     * The Protection Key the passphrase typed unwraps: null when none was typed or none is needed,
     * undefined when the passphrase was refused and the field now says so.
     */
    async function unlockedProtectionKey(): Promise<Uint8Array | null | undefined> {
        if (!protection || passphrase === "") return null;
        checkingPassphrase = true;
        try {
            return await unlockProtectionRecord(protection, passphrase);
        } catch (e) {
            if (!(e instanceof ProtectionPassphraseError)) throw e;
            error =
                "That passphrase does not open this graph’s protected documents. Check it, or clear the field to import them without their images.";
            passphraseInvalid = true;
            focusNext = () => passphraseInput;
            return undefined;
        } finally {
            checkingPassphrase = false;
        }
    }

    /**
     * The folder's files and the Protection Key, or null when the dialog first needs something
     * more: the passphrase field, shown once when protected documents embed files (leaving it
     * empty imports them without those files), or a passphrase it refused.
     */
    async function prepare(): Promise<{ files: SourceFile[]; protectionKey: Uint8Array | null } | null> {
        files ??= await readSource();
        if (protection === undefined) {
            protection = await protectionToUnlock(files);
            if (protection) {
                focusNext = () => passphraseInput;
                return null;
            }
        }
        const protectionKey = await unlockedProtectionKey();
        return protectionKey === undefined ? null : { files, protectionKey };
    }

    async function run() {
        if (busy || step.kind !== "import") return;
        const trimmed = checkedName();
        if (trimmed === null) return;
        passphraseInvalid = false;
        busy = true;
        error = null;
        const origin = step.origin;
        try {
            const ready = await prepare();
            if (ready) await start({ origin, name: trimmed, ...ready });
        } catch (e) {
            error = describe(e);
        } finally {
            busy = false;
            // Busy disabled every control, so focus moves only now that they are enabled again: to
            // the field that needs something, or back to the button after any other refusal.
            const target = focusNext ?? (error ? () => runButton : null);
            focusNext = null;
            if (target) void focusAfterRender(target);
        }
    }
</script>

<Modal
    open={true}
    {title}
    {busy}
    busyReason={checkingPassphrase ? "Checking the passphrase…" : "Starting…"}
    testId="import-to-sync-plus-dialog"
    {onclose}
    onsubmit={run}
>
    {#snippet body()}
        <div class="space-y-3 text-sm text-neutral-700 dark:text-neutral-200">
            <p data-testid="import-to-sync-plus-what">
                {#if custom}
                    This creates a new synced graph from this folder graph on {custom},
                    end-to-end encrypted and on all your devices.
                {:else}
                    This creates a new synced graph from this folder graph. Sync+ keeps it
                    end-to-end encrypted and on all your devices.
                {/if}
            </p>
            <p data-testid="import-to-sync-plus-separate">
                The folder is only read, and this folder graph stays as it is. After the
                import they are two separate graphs, and a change in one does not reach
                the other.
            </p>
        </div>
        <div>
            <label
                for="import-to-sync-plus-name"
                class="mb-1.5 block text-sm font-medium text-neutral-500 dark:text-neutral-400"
                >Graph name</label
            >
            <input
                bind:this={nameInput}
                id="import-to-sync-plus-name"
                data-testid="import-to-sync-plus-name"
                bind:value={name}
                oninput={() => (nameInvalid = false)}
                aria-invalid={nameInvalid}
                aria-describedby={nameInvalid ? "import-to-sync-plus-error" : undefined}
                disabled={busy}
                autocomplete="off"
                class="block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-950 focus:border-neutral-950 focus:ring-1 focus:ring-neutral-950 focus:outline-none dark:border-neutral-700 dark:bg-white/10 dark:text-neutral-100 dark:focus:border-neutral-400 dark:focus:ring-neutral-400"
            />
        </div>
        {#if protection}
            <div data-testid="import-to-sync-plus-protection">
                <label
                    for="import-to-sync-plus-passphrase"
                    class="mb-1.5 block text-sm font-medium text-neutral-500 dark:text-neutral-400"
                    >Protection passphrase (optional)</label
                >
                <p id="import-to-sync-plus-passphrase-help" class="mb-1.5 text-sm text-neutral-600 dark:text-neutral-300">
                    This graph has protected documents. Enter its passphrase to bring the
                    images and files inside them across too. Without it the documents still
                    arrive, but images inside them will not display.
                </p>
                <input
                    bind:this={passphraseInput}
                    id="import-to-sync-plus-passphrase"
                    data-testid="import-to-sync-plus-passphrase"
                    type="password"
                    bind:value={passphrase}
                    oninput={() => (passphraseInvalid = false)}
                    aria-invalid={passphraseInvalid}
                    aria-describedby={passphraseInvalid
                        ? "import-to-sync-plus-passphrase-help import-to-sync-plus-error"
                        : "import-to-sync-plus-passphrase-help"}
                    disabled={busy}
                    autocomplete="current-password"
                    class={[
                        "block w-full rounded-lg border bg-white px-3 py-2 text-sm text-neutral-950 focus:ring-1 focus:outline-none dark:bg-white/10 dark:text-neutral-100",
                        passphraseInvalid
                            ? "border-red-400 focus:border-red-500 focus:ring-red-500 dark:border-red-500/60"
                            : "border-neutral-300 focus:border-neutral-950 focus:ring-neutral-950 dark:border-neutral-700 dark:focus:border-neutral-400 dark:focus:ring-neutral-400",
                    ]}
                />
            </div>
        {/if}
        <!-- What the account needs before the import can run. Polite: it changes by itself as the
             account check answers. -->
        <div
            id="import-to-sync-plus-status"
            data-testid="import-to-sync-plus-status"
            aria-live="polite"
            class="text-sm text-neutral-600 dark:text-neutral-300"
        >
            {#if step.kind === "import" && step.unlock}
                <p>
                    Your Encryption Keys are locked on this device. You unlock them first,
                    then the import starts.
                </p>
            {:else if step.kind === "wait"}
                <p>Checking your EtherPK account…</p>
            {:else if step.kind === "offer"}
                {#if offer.text}
                    <p>
                        {offer.text}
                        {#if offer.pricingUrl}
                            <a
                                href={offer.pricingUrl}
                                class="font-medium text-(--gk-accent) underline underline-offset-2"
                                >See pricing</a
                            >
                        {/if}
                    </p>
                {/if}
                {#if offer.reason}
                    <p data-testid="import-to-sync-plus-reason">{offer.reason}</p>
                {/if}
            {/if}
        </div>
        {#if error}
            <p
                id="import-to-sync-plus-error"
                role="alert"
                class="text-sm text-red-600 dark:text-red-400"
                data-testid="import-to-sync-plus-error"
            >
                {error}
            </p>
        {/if}
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={onclose}
            disabled={busy}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-700 disabled:opacity-40 dark:text-neutral-400 dark:hover:text-neutral-300"
            >Cancel</button
        >
        {#if step.kind === "offer"}
            {#each [...offer.buttons].reverse() as button, index (button.label)}
                <button
                    type="button"
                    data-testid="import-to-sync-plus-offer"
                    onclick={() => button.run(name.trim() || graphName)}
                    class={index === offer.buttons.length - 1 ? PRIMARY : SECONDARY}
                    >{button.label}</button
                >
            {/each}
        {:else}
            <!-- While the account is checked the button waits, and the line above says why. -->
            <button
                bind:this={runButton}
                type="submit"
                disabled={busy || step.kind === "wait"}
                aria-describedby={step.kind === "wait" ? "import-to-sync-plus-status" : undefined}
                data-testid="import-to-sync-plus-run"
                class={PRIMARY}
                >{busy
                    ? "Starting…"
                    : step.kind === "import" && step.unlock
                      ? "Unlock and import"
                      : "Import"}</button
            >
        {/if}
    {/snippet}
</Modal>
