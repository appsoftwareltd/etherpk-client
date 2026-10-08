<script lang="ts">
    /**
     * A Security Fingerprint to compare, with what this account's pins say about it (ADR 0126):
     * verified before and unchanged, not compared yet, or different from the key compared before.
     * The invite, accept and verify dialogs each say what the comparison is for; this renders the
     * part they share, so the fingerprint and the key-changed warning look the same everywhere.
     */
    let {
        fingerprint,
        state,
        name,
    }: {
        fingerprint: string;
        /** `changed`: the server presents keys other than the pinned ones. */
        state: "verified" | "unchecked" | "changed";
        /** Whose fingerprint it is: an address, or "the owner" when the server gave none. */
        name: string;
    } = $props();
</script>

{#if state === "changed"}
    <div
        role="alert"
        data-testid="fingerprint-changed"
        class="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-400/30 dark:bg-amber-400/10"
    >
        <p class="text-sm font-medium text-amber-900 dark:text-amber-100">{name}’s security key has changed</p>
        <p class="mt-1 text-sm text-amber-900 dark:text-amber-100">
            The key the server gives for {name} is not the one you checked before. They may have replaced their
            Encryption Keys, or someone may be trying to read what you share. Compare the new fingerprint below with theirs,
            in person or over a call you trust.
        </p>
    </div>
{:else if state === "verified"}
    <p data-testid="fingerprint-verified" class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
        <span
            class="rounded-full bg-emerald-50 px-2 py-0.5 text-sm font-medium text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200"
            >Verified</span
        >
        You checked {name}’s fingerprint before, and their key has not changed.
    </p>
{/if}
<code
    data-testid="security-fingerprint"
    class="block break-all rounded-lg bg-gray-100 px-4 py-3 text-center font-mono text-sm tracking-wide text-gray-950 dark:bg-white/5 dark:text-gray-100"
    >{fingerprint}</code
>
