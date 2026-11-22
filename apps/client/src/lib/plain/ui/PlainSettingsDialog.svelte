<script lang="ts">
    /**
     * The settings of a [[Plain Folder]]: the few that shape files other people see, kept in the
     * folder's hidden `.etherpk` folder (plain-settings.ts). A change is saved when it is made.
     */
    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import type { AssetPlacement } from '../plain-assets'

    let {
        folderName,
        pastedFiles,
        onpastedfiles,
        onclose,
    }: {
        folderName: string
        pastedFiles: AssetPlacement
        /** Rejects with the reason when the setting could not be kept. */
        onpastedfiles: (placement: AssetPlacement) => Promise<void>
        onclose: () => void
    } = $props()

    let saving = $state(false)
    let error = $state('')

    const EXAMPLES: Record<AssetPlacement, string> = {
        assets: 'guide/assets/bed.png',
        beside: 'guide/bed.png',
        named: 'guide/watering.assets/bed.png',
    }

    async function choose(placement: AssetPlacement): Promise<void> {
        if (saving || placement === pastedFiles) return
        saving = true
        error = ''
        try {
            await onpastedfiles(placement)
        } catch (failure) {
            error = `That could not be saved to the folder (${failure instanceof Error ? failure.message : String(failure)}). The setting is as it was.`
        } finally {
            saving = false
        }
    }
</script>

<Dialog open title={`Settings for ${folderName}`} testId="plain-settings" size="md" {onclose}>
    {#snippet body()}
        <div class="gk-field">
            <label class="gk-label" for="plain-settings-pasted">Where pasted files go</label>
            <select
                id="plain-settings-pasted"
                class="gk-select"
                value={pastedFiles}
                disabled={saving}
                aria-invalid={error !== ''}
                aria-describedby="plain-settings-pasted-hint"
                data-testid="plain-settings-pasted"
                onchange={(event) => void choose(event.currentTarget.value as AssetPlacement)}
            >
                <option value="assets">An assets folder beside the document</option>
                <option value="beside">The same folder as the document</option>
                <option value="named">A folder named after the document</option>
            </select>
            <p class="gk-hint" id="plain-settings-pasted-hint">
                A picture pasted into guide/watering.md is saved as {EXAMPLES[pastedFiles]}. This is kept in the folder’s hidden .etherpk folder, so everyone who opens the folder gets the same.
            </p>
            {#if error}<p class="gk-error" role="alert">{error}</p>{/if}
        </div>
    {/snippet}
</Dialog>
