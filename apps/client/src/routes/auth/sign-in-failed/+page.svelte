<script lang="ts">
    import ErrorCard from "@appsoftwareltd/etherpk-shared/error-card";

    let { data } = $props();
</script>

<svelte:head>
    <title>{data.title} - EtherPK</title>
</svelte:head>

<ErrorCard brandHref={data.deploymentHomeUrl} themePreference={data.themePreference ?? "system"}>
    <h1 class="text-lg font-semibold text-neutral-950 text-center">{data.title}</h1>
    <p class="mt-2 text-sm text-neutral-500 dark:text-neutral-400 text-center" data-testid="sign-in-failed-detail">{data.detail}</p>

    <div class="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <!-- /auth/login is a server redirect into Corporate, never a client-side route. -->
        <a
            href={data.signInHref}
            data-sveltekit-reload
            class="gk-button gk-button--primary"
        >
            Sign in again
        </a>
        <a
            href="/graphs"
            class="gk-button"
        >
            Open your graphs
        </a>
    </div>
</ErrorCard>
