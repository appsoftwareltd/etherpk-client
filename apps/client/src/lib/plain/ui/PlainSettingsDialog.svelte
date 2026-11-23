<script lang="ts">
    /**
     * The settings of a [[Plain Folder]]: the person's own under **General**, kept with their
     * settings, and under **This folder** the few that shape files other people see, kept in the
     * folder's hidden `.etherpk` folder (plain-settings.ts). A change is saved when it is made.
     */
    import Dialog from '@appsoftwareltd/etherpk-shared/dialog'

    import PrimarySidebarSetting from '#lib/layout/renderers/PrimarySidebarSetting.svelte'
    import ResetWorkspaceSetting from '#lib/layout/renderers/ResetWorkspaceSetting.svelte'

    import type { AssetPlacement } from '../plain-assets'
    import DefaultFileEditorSetting from './DefaultFileEditorSetting.svelte'

    let {
        folderName,
        pastedFiles,
        onpastedfiles,
        onresetworkspace,
        onclose,
    }: {
        folderName: string
        pastedFiles: AssetPlacement
        /** Rejects with the reason when the setting could not be kept. */
        onpastedfiles: (placement: AssetPlacement) => Promise<void>
        /** Reset workspace, already confirmed. */
        onresetworkspace: () => void
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
        <div class="space-y-6">
            <!-- The person's own, not the folder's: kept with their settings, not in `.etherpk` (ADR 0199, ADR 0204). -->
            <section class="space-y-4" aria-labelledby="plain-settings-general" data-testid="plain-settings-general">
                <h3 class="text-base font-semibold text-(--gk-text-strong)" id="plain-settings-general">General</h3>
                <DefaultFileEditorSetting />
                <PrimarySidebarSetting />
                <ResetWorkspaceSetting onreset={onresetworkspace} />
            </section>
            <section class="space-y-4" aria-labelledby="plain-settings-folder">
                <h3 class="text-base font-semibold text-(--gk-text-strong)" id="plain-settings-folder">This folder</h3>
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
                        A picture pasted into guide/watering.md is saved as {EXAMPLES[pastedFiles]}. This setting is kept in the folder’s hidden .etherpk folder.
                    </p>
                    {#if error}<p class="gk-error" role="alert">{error}</p>{/if}
                </div>
            </section>
        </div>
    {/snippet}
</Dialog>
