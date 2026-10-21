<script lang="ts">
    /**
     * The Install dialog, mounted once in the root layout and opened by every Install entry that
     * cannot open the browser's own dialog (`startInstall`): the steps for this platform, or
     * the browser's dialog button if an offer arrives while it is open.
     */
    import Modal from "@appsoftwareltd/etherpk-shared/dialog";
    import { PUBLIC_DOCS_URL } from "@appsoftwareltd/etherpk-shared";
    import InstallSteps from "./InstallSteps.svelte";
    import { installDialog } from "./install-state.svelte";
</script>

<Modal open={installDialog.open} title="Install EtherPK" testId="install-dialog" onclose={() => installDialog.close()}>
    {#snippet body()}
        <InstallSteps />
        <p class="mt-3 text-sm">
            <a
                href={`${PUBLIC_DOCS_URL}/installing-etherpk-as-an-app`}
                target="_blank"
                rel="noopener"
                class="text-(--gk-accent) underline hover:text-(--gk-accent-hover)">How installing works on each device</a
            >
        </p>
    {/snippet}
</Modal>
