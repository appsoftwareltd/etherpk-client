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
    import OpeningNotice from '#lib/components/OpeningNotice.svelte'
    import { SHELL_PATH } from '#lib/offline/app-shell.js'

    let failed = $state(false)

    onMount(() => {
        const target = location.pathname === SHELL_PATH ? '/graphs' : location.href
        goto(target, { replace: true }).catch((err: unknown) => {
            console.error('[shell] the address could not be opened', err)
            failed = true
        })
    })
</script>

<svelte:head><title>Opening EtherPK</title></svelte:head>

{#if failed}
    <div class="notice" data-testid="offline-shell-error" role="alert">
        <p>EtherPK could not open this page. The address may be wrong, or the page may have moved.</p>
        <button class="gk-button justify-self-center" onclick={() => goto('/graphs')}>Go to graphs</button>
    </div>
{:else}
    <OpeningNotice testid="offline-shell" />
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
</style>
