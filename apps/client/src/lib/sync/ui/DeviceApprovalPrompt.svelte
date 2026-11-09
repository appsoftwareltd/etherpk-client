<script lang="ts">
    /**
     * The approver half of device approval (ADR 0125), hosted once in the app shell.
     *
     * For every Sync Server whose keys this device holds unlocked (ADR 0111), it polls for new
     * requests from that account's OTHER devices and shows each one. Every unlocked device shows the
     * same request, and none answers it until the person chooses one with Show the code: the first
     * answer makes that device the only one that can approve, so it has to be the device the person
     * is looking at. The others close their prompt once the request stops being pending.
     *
     * The chosen device answers with a one-time key of its own. The code appears once the new device
     * reveals its key, which this device checks against the commitment the request carried. The user
     * compares it with the code on the new device's screen - a mismatch means a key was substituted in
     * transit - and on approve the vault key travels encrypted so that only the new device can open it.
     *
     * Not now closes the prompt on this device only. Reject ends the request on every device, and once
     * this device has answered, closing the prompt rejects too, since no other device could approve it.
     */
    import {
        answerDeviceApproval,
        approveDevice,
        createSyncApiFor,
        getVaultWrapKey,
        listSyncConnections,
        readApproverExchange,
        rejectDeviceApproval,
        serverHost,
        setVaultWrapKey,
        SyncApiError,
        SYNC_CONNECTIONS_CHANGED_EVENT,
        SYNC_CONNECTIONS_STORAGE_KEY,
        type ApproverSession,
        type PendingDeviceApproval,
    } from "#lib/sync/index.js";
    import { tick as flushed, untrack } from "svelte";
    import { announceAccountSignal } from "#lib/sync/account-signal.js";
    import { describeSyncFailure } from "#lib/sync/sync-error-copy.js";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    /**
     * How often to look for new requests; how often to follow one on screen that no device has
     * answered, so it closes soon after the person chooses another device; and how often to look for
     * the reveal of one this device answered.
     */
    const IDLE_POLL_MS = 10_000;
    const OFFERED_POLL_MS = 3_000;
    const ACTIVE_POLL_MS = 1_000;

    type Stage =
        /** Shown on every unlocked device. None has answered, so there is no code yet. */
        | { kind: "offered" }
        /** The person chose this device, which answered: its side of the exchange, and the code once the new device revealed its key. */
        | { kind: "holding"; session: ApproverSession; sas: string | null }
        /** The person chose this device, but another had answered first. */
        | { kind: "taken" };

    interface Prompt {
        origin: string;
        /** The request as this device listed it: its id, and the commitment its reveal is checked against. */
        request: PendingDeviceApproval;
        stage: Stage;
    }

    // Raw: the prompt is only ever replaced whole, and comparing it with a copy taken before an
    // await is how a stale result is recognised.
    let current = $state.raw<Prompt | null>(null);
    let open = $state(false);
    let busy = $state(false);
    let error = $state<string | null>(null);
    /** The new device's reveal did not match its commitment: only Reject is offered. */
    let tampered = $state(false);
    // The request on screen replaced one that was withdrawn, so its code is new.
    let replaced = $state(false);
    // Requests put off with Not now, or rejected here - never shown again this session.
    const dismissed = new Set<string>();
    /**
     * Servers that refused this device's credential (401). Polling them stops until the
     * connections change, rather than asking every ten seconds for an answer that cannot change;
     * the account menu is asked to re-check, and says the device is signed out.
     */
    const refused = new Set<string>();
    let lastPoll = 0;
    let checking = false;
    let promptBody = $state<HTMLElement | null>(null);

    function connectionChanged(): void {
        refused.clear();
    }

    function storageChanged(event: StorageEvent): void {
        if (event.key === SYNC_CONNECTIONS_STORAGE_KEY || event.key === null) connectionChanged();
    }

    /** Live requests on one server, newest first; null when it could not be asked. */
    async function listedOn(origin: string): Promise<PendingDeviceApproval[] | null> {
        const api = createSyncApiFor(origin);
        // Locked keys can approve nothing, so a server whose vault is locked here is not asked.
        if (!api || !getVaultWrapKey(origin) || refused.has(origin)) return null;
        try {
            return await api.listDeviceApprovals();
        } catch (e) {
            if (e instanceof SyncApiError && e.status === 401) {
                refused.add(origin);
                announceAccountSignal({ type: "check" });
            }
            // Otherwise the server is unreachable: stay quiet; the next tick retries.
            return null;
        }
    }

    /** The newest request no device has answered yet, unless the person put it off here. */
    function unanswered(listing: PendingDeviceApproval[]): PendingDeviceApproval | undefined {
        return listing.find((p) => p.status === "pending" && !dismissed.has(p.id));
    }

    function show(origin: string, request: PendingDeviceApproval, stage: Stage, replacing = false): void {
        current = { origin, request, stage };
        replaced = replacing;
        error = null;
        tampered = false;
        open = true;
    }

    function close() {
        open = false;
        current = null;
        replaced = false;
        tampered = false;
        error = null;
    }

    /**
     * Answer a request, which makes this the one device that can approve it. `replacing` says the
     * new device withdrew a request this device was handling and asked again. Throws when the server
     * cannot be reached or refuses.
     */
    async function answer(origin: string, request: PendingDeviceApproval, replacing: boolean): Promise<void> {
        const api = createSyncApiFor(origin);
        if (!api) return;
        const session = await answerDeviceApproval(api, request);
        show(origin, request, session === "taken" ? { kind: "taken" } : { kind: "holding", session, sas: null }, replacing);
    }

    /** Show the code: the person chose this device to approve from. */
    async function chooseThisDevice() {
        const prompt = current;
        if (prompt?.stage.kind !== "offered" || busy) return;
        busy = true;
        error = null;
        try {
            await answer(prompt.origin, prompt.request, false);
        } catch (e) {
            error = describeSyncFailure(e, "show the code");
        } finally {
            busy = false;
        }
        // The button that had focus is gone once this device answers. Focus goes to the dialog
        // itself, as on opening with nothing to focus, so Tab and the screen reader stay inside it.
        await flushed();
        if (promptBody && !promptBody.contains(document.activeElement)) promptBody.closest<HTMLElement>('[role="dialog"]')?.focus();
    }

    /** Follow the request on screen: another device being chosen, its reveal, or its end. */
    async function follow(prompt: Prompt): Promise<void> {
        const listing = await listedOn(prompt.origin);
        if (listing === null || busy || current !== prompt) return; // unreachable this tick: keep the prompt
        const mine = listing.find((p) => p.id === prompt.request.id);
        if (prompt.stage.kind === "offered") followOffered(prompt, listing, mine);
        else if (!mine) await followEnded(prompt, listing);
        else if (prompt.stage.kind === "holding") await readCode(prompt, prompt.stage, mine);
    }

    /** Another device was chosen, or the request ended: there is nothing to choose here now. */
    function followOffered(prompt: Prompt, listing: PendingDeviceApproval[], mine: PendingDeviceApproval | undefined): void {
        if (mine?.status === "pending") return;
        close();
        const next = unanswered(listing);
        if (next) show(prompt.origin, next, { kind: "offered" });
    }

    /**
     * Withdrawn, expired, or ended: its code matches nothing now. A device that withdrew the request
     * this one was handling and asked again has a new one waiting. The person chose this device for
     * it, so it is answered straight away; if that fails, the next look offers it.
     */
    async function followEnded(prompt: Prompt, listing: PendingDeviceApproval[]): Promise<void> {
        const next = prompt.stage.kind === "holding" ? unanswered(listing) : undefined;
        close();
        if (next) await answer(prompt.origin, next, true).catch(() => {});
    }

    /** The code, once the new device has revealed a key that matches its commitment. */
    async function readCode(prompt: Prompt, stage: Extract<Stage, { kind: "holding" }>, mine: PendingDeviceApproval): Promise<void> {
        if (stage.sas || tampered) return;
        try {
            const exchange = await readApproverExchange(stage.session, mine);
            if (exchange && current === prompt) current = { ...prompt, stage: { ...stage, sas: exchange.sas } };
        } catch (e) {
            tampered = true;
            error = describeSyncFailure(e, "check the new device");
        }
    }

    /** Look for a new request on every server, and show the first one. */
    async function lookForRequests(): Promise<void> {
        for (const { origin } of listSyncConnections()) {
            const listing = await listedOn(origin);
            if (busy || current) return;
            const next = listing ? unanswered(listing) : undefined;
            if (next) {
                show(origin, next, { kind: "offered" });
                return;
            }
        }
    }

    /** A request this device answered is followed every second, until its code shows. */
    function awaitingCode(prompt: Prompt | null): boolean {
        return prompt?.stage.kind === "holding" && prompt.stage.sas === null && !tampered;
    }

    /** Whether to poll on this tick: at once while awaiting a code, otherwise on the interval for what is on screen. */
    function due(prompt: Prompt | null): boolean {
        if (awaitingCode(prompt)) return true;
        return Date.now() - lastPoll >= (prompt?.stage.kind === "offered" ? OFFERED_POLL_MS : IDLE_POLL_MS);
    }

    async function tick() {
        if (busy || checking) return; // an answer, approve or reject is in flight: leave the prompt as it is
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        const prompt = current;
        if (!due(prompt)) return;
        const fast = awaitingCode(prompt);
        checking = true;
        try {
            if (prompt) await follow(prompt);
            else await lookForRequests();
            if (!fast) lastPoll = Date.now();
        } finally {
            checking = false;
        }
    }

    $effect(() => {
        // Untracked: the tick reads the prompt's state, which must not restart this timer.
        untrack(() => void tick());
        const timer = setInterval(() => void tick(), ACTIVE_POLL_MS);
        // Same-tab connection changes (the Graphs page saving a new token) end a refusal too.
        window.addEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        return () => {
            clearInterval(timer);
            window.removeEventListener(SYNC_CONNECTIONS_CHANGED_EVENT, connectionChanged);
        };
    });

    async function approve() {
        const prompt = current;
        if (prompt?.stage.kind !== "holding" || !prompt.stage.sas || tampered) return;
        const a = createSyncApiFor(prompt.origin);
        const heldKey = getVaultWrapKey(prompt.origin);
        if (!a || !heldKey) return;
        busy = true;
        error = null;
        try {
            // Returns the true vault key (minting it if the vault was legacy) - re-cache it.
            setVaultWrapKey(prompt.origin, await approveDevice(a, prompt.stage.session, heldKey));
            close();
        } catch (e) {
            error = describeSyncFailure(e, "approve the device");
        } finally {
            busy = false;
        }
    }

    /** Not now: close the prompt on this device only, and leave the request to the others. */
    function notNow() {
        if (current) dismissed.add(current.request.id);
        close();
    }

    /** Reject the request on every device. */
    async function reject() {
        const prompt = current;
        if (!prompt || busy) return;
        const a = createSyncApiFor(prompt.origin);
        busy = true;
        error = null;
        try {
            if (a) await rejectDeviceApproval(a, prompt.request.id);
        } catch (e) {
            // Not answered yet, so another device could still approve it: say it is still open.
            if (prompt.stage.kind === "offered") {
                error = describeSyncFailure(e, "reject the request");
                return;
            }
            // Answered here: it ends by itself within ten minutes, and nothing else can approve it meanwhile.
        } finally {
            busy = false;
        }
        dismissed.add(prompt.request.id);
        close();
    }

    /** Escape, the backdrop and the close button: Not now until this device answers, then Reject. */
    function dismiss() {
        const kind = current?.stage.kind;
        if (kind === "offered") notNow();
        else if (kind === "holding") void reject();
        else close();
    }
</script>

<svelte:window onstorage={storageChanged} />

{#if current}
    {@const stage = current.stage}
    <Modal {open} title="Approve a new device?" {busy} onclose={dismiss}>
        {#snippet body()}
            <div bind:this={promptBody} data-testid="device-approval-prompt" class="space-y-3">
                {#if stage.kind === "taken"}
                    <p class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="device-approval-taken">
                        A device signed in to your account on
                        <span class="font-medium text-neutral-950 dark:text-neutral-100">{serverHost(current?.origin ?? "")}</span>
                        asked for your Encryption Keys, and another of your devices is already handling the request.
                    </p>
                {:else}
                    <p class="text-sm text-neutral-600 dark:text-neutral-400">
                        A device signed in to your account on
                        <span class="font-medium text-neutral-950 dark:text-neutral-100" data-testid="device-approval-server">{serverHost(current?.origin ?? "")}</span>
                        is asking for your Encryption Keys there.
                        {#if stage.kind === "offered"}
                            If you are setting that device up right now, select <strong>Show the code</strong>
                            to approve it from this device.
                        {:else}
                            Approve <strong>only if you are setting that device up right now</strong> and
                            its screen shows this exact code:
                        {/if}
                    </p>
                    {#if stage.kind === "holding"}
                        {#if stage.sas}
                            <p class="text-center text-2xl font-mono font-semibold tracking-widest text-neutral-950 dark:text-neutral-100" data-testid="device-approval-sas">{stage.sas}</p>
                        {:else if !tampered}
                            <p class="text-center text-sm text-neutral-500 dark:text-neutral-400" role="status" data-testid="device-approval-checking">Checking the new device…</p>
                        {/if}
                    {/if}
                    <p role="status" class="text-sm text-neutral-600 dark:text-neutral-400" data-testid="device-approval-replaced">
                        {replaced ? "The device withdrew its earlier request and asked again with this new code." : ""}
                    </p>
                    <p class="text-sm text-neutral-500 dark:text-neutral-400">
                        {#if stage.kind === "offered"}
                            Your other unlocked devices show this request too. A request you are not expecting
                            means someone else is trying to get in: reject it.
                        {:else}
                            A different code - or a request you are not expecting - means someone else is
                            trying to get in: reject it.
                        {/if}
                    </p>
                {/if}
                {#if error}<p role="alert" class="text-sm text-red-600" data-testid="device-approval-error">{error}</p>{/if}
            </div>
        {/snippet}

        {#snippet footer()}
            {#if stage.kind === "taken"}
                <button
                    type="button"
                    onclick={close}
                    data-testid="device-approval-close"
                    class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300"
                >Close</button>
            {:else}
                <button
                    type="button"
                    onclick={reject}
                    disabled={busy}
                    data-testid="device-approval-reject"
                    class="rounded-lg border border-red-300 dark:border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40"
                >Reject</button>
                {#if stage.kind === "offered"}
                    <!--
                        Focus starts here: the prompt appears on its own, maybe while the person is
                        typing, and a stray Enter or space must neither answer nor reject the request.
                    -->
                    <button
                        type="button"
                        onclick={notNow}
                        disabled={busy}
                        data-autofocus
                        data-testid="device-approval-not-now"
                        class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                    >Not now</button>
                    <button
                        type="button"
                        onclick={chooseThisDevice}
                        disabled={busy}
                        data-testid="device-approval-choose"
                        class="rounded-lg bg-neutral-900 dark:bg-neutral-100 px-4 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-40"
                    >Show the code</button>
                {:else if !tampered}
                    <button
                        type="button"
                        onclick={approve}
                        disabled={busy || !stage.sas}
                        data-testid="device-approval-approve"
                        class="rounded-lg bg-neutral-900 dark:bg-neutral-100 px-4 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-200 disabled:opacity-40"
                    >{busy ? "Approving" : "Approve"}</button>
                {/if}
            {/if}
        {/snippet}
    </Modal>
{/if}
