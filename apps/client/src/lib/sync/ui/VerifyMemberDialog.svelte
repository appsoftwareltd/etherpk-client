<script lang="ts">
    /**
     * Verify a member of a graph the user owns (ADR 0126): compare their Security Fingerprint out of
     * band, and pin it once it matches. A member who joined before pins existed is listed as
     * Unverified until this is done, and one whose key has changed since it was pinned is listed
     * as Key changed.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { describeSyncFailure } from "#lib/sync/sync-error-copy.js";
    import SecurityFingerprint from "./SecurityFingerprint.svelte";

    let {
        email,
        fingerprint,
        changed = false,
        onconfirm,
        onclose,
    }: {
        email: string;
        fingerprint: string;
        /** The server presents a key other than the one pinned for them. */
        changed?: boolean;
        /** Pin the fingerprint shown. The dialog stays open, and says why, if this fails. */
        onconfirm: () => Promise<void>;
        onclose: (verified: boolean) => void;
    } = $props();

    let open = $state(true);
    let busy = $state(false);
    let error = $state<string | null>(null);

    async function confirm() {
        if (busy) return;
        busy = true;
        error = null;
        try {
            await onconfirm();
            open = false;
            onclose(true);
        } catch (e) {
            error = describeSyncFailure(e, "save the verified fingerprint");
        } finally {
            busy = false;
        }
    }

    function close() {
        open = false;
        onclose(false);
    }
</script>

<Modal {open} title="Verify {email}" {busy} busyReason="Saving…" onclose={close} onsubmit={confirm}>
    {#snippet body()}
        {#if !changed}
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
                Compare the security fingerprint below with the one {email} sees in Sync settings, as Your security
                fingerprint, in person or over a call you trust. Once it matches, EtherPK remembers it and warns you
                if their key ever changes.
            </p>
        {/if}
        <SecurityFingerprint {fingerprint} state={changed ? "changed" : "unchecked"} name={email} />
        {#if error}
            <p role="alert" data-testid="verify-member-error" class="text-sm text-red-600 dark:text-red-400">{error}</p>
        {/if}
    {/snippet}

    {#snippet footer()}
        <button
            type="button"
            onclick={close}
            class="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
            >Cancel</button
        >
        <button
            type="submit"
            disabled={busy}
            data-testid="verify-member-confirm"
            class="min-w-52 rounded-lg bg-neutral-900 px-4 py-1.5 text-center text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            >{busy ? "Saving…" : changed ? "It matches, trust the new key" : "Fingerprint matches"}</button
        >
    {/snippet}
</Modal>
