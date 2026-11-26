<script lang="ts">
    /**
     * Invite a player to a synced graph. Two steps in one modal: enter the invitee's email,
     * then verify their Security Fingerprint out-of-band before the key is sealed to them.
     *
     * Fingerprints the owner confirms are pinned in the vault (ADR 0126): an invitee checked
     * before shows as Verified and needs no second comparison, and one whose key has changed
     * since is shown with a warning and a fresh comparison before anything is sent.
     */
    import { webClientAddress } from "#lib/native/web-address.js";
    import {
        InviteeNotFoundError,
        isOwnAddress,
        prepareInvite,
        sendInvite,
        type InviteLookup,
        type SyncApi,
    } from "#lib/sync/index.js";
    import { INVITE_SELF_COPY, describeSyncFailure } from "#lib/sync/sync-error-copy.js";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { copyFailureMessage, writeClipboardText } from "#lib/document/commands/clipboard-text.js";
    import SecurityFingerprint from "./SecurityFingerprint.svelte";

    let {
        api,
        graphId,
        graphName,
        heldKey,
        ownEmail = null,
        inviteeNeeds = { account: "an EtherPK account", verifiedEmail: true },
        onclose,
    }: {
        api: SyncApi;
        graphId: string;
        /** Sealed into the invite so the invitee's client can label the graph (ADR 0031). */
        graphName?: string;
        /** The key this device holds for the account's vault: the graph's keyring and the pins are in it. */
        heldKey: Uint8Array;
        /** The signed-in account's address, so inviting it is refused before the lookup. */
        ownEmail?: string | null;
        /**
         * What an invitee must have on this server, for the dialog to name: the kind of account,
         * and whether its address must be verified (the owner's `invitesNeedVerifiedEmail`).
         */
        inviteeNeeds?: { account: string; verifiedEmail: boolean };
        onclose: (result?: { sentTo: string }) => void;
    } = $props();

    let open = $state(true);
    let step = $state<"email" | "verify" | "done">("email");
    let email = $state("");
    let error = $state<string | null>(null);
    let busy = $state(false);
    let prep = $state.raw<Extract<InviteLookup, { kind: "found" }> | null>(null);
    const errorId = $props.id();

    /** How the fingerprint check reads, from what the pins say about the invitee's key. */
    const fingerprintState = $derived(
        prep?.pin.kind === "verified" ? "verified" : prep?.pin.kind === "changed" ? "changed" : "unchecked",
    );

    /**
     * The app's address, for the owner to send to somebody who has not set it up yet. A Native App's
     * own address leads nowhere outside it, so it names the web Client's, or none (web-address.ts).
     */
    const appLink = webClientAddress("/graphs");
    /** What an invitee needs, in words: an account, a verified address where asked, and keys. */
    const needs = $derived(
        `${inviteeNeeds.account}${inviteeNeeds.verifiedEmail ? " with a verified email address" : ""}`,
    );
    /**
     * One answer for every reason nobody can be invited under an address, as the server gives
     * one (it will not say whether an account exists). So it names every prerequisite.
     */
    const inviteeNotFound = $derived(
        `Nobody with that address can be invited yet. They need ${needs}, and Encryption Keys: their first synced graph creates them, or Create Encryption Keys in Sync settings. ${appLink ? "Send them a link to EtherPK, then try again." : "Ask them to set up EtherPK, then try again."}`,
    );
    let linkCopy = $state<"idle" | "copied" | string>("idle");
    /** The last lookup or send found nobody to invite: the dialog offers the app's link to send. */
    let inviteeMissing = $state(false);

    function copyAppLink() {
        if (!appLink) return;
        writeClipboardText(appLink).then(
            () => (linkCopy = "copied"),
            (err: unknown) => (linkCopy = copyFailureMessage("link", err, appLink)),
        );
    }

    /** The step's primary action, so Enter in the field does what the button does. */
    function submitStep() {
        if (step === "email") void lookUp();
        else if (step === "verify") void send();
        else close({ sentTo: email.trim() });
    }

    async function lookUp() {
        if (busy) return;
        error = null;
        inviteeMissing = false;
        if (!email.trim()) {
            error = "Enter the person's email address.";
            return;
        }
        if (isOwnAddress(email, ownEmail)) {
            error = INVITE_SELF_COPY;
            return;
        }
        busy = true;
        try {
            const found = await prepareInvite(api, graphId, email.trim(), heldKey);
            if (found.kind === "not-found") {
                error = inviteeNotFound;
                inviteeMissing = true;
                return;
            }
            if (found.kind === "keys-outdated") {
                // Their keys predate signing keys (ADR 0126): opening EtherPK once updates them.
                error = `${email.trim()} needs to open EtherPK once before you can invite them, so that their Encryption Keys are updated. Ask them to open it, then try again.`;
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
            await sendInvite(
                api,
                {
                    graphId,
                    graphName,
                    inviteeEmail: email.trim(),
                    invitee: { userId: prep.inviteeUserId, identity: prep.identity },
                },
                heldKey,
            );
            step = "done";
        } catch (e) {
            inviteeMissing = e instanceof InviteeNotFoundError;
            error = inviteeMissing
                ? `${inviteeNotFound} Nothing was shared.`
                : `${describeSyncFailure(e, "send the invite")} Nothing was shared.`;
        } finally {
            busy = false;
        }
    }

    function close(result?: { sentTo: string }) {
        open = false;
        onclose(result);
    }
</script>

<!-- Somebody who cannot be invited yet usually has not set EtherPK up: the link is what to
     send them. The link itself stays on screen, so a blocked clipboard is no dead end. -->
{#snippet appLinkOffer()}
    {#if inviteeMissing && appLink}
        <div data-testid="invite-app-link" class="flex flex-wrap items-center gap-2">
            <code class="break-all rounded bg-neutral-100 px-2 py-1 font-mono text-sm text-neutral-900 dark:bg-white/10 dark:text-neutral-100">{appLink}</code>
            <button
                type="button"
                onclick={copyAppLink}
                class="gk-button"
            >{linkCopy === "copied" ? "Copied" : "Copy link"}</button>
            <span role="status" class="text-sm text-neutral-600 dark:text-neutral-400">
                {#if linkCopy !== "idle" && linkCopy !== "copied"}{linkCopy}{/if}
            </span>
        </div>
    {/if}
{/snippet}

<Modal {open} title="Invite a player" busy={busy} busyReason="Working…" onclose={() => close()} onsubmit={submitStep}>
    {#snippet body()}
        {#if step === "email"}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Enter the email address of the person you want to share this graph with. They need
                {needs} and Encryption Keys, which EtherPK creates with their first synced graph or from
                Sync settings.
            </p>
            <div>
                <label for="invite-email" class="gk-label mb-1.5 block">Email address</label>
                <input
                    id="invite-email"
                    type="email"
                    bind:value={email}
                    data-testid="invite-email"
                    placeholder="name@example.com"
                    aria-invalid={error && step === "email" ? "true" : undefined}
                    aria-describedby={error && step === "email" ? errorId : undefined}
                    class="gk-input"
                />
                {#if error && step === "email"}
                    <p id={errorId} role="alert" class="mt-1.5 text-sm text-red-600" data-testid="invite-error">{error}</p>
                {/if}
            </div>
            {@render appLinkOffer()}
        {:else if step === "verify" && prep}
            {#if fingerprintState === "unchecked"}
                <p class="text-sm text-neutral-600 dark:text-neutral-400">
                    Before sharing your key, confirm this is really <span class="font-medium text-neutral-900 dark:text-neutral-200">{email}</span>.
                    Check that the security fingerprint below matches theirs, verified in person or over a
                    call you trust.
                </p>
            {/if}
            <SecurityFingerprint fingerprint={prep.fingerprint} state={fingerprintState} name={email.trim()} />
            {#if fingerprintState !== "verified"}
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                    They can find theirs under <span class="font-medium">Sync settings</span>, as
                    <span class="font-medium">Your security fingerprint</span>.
                </p>
            {/if}
        {:else if step === "done"}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Invite sent to <span class="font-medium text-neutral-900 dark:text-neutral-200">{email}</span>.
                They will see it under Pending invites on their Graphs page. Until they
                accept, they are listed on this graph as Invited, where you can cancel the invite.
            </p>
        {/if}
        {#if error && step !== "email"}
            <p role="alert" class="text-sm text-red-600" data-testid="invite-error">{error}</p>
            {@render appLinkOffer()}
        {/if}
    {/snippet}


    {#snippet footer()}
        {#if step === "email"}
            <button type="button" onclick={() => close()} class="gk-button">Cancel</button>
            <button
                type="submit"
                disabled={busy}
                data-testid="invite-lookup"
                class="gk-button gk-button--primary min-w-32"
            >{busy ? "Looking up…" : "Continue"}</button>
        {:else if step === "verify"}
            <button type="button" onclick={() => (step = "email")} class="gk-button">Back</button>
            <!-- Reserved width: this label loses ~150px when it becomes "Sending…", which slid
                 the Back button out from under the pointer that had just clicked. -->
            <button
                type="submit"
                disabled={busy}
                data-testid="invite-send"
                class="gk-button gk-button--primary min-w-64"
            >{busy
                    ? "Sending…"
                    : fingerprintState === "verified"
                      ? "Send invite"
                      : fingerprintState === "changed"
                        ? "It matches, trust the new key"
                        : "Fingerprint matches, send invite"}</button>
        {:else}
            <button
                type="submit"
                data-testid="invite-done"
                class="gk-button gk-button--primary"
            >Done</button>
        {/if}
    {/snippet}
</Modal>
