<script lang="ts">
    /**
     * A sign-out started on the account site or the Sync portal passes through here, the one place
     * it can reach this browser's Client storage: the access token in memory goes, Managed Sync's
     * Encryption Keys lock, the account record clears and every open Client tab is told. Then the
     * sign-out carries on, usually at once. A Continue link appears only if the page is still here
     * after a few seconds; without script it is there from the start, and the keys are left for
     * the next Client page to lock.
     */
    import { onMount } from "svelte";
    import { endManagedSessionInThisBrowser } from "$lib/sync/managed-sign-out";
    import type { PageProps } from "./$types";

    let { data }: PageProps = $props();

    /** The next step has not loaded after a few seconds: offer a way on by hand. */
    let slow = $state(false);

    onMount(() => {
        endManagedSessionInThisBrowser();
        window.location.replace(data.next);
        const timer = setTimeout(() => (slow = true), 3000);
        return () => clearTimeout(timer);
    });
</script>

<svelte:head><title>Signing out · EtherPK</title></svelte:head>

<main class="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
    <!-- Turns only where the device allows motion; the words say what is happening either way. -->
    <svg
        class="h-8 w-8 text-gray-500 motion-safe:animate-spin dark:text-gray-400"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
    >
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-opacity="0.25" />
        <path fill="currentColor" d="M4 12a8 8 0 0 1 8-8v3a5 5 0 0 0-5 5H4z" />
    </svg>
    <p class="mt-5 text-lg font-medium text-gray-900 dark:text-gray-100" role="status">
        Signing you out of EtherPK…
    </p>
    {#if slow}
        <p class="mt-3 text-sm text-gray-600 dark:text-gray-400">
            This is taking longer than usual.
            <a href={data.next} class="font-medium text-gray-900 underline dark:text-gray-100">Continue</a>
        </p>
    {/if}
    <noscript>
        <a href={data.next} class="mt-3 inline-block text-sm font-medium text-gray-900 underline dark:text-gray-100">Continue</a>
    </noscript>
</main>
