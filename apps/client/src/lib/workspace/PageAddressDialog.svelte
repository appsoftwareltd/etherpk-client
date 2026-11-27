<script lang="ts">
    /**
     * Go to address…, where the workspace toolbar does not show the address: on a phone, and in a
     * browser tab, which has an address bar of its own. The same field and buttons as the toolbar's
     * (`PageAddressField.svelte`), with a label and a line on what it takes.
     */
    import Modal from '@appsoftwareltd/etherpk-shared/dialog'

    import PageAddressField from './PageAddressField.svelte'

    let { ongo, onclose }: { ongo: (path: string) => void; onclose: () => void } = $props()

    let field = $state<ReturnType<typeof PageAddressField>>()
</script>

<Modal open={true} title="Go to address" testId="page-address-dialog" {onclose}>
    {#snippet body()}
        <div class="gk-field">
            <label class="gk-label" for="page-address-dialog-input">Address of this page</label>
            <PageAddressField bind:this={field} id="page-address-dialog-input" label="Address of this page" inDialog {ongo} />
            <p class="gk-hint">Paste a web address, an EtherPK link or an agent instruction, then press Enter.</p>
        </div>
    {/snippet}
    {#snippet footer()}
        <button type="button" class="gk-button" onclick={onclose}>Cancel</button>
        <button type="button" class="gk-button gk-button--primary" data-testid="page-address-go" onclick={() => field?.submit()}>Go</button>
    {/snippet}
</Modal>
