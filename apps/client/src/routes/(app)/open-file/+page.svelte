<script lang="ts">
    /**
     * `/open-file`: a markdown file opened from the device's file manager (the manifest's
     * `file_handlers`), shown on its own.
     *
     * The browser hands over the one file and no folder, so the file can be edited and saved and
     * nothing beside it reached. **Open the folder** asks for the folder it is in, adds it as a
     * [[Plain Folder]] and goes to the same file there, where its pictures and links work.
     */
    import { goto } from '$app/navigation'

    import { showNotice } from '#lib/activity/notices.js'
    import { readKnownGraphFolders } from '#lib/storage/folder-ownership.js'
    import { isPickerCancel } from '#lib/storage/fs/picker-cancel.js'
    import { pickGraphDirectory } from '#lib/storage/fs/web-fs-adapter.js'
    import { appHeaderHiddenOnPhone } from '#lib/workspace/app-header.svelte.js'
    import { examineChosenFolder, registerPlainFolder } from '#lib/plain/choose-folder.js'
    import { pathInFolder } from '#lib/plain/launched-file.js'
    import { launchedFile } from '#lib/plain/launched-file.svelte.js'
    import { chosenPlainFolderState, plainFileUrl } from '#lib/plain/plain-address.js'
    import { createIdbPlainFolderRegistry } from '#lib/plain/plain-folder-registry-idb.js'
    import PlainFolderWorkspace from '#lib/plain/ui/PlainFolderWorkspace.svelte'
    import { createWebTreeAdapter } from '#lib/plain/web-tree-adapter.js'

    const file = $derived(launchedFile.current)
    let busy = $state(false)
    /** Said where the app says everything else that went wrong, so it is read wherever the person is looking. */
    const say = (text: string) => showNotice({ id: 'open-file', tone: 'error', text })

    /** Ask for the folder the file is in, and go to the file there. */
    async function openItsFolder(): Promise<void> {
        const opened = file
        if (!opened || busy) return
        busy = true
        try {
            const folder = await pickGraphDirectory()
            const path = await pathInFolder(folder, opened)
            if (path === null) {
                say(`That folder does not hold ${opened.name}. Choose the folder the file is in, or one above it.`)
                return
            }
            const registry = createIdbPlainFolderRegistry()
            const chosen = await examineChosenFolder(folder, { plainFolders: () => registry.list(), knownFolders: () => readKnownGraphFolders(), treeOf: createWebTreeAdapter })
            if (chosen.kind === 'refused') say(chosen.message)
            else if (chosen.kind === 'folder-graph') say(`${folder.name} is an EtherPK graph. Open it from the Graphs page, and its pages open there.`)
            else {
                const held = chosen.kind === 'plain-folder' ? chosen.folder : await registerPlainFolder(folder, registry, () => crypto.randomUUID(), Date.now)
                launchedFile.set(null)
                await goto(plainFileUrl(held.name, path), { state: chosenPlainFolderState(held) })
            }
        } catch (error) {
            // Closing the picker is a choice: nothing is said.
            if (!isPickerCancel(error)) say(`The folder could not be opened (${error instanceof Error ? error.message : String(error)}).`)
        } finally {
            busy = false
        }
    }
</script>

<svelte:head><title>{file ? file.name : 'Open a file'} - EtherPK</title></svelte:head>

{#if file}
    {#key file}
        <div class={['workspace-host', { 'no-header-on-phone': appHeaderHiddenOnPhone.current }]}>
            <PlainFolderWorkspace id={`file:${file.name}`} name={file.name} {file} onopenfolder={() => void openItsFolder()} />
        </div>
    {/key}
{:else}
    <div class="none" data-testid="open-file-none">
        <p>No file is open here. A file opened from your device’s file manager is shown on this page, once: a reload has no file to show.</p>
        <p><a class="gk-button gk-button--primary" href="/graphs">Go to graphs</a></p>
    </div>
{/if}

<style>
    .workspace-host {
        --workspace-top: 3.5rem;
    }
    @media not all and (min-width: 1024px) {
        .workspace-host.no-header-on-phone {
            --workspace-top: 0px;
        }
    }
    .none {
        padding: 5rem 1.25rem 1rem;
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .none p {
        max-width: 40rem;
        margin: 0 0 0.75rem;
    }
</style>
