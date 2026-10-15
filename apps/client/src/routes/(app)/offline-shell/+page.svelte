<script lang="ts">
    /**
     * The shell (ADR 0142): the page the service worker keeps, and serves for an app page it
     * cannot fetch, so a reload or a cold start with no network still opens the app.
     *
     * The server renders it like any page, so it carries the root and `(app)` layouts' data, and
     * it hydrates as itself at whatever address it was served for. It then hands that address to
     * the router, which loads the real route in the browser. Those layouts' data depends on
     * nothing in the address, so the router does not ask the server for it again. Opened at its
     * own address, it goes to the Graphs page.
     */
    import { onMount } from 'svelte'

    import { goto } from '$app/navigation'
    import { SHELL_PATH } from '$lib/offline/app-shell'

    let message = $state('')

    onMount(() => {
        const target = location.pathname === SHELL_PATH ? '/graphs' : location.href
        goto(target, { replaceState: true }).catch((err: unknown) => {
            message = err instanceof Error ? err.message : String(err)
        })
    })
</script>

<svelte:head><title>Opening EtherPK</title></svelte:head>

{#if message}
    <div class="notice" data-testid="offline-shell-error" role="alert">
        <p>Could not open this page: {message}</p>
        <button onclick={() => goto('/graphs')}>Go to graphs</button>
    </div>
{:else}
    <div class="notice" data-testid="offline-shell" role="status"><p>Opening your notes…</p></div>
{/if}

<style>
    .notice {
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        place-content: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--gk-text-default);
    }
    .notice button {
        border: 1px solid var(--gk-border-soft);
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        background: var(--gk-surface-1);
        color: inherit;
        cursor: pointer;
        font: inherit;
    }
</style>
