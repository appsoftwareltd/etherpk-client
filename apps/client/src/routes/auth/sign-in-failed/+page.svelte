<script lang="ts">
    import ErrorCard from "@appsoftwareltd/etherpk-shared/error-card";

    let { data } = $props();
</script>

<svelte:head>
    <title>{data.title} - EtherPK</title>
</svelte:head>

<ErrorCard themePreference={data.themePreference ?? "system"}>
    <h1 class="text-lg font-semibold text-gray-950 text-center">{data.title}</h1>
    <p class="mt-2 text-sm text-gray-500 text-center" data-testid="sign-in-failed-detail">{data.detail}</p>

    <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <!-- /auth/login is a server redirect into Corporate, never a client-side route. -->
        <a
            href={data.signInHref}
            data-sveltekit-reload
            class="rounded-lg bg-gray-950 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-gray-700 dark:bg-white/20 dark:hover:bg-white/25 transition-colors"
        >
            Sign in again
        </a>
        <a
            href="/graphs"
            class="rounded-lg border border-gray-950/15 bg-white px-4 py-2.5 text-center text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
            Open your graphs
        </a>
    </div>
</ErrorCard>
