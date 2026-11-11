<script lang="ts">
    /**
     * Forgetting one Sync Server on this device (ADR 0111): the button, then the question in place
     * with what forgetting does, since it locks the server's Encryption Keys here. On a server's
     * sub-tab of the Sync tab, and behind the disclosure of the Sync tab's sign-in, where a device
     * holds Managed Sync signed out. The Graphs page owns the action.
     */
    let {
        host,
        managed,
        confirming,
        forgetting,
        onbegin,
        oncancel,
        onforget,
    }: {
        host: string;
        managed: boolean;
        /** The question is showing. */
        confirming: boolean;
        /** The forget is in flight. */
        forgetting: boolean;
        onbegin: () => void;
        oncancel: () => void;
        onforget: () => void;
    } = $props();

    const SECONDARY_BUTTON =
        "inline-flex items-center justify-center rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 pointer-coarse:min-h-11 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5";
</script>

<div class="flex flex-wrap items-center gap-2">
    {#if confirming}
        <span class="text-sm text-neutral-700 dark:text-neutral-300"
            >Forget {host} on this device?</span
        >
        <button
            type="button"
            data-testid="sync-server-forget-confirm"
            disabled={forgetting}
            onclick={onforget}
            class="rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:border-red-500/40 dark:hover:bg-red-950/30"
            >{forgetting ? "Forgetting…" : "Forget"}</button
        >
        <button type="button" onclick={oncancel} class={SECONDARY_BUTTON}
            >Cancel</button
        >
    {:else}
        <button
            type="button"
            data-testid="sync-server-forget"
            onclick={onbegin}
            class={SECONDARY_BUTTON}>Forget this server</button
        >
    {/if}
</div>
{#if confirming}
    <p
        class="w-full text-sm text-neutral-500 dark:text-neutral-400"
        data-testid="sync-server-forget-consequence"
    >
        {managed
            ? "This app signs out on this device and locks your Encryption Keys for it. Your EtherPK account stays signed in elsewhere and its graphs stay as they are. The copies this browser holds stay hidden until you sign in again."
            : "This device forgets its address and access token, and locks your Encryption Keys for it. The token stays active until you revoke it on the server, and the copies this browser holds stay hidden until you add it again."}
    </p>
{/if}
