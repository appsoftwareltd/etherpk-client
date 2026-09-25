<script lang="ts">
    /**
     * Invite a player to a synced graph. Two steps in one modal: enter the invitee's email,
     * then verify their security fingerprint out-of-band before the key is sealed to them.
     * Replaces the browser prompt/confirm flow.
     */
    import type { GraphKeyring } from "$lib/crypto";
    import { prepareInvite, sendInvite, type SyncApi } from "$lib/sync";
    import { describeSyncFailure } from "$lib/sync/sync-error-copy";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";

    let {
        api,
        graphId,
        graphName,
        keyring,
        onclose,
    }: {
        api: SyncApi;
        graphId: string;
        /** Sealed into the invite so the invitee's client can label the graph (ADR 0031). */
        graphName?: string;
        keyring: GraphKeyring;
        onclose: (result?: { sentTo: string }) => void;
    } = $props();

    let open = $state(true);
    let step = $state<"email" | "verify" | "done">("email");
    let email = $state("");
    let error = $state<string | null>(null);
    let busy = $state(false);
    let prep = $state<{ inviteePublicKey: Uint8Array; fingerprint: string } | null>(null);
    const errorId = $props.id();

    /** The step's primary action, so Enter in the field does what the button does. */
    function submitStep() {
        if (step === "email") void lookUp();
        else if (step === "verify") void send();
        else close({ sentTo: email.trim() });
    }

    async function lookUp() {
        if (busy) return;
        error = null;
        if (!email.trim()) {
            error = "Enter the person's email address.";
            return;
        }
        busy = true;
        try {
            const found = await prepareInvite(api, email.trim());
            if (!found) {
                error = "No EtherPK user found for that email, or they have not set up a device yet.";
                return;
            }
            prep = found;
            step = "verify";
        } catch (e) {
            error = describeSyncFailure(e, "look them up");
        } finally {
            busy = false;
        }
    }

    async function send() {
        if (busy || !prep) return;
        busy = true;
        error = null;
        try {
            await sendInvite(api, graphId, email.trim(), prep.inviteePublicKey, keyring, graphName);
            step = "done";
        } catch (e) {
            error = `${describeSyncFailure(e, "send the invite")} Nothing was shared.`;
        } finally {
            busy = false;
        }
    }

    function close(result?: { sentTo: string }) {
        open = false;
        onclose(result);
    }
</script>

<Modal {open} title="Invite a player" busy={busy} busyReason="Working…" onclose={() => close()} onsubmit={submitStep}>
    {#snippet body()}
        {#if step === "email"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Enter the email address of the person you want to share this graph with. They need an
                EtherPK account and must have set up a device.
            </p>
            <div>
                <label for="invite-email" class="mb-1.5 block text-sm font-medium text-gray-500 dark:text-gray-400">Email address</label>
                <input
                    id="invite-email"
                    type="email"
                    bind:value={email}
                    data-testid="invite-email"
                    placeholder="name@example.com"
                    aria-invalid={error && step === "email" ? "true" : undefined}
                    aria-describedby={error && step === "email" ? errorId : undefined}
                    class="block w-full rounded-lg border bg-white dark:bg-white/10 px-3 py-2 text-sm text-gray-950 dark:text-gray-100 focus:outline-none focus:ring-1 {error
                        ? 'border-red-400 dark:border-red-500/60 focus:border-red-500 focus:ring-red-500'
                        : 'border-gray-300 dark:border-gray-700 focus:border-gray-950 dark:focus:border-gray-400 focus:ring-gray-950 dark:focus:ring-gray-400'}"
                />
                {#if error && step === "email"}
                    <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="invite-error">{error}</p>
                {/if}
            </div>
        {:else if step === "verify" && prep}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Before sharing your key, confirm this is really <span class="font-medium text-gray-900 dark:text-gray-200">{email}</span>.
                Check that the security fingerprint below matches theirs, verified in person or over a
                call you trust.
            </p>
            <code class="block break-all rounded-lg bg-gray-100 dark:bg-white/5 px-4 py-3 text-center text-sm font-mono tracking-wide text-gray-950 dark:text-gray-100">{prep.fingerprint}</code>
            <p class="text-sm text-gray-500 dark:text-gray-400">
                They can find theirs under <span class="font-medium">Sync settings</span>, as
                <span class="font-medium">Your security fingerprint</span>.
            </p>
        {:else if step === "done"}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                Invite sent to <span class="font-medium text-gray-900 dark:text-gray-200">{email}</span>.
                They will see it under Pending invites when they next open EtherPK.
            </p>
        {/if}
        {#if error && step !== "email"}
            <p role="alert" class="text-sm text-red-600" data-testid="invite-error">{error}</p>
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if step === "email"}
            <button type="button" onclick={() => close()} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Cancel</button>
            <button
                type="submit"
                disabled={busy}
                data-testid="invite-lookup"
                class="min-w-32 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
            >{busy ? "Looking up…" : "Continue"}</button>
        {:else if step === "verify"}
            <button type="button" onclick={() => (step = "email")} class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300">Back</button>
            <!-- Reserved width: this label loses ~150px when it becomes "Sending…", which slid
                 the Back button out from under the pointer that had just clicked. -->
            <button
                type="submit"
                disabled={busy}
                data-testid="invite-send"
                class="min-w-64 rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-center text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-40"
            >{busy ? "Sending…" : "Fingerprint matches, send invite"}</button>
        {:else}
            <button
                type="submit"
                data-testid="invite-done"
                class="rounded-lg bg-gray-900 dark:bg-gray-100 px-4 py-1.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
            >Done</button>
        {/if}
    {/snippet}
</Modal>
