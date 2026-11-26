<script lang="ts">
    import { THIS_PLACE } from '#lib/native/place.js'
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

    const SECONDARY_BUTTON = "gk-button";
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
            class="gk-button gk-button--danger disabled:cursor-progress"
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
            ? `This app signs out on this device and locks your Encryption Keys for it. Your EtherPK account stays signed in elsewhere and its graphs stay as they are. The copies ${THIS_PLACE} holds stay hidden until you sign in again.`
            : `This device forgets its address and access token, and locks your Encryption Keys for it. The token stays active until you revoke it on the server, and the copies ${THIS_PLACE} holds stay hidden until you add it again.`}
    </p>
{/if}
