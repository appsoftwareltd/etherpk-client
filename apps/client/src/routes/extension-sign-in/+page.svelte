<script lang="ts">
    /**
     * The page every extension's sign-in returns to (ADR 0140, `$lib/extensions/sign-in.ts`). A
     * service sends the sign-in popup here with what it answered in the query or the fragment. The
     * page passes that on to the sign-in waiting in the Client over a BroadcastChannel, takes it out
     * of the address bar so it stays in no history entry, and closes the popup. Where the browser
     * will not let the page close itself, it says the window can be closed.
     */
    import { onMount } from 'svelte'
    import { afterNavigate, replaceState } from '$app/navigation'
    import { readReturnParameters, SIGN_IN_CHANNEL } from '$lib/extensions/sign-in'

    let outcome = $state<'passing' | 'done' | 'refused' | 'empty'>('passing')

    onMount(() => {
        const parameters = readReturnParameters(new URL(location.href))
        if (!parameters.state) {
            outcome = 'empty'
            return
        }
        const channel = new BroadcastChannel(SIGN_IN_CHANNEL)
        channel.postMessage({ parameters })
        channel.close()
        outcome = parameters.error ? 'refused' : 'done'
        window.close()
    })

    // SvelteKit's router counts as started only just after the first navigation's afterNavigate
    // callbacks (kit 2.70 `client.js`), and refuses replaceState before then. So the answer is
    // passed on in onMount, and taken out of the address bar a microtask after this callback.
    afterNavigate(() => {
        queueMicrotask(() => {
            if (location.search || location.hash) replaceState(location.pathname, {})
        })
    })
</script>

<svelte:head>
    <title>Sign-in - EtherPK</title>
    <meta name="robots" content="noindex" />
</svelte:head>

<main class="sign-in-return" data-testid="extension-sign-in" data-outcome={outcome}>
    {#if outcome === 'passing'}
        <p>Finishing the sign-in…</p>
    {:else if outcome === 'done'}
        <p>You're signed in. You can close this window.</p>
    {:else if outcome === 'refused'}
        <p>The sign-in wasn't completed. You can close this window and try again in EtherPK.</p>
    {:else}
        <p>This page finishes a sign-in started in EtherPK. There's nothing to do here.</p>
    {/if}
</main>

<style>
    .sign-in-return {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1.5rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-family: var(--gk-sans);
        font-size: 1rem;
        text-align: center;
    }
</style>
