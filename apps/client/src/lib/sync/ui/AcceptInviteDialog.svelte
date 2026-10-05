<script lang="ts">
    /**
     * The invitee's half of the fingerprint check (ADR 0126). Before an invite is accepted, the
     * invitee sees the inviter's Security Fingerprint to compare, or Verified when they compared
     * it before and the key has not changed. A key that has changed since is shown with a warning.
     * An invite with no signature, or one that does not check out, is explained and cannot be
     * accepted.
     *
     * The dialog only confirms. The Graphs page runs the accept itself, with its own checks for
     * a copy of the graph this browser still holds.
     */
    import type { InviteCheck } from "$lib/sync";
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import SecurityFingerprint from "./SecurityFingerprint.svelte";

    let {
        check,
        graphName = null,
        onconfirm,
        onclose,
    }: {
        check: InviteCheck;
        /** The graph's name from the sealed invite, when it could be read. */
        graphName?: string | null;
        /** The user confirmed: accept, against the fingerprint they were shown. */
        onconfirm: (fingerprint: string) => void;
        onclose: () => void;
    } = $props();

    let open = $state(true);
    const inviter = $derived(check.inviterEmail ?? "the owner");
    const graph = $derived(graphName ? `“${graphName}”` : "a shared graph");
    const fingerprintState = $derived(
        check.kind !== "signed"
            ? "unchecked"
            : check.pin.kind === "verified"
              ? "verified"
              : check.pin.kind === "changed"
                ? "changed"
                : "unchecked",
    );

    function confirm() {
        if (check.kind !== "signed") return;
        open = false;
        onconfirm(check.fingerprint);
    }

    function close() {
        open = false;
        onclose();
    }
</script>

<Modal {open} title="Accept invite" onclose={close} onsubmit={confirm}>
    {#snippet body()}
        {#if check.kind === "unsigned"}
            <p data-testid="accept-invite-unsigned" class="text-sm text-gray-600 dark:text-gray-400">
                This invite was sent by an older version of EtherPK, so it cannot be checked. Ask {inviter} to send
                it again.
            </p>
        {:else if check.kind === "unverifiable"}
            <p data-testid="accept-invite-unverifiable" role="alert" class="text-sm text-red-600 dark:text-red-400">
                This invite is not signed with {inviter}’s security key, so it may have been changed on the way. It
                cannot be accepted. Ask {inviter} to send it again.
            </p>
        {:else}
            <p class="text-sm text-gray-600 dark:text-gray-400">
                <span class="font-medium text-gray-900 dark:text-gray-200">{inviter}</span> invited you to {graph}.
                {#if fingerprintState === "unchecked"}
                    Before you accept, check that it really comes from them: compare the security fingerprint below
                    with the one {inviter} sees in Sync settings, as Your security fingerprint, in person or over a
                    call you trust.
                {/if}
            </p>
            <SecurityFingerprint fingerprint={check.fingerprint} state={fingerprintState} name={inviter} />
        {/if}
    {/snippet}

    {#snippet footer()}
        {#if check.kind === "signed"}
            <button
                type="button"
                onclick={close}
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                >Cancel</button
            >
            <button
                type="submit"
                data-testid="accept-invite-confirm"
                class="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                >{fingerprintState === "verified"
                    ? "Accept"
                    : fingerprintState === "changed"
                      ? "It matches, trust the new key"
                      : "Fingerprint matches, accept"}</button
            >
        {:else}
            <button
                type="button"
                onclick={close}
                data-testid="accept-invite-close"
                class="rounded-lg bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-800 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
                >Close</button
            >
        {/if}
    {/snippet}
</Modal>
