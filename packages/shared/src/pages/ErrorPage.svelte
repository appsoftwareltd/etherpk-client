<script lang="ts">
    import { page } from "$app/stores";
    import ErrorCard from "../components/ErrorCard.svelte";
</script>

<svelte:head>
    <title>Error {$page.status} - EtherPK</title>
</svelte:head>

<ErrorCard themePreference={$page.data.themePreference ?? "system"}>
    <p class="text-4xl font-bold text-gray-950 tabular-nums text-center">{$page.status}</p>
    <h1 class="mt-3 text-lg font-semibold text-gray-950 text-center">
        {$page.status === 404 ? "Page not found" : $page.status === 403 ? "Access denied" : "Something went wrong"}
    </h1>
    <p class="mt-2 text-sm text-gray-500 text-center">
        {$page.error?.message ?? "An unexpected error occurred. Please try again."}
    </p>

    <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <a href="/home" class="rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors"> Go to home </a>
        <button onclick={() => history.back()} class="rounded-lg border border-gray-950/15 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"> Go back </button>
    </div>
</ErrorCard>
