<script lang="ts">
    import ErrorCard from "../components/ErrorCard.svelte";

    let {
        data,
        signInUrl,
    }: {
        data: { errorCode: string; message: string; themePreference?: string };
        /** Where "Back to sign in" points. The Server may hand off to its configured issuer. */
        signInUrl: string;
    } = $props();
</script>

<svelte:head>
    <title>Authentication Error - EtherPK</title>
</svelte:head>

<ErrorCard themePreference={data.themePreference}>
    <!-- Warning icon -->
    <div class="flex justify-center mb-4">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 ring-1 ring-red-600/20">
            <svg class="h-6 w-6 text-red-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
        </div>
    </div>

    <h1 class="text-lg font-semibold text-gray-950 text-center">Sign-in failed</h1>
    <p class="mt-2 text-sm text-gray-500 text-center">{data.message}</p>

    <div class="mt-6 flex flex-col gap-2">
        <a href={signInUrl} class="flex w-full items-center justify-center rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors"> Back to sign in </a>
        <a href="/home" class="flex w-full items-center justify-center rounded-lg border border-gray-950/15 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"> Go to home </a>
    </div>
</ErrorCard>
