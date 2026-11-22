<script lang="ts">
    /**
     * The route of a [[Plain Folder]]: `/folder/[name]` and `/folder/[name]/f/[...path]` share this
     * one workspace mount, so moving between files never remounts the Layout (ADR 0194). Keyed by
     * the folder's name: another folder builds its own workspace.
     */
    import type { Snippet } from 'svelte'

    import { page } from '$app/state'

    import PlainFolderGate from '#lib/plain/ui/PlainFolderGate.svelte'
    import { appHeaderHiddenOnPhone } from '#lib/workspace/app-header.svelte.js'

    import type { LayoutData } from './$types'

    let { data, children }: { data: LayoutData; children: Snippet } = $props()

    /** Which of two folders with one name was chosen, carried in the history entry as a graph's is. */
    const chosenId = $derived((page.state as { etherpkPlainFolder?: string }).etherpkPlainFolder ?? null)
</script>

{#key data.name}
    <div class={['workspace-host', { 'no-header-on-phone': appHeaderHiddenOnPhone.current }]}>
        <PlainFolderGate name={data.name} {chosenId} autosaveMs={data.autosaveMs} />
    </div>
{/key}
{@render children()}

<style>
    .workspace-host {
        --workspace-top: 3.5rem;
    }
    /* The app layout hides its header on a phone under the same query, so the workspace moves into the room. */
    @media not all and (min-width: 1024px) {
        .workspace-host.no-header-on-phone {
            --workspace-top: 0px;
        }
    }
</style>
