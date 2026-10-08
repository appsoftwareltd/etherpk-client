<script lang="ts">
    // Shared with the other applications; only the home it leads to differs.
    import { page } from "$app/state";
    import ErrorPage from "@appsoftwareltd/etherpk-shared/error-page";
</script>

<ErrorPage homeHref={page.data.deploymentHomeUrl} />
