<script lang="ts">
    /**
     * Turns the address of a [[Plain Folder]] into a folder this device holds, and mounts its
     * workspace (ADR 0194).
     *
     * The address names a folder by its own name. This device may hold one folder of that name,
     * two (the person says which), or none (a link from another device, or a folder since
     * forgotten). The browser also asks again for a picked folder's access on each visit, which
     * needs a press, so that is asked here too before anything is read.
     *
     * Two folders with one name have one address, so moving from one to the other (a row of the
     * Graphs menu) changes only the chosen id the navigation carries. The gate answers that too.
     */
    import { THIS_PLACE_START } from '#lib/native/place.js'
    import { untrack } from 'svelte'

    import { goto } from '$app/navigation'

    import { type FolderHandle, isFolderLost, pickFolder } from '#lib/storage/folder-access.js'
    import { isPickerCancel } from '#lib/storage/fs/picker-cancel.js'
    import { tryEnsurePermission } from '#lib/storage/graph-registry-idb.js'
    import { describeChosenFolderFailure } from '#lib/workspace/folder-open-copy.js'
    import { LOST_PLAIN_FOLDER_NEXT, lostPlainFolder } from '#lib/workspace/lost-folder-copy.js'
    import { choiceDetail, foldersNamedHeading } from '#lib/workspace/graph-address-gate.js'

    import { chosenPlainFolderState, plainFolderUrl, resolvePlainAddress } from '../plain-address'
    import type { PlainFolderRecord } from '../plain-folder-registry'
    import { createIdbPlainFolderRegistry } from '../plain-folder-registry-idb'
    import { rechoosePlainFolder } from '../rechoose-plain-folder'
    import PlainFolderWorkspace from './PlainFolderWorkspace.svelte'

    let { name, chosenId = null, autosaveMs }: { name: string; chosenId?: string | null; autosaveMs?: number } = $props()

    type Gate =
        | { kind: 'reading' }
        | { kind: 'open'; folder: PlainFolderRecord }
        | { kind: 'needs-permission'; folder: PlainFolderRecord }
        /** An installed app can no longer reach the folder: it is chosen again. */
        | { kind: 'lost'; folder: PlainFolderRecord }
        | { kind: 'choose'; folders: PlainFolderRecord[] }
        | { kind: 'not-held' }
        | { kind: 'failed'; message: string }

    let gate = $state.raw<Gate>({ kind: 'reading' })
    let granting = $state(false)
    let grantError = $state<string | null>(null)

    /** Open `folder` if the browser already lets us, else ask for the press that lets it ask. */
    async function enter(folder: PlainFolderRecord): Promise<void> {
        // A press on a choice is newer than any reading still on its way.
        const mine = ++reading
        const lost = await isFolderLost(folder.handle)
        const allowed = !lost && (await tryEnsurePermission(folder.handle))
        if (mine !== reading) return
        if (lost) gate = { kind: 'lost', folder }
        else gate = allowed ? { kind: 'open', folder } : { kind: 'needs-permission', folder }
    }

    /** Goes up with each reading of the registry, so an answer overtaken by a later one is dropped. */
    let reading = 0

    /** Find the folder the address names, taking `chosen` where more than one has the name. */
    async function resolve(chosen: string | null): Promise<void> {
        const mine = ++reading
        try {
            const found = resolvePlainAddress(name, await createIdbPlainFolderRegistry().list())
            if (mine !== reading) return
            if (found.kind === 'not-held') gate = { kind: 'not-held' }
            else if (found.kind === 'held') await enter(found.folder)
            else {
                const folder = found.folders.find((held) => held.id === chosen)
                if (folder) await enter(folder)
                else gate = { kind: 'choose', folders: found.folders }
            }
        } catch (error) {
            if (mine === reading) gate = { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
        }
    }

    // Reads the registry (outside Svelte) when the component mounts and whenever a navigation
    // chooses another folder. A navigation that chooses none, or the folder already shown, such
    // as a move between two of its files, changes nothing.
    $effect(() => {
        const chosen = chosenId
        untrack(() => {
            if (gate.kind === 'reading' && reading === 0) void resolve(chosen)
            else if (chosen !== null && !('folder' in gate && gate.folder.id === chosen)) void resolve(chosen)
        })
    })

    async function grant(folder: PlainFolderRecord): Promise<void> {
        if (granting) return
        granting = true
        grantError = null
        try {
            if (await tryEnsurePermission(folder.handle)) gate = { kind: 'open', folder }
            else grantError = 'The browser did not grant access to the folder. Press Grant access and choose Allow.'
        } catch (error) {
            console.error('[plain-folder] could not ask for access to the folder', error)
            grantError = describeChosenFolderFailure(error)
        } finally {
            granting = false
        }
    }

    /** Choose folder: the folder chosen takes the lost one's place, and opens. */
    async function rechoose(lost: PlainFolderRecord): Promise<void> {
        if (granting) return
        granting = true
        grantError = null
        try {
            const outcome = await rechoosePlainFolder(lost, await pickFolder())
            if (outcome.kind === 'refused') grantError = outcome.message
            else if (outcome.folder.name === name) await enter(outcome.folder)
            else await goto(plainFolderUrl(outcome.folder.name), { replaceState: true, state: chosenPlainFolderState(outcome.folder) })
        } catch (error) {
            // Closing the picker is a choice, and nothing is said.
            if (isPickerCancel(error)) return
            console.error('[plain-folder] the folder chosen in place of a lost one could not be opened', error)
            grantError = describeChosenFolderFailure(error)
        } finally {
            granting = false
        }
    }
</script>

{#if gate.kind === 'open'}
    {#key gate.folder.id}
        <PlainFolderWorkspace id={gate.folder.id} name={gate.folder.name} handle={gate.folder.handle as FolderHandle} {autosaveMs} />
    {/key}
{:else}
    <div class="gate" data-testid="plain-folder-gate" data-gate={gate.kind}>
        {#if gate.kind === 'reading'}
            <p role="status">Opening {name}…</p>
        {:else if gate.kind === 'needs-permission'}
            {@const folder = gate.folder}
            <p>EtherPK needs permission to read and write the folder “{folder.name}”.</p>
            {#if grantError}
                <p role="alert" class="error" data-testid="plain-folder-grant-error">{grantError}</p>
            {/if}
            <div class="actions">
                <!-- aria-disabled, not disabled: a disabled button loses focus, and the handler ignores a second press. -->
                <button type="button" class="gk-button gk-button--primary" data-testid="plain-folder-grant" aria-disabled={granting} aria-busy={granting} onclick={() => grant(folder)}>
                    {granting ? 'Waiting for the browser…' : 'Grant access'}
                </button>
                <a class="gk-button" href="/graphs">Back to graphs</a>
            </div>
        {:else if gate.kind === 'lost'}
            {@const folder = gate.folder}
            <p data-testid="plain-folder-lost">{lostPlainFolder(folder.name)}</p>
            <p>{LOST_PLAIN_FOLDER_NEXT}</p>
            {#if grantError}
                <p role="alert" class="error" data-testid="plain-folder-grant-error">{grantError}</p>
            {/if}
            <div class="actions">
                <button type="button" class="gk-button gk-button--primary" data-testid="plain-folder-rechoose" aria-disabled={granting} aria-busy={granting} onclick={() => rechoose(folder)}>
                    {granting ? 'Waiting for the folder…' : 'Choose folder…'}
                </button>
                <a class="gk-button" href="/graphs">Back to graphs</a>
            </div>
        {:else if gate.kind === 'choose'}
            <!-- As many folders as are listed, each by when it was added: all that tells apart folders with one name. -->
            <p data-testid="plain-folder-choose">{foldersNamedHeading(gate.folders.length, name)}. Which one do you want to open?</p>
            <div class="actions">
                {#each gate.folders as folder (folder.id)}
                    <button type="button" class="gk-button" data-testid="plain-folder-choice" onclick={() => enter(folder)}>
                        {choiceDetail({ createdAt: folder.createdAt, path: null })}
                    </button>
                {/each}
            </div>
        {:else if gate.kind === 'not-held'}
            <p data-testid="plain-folder-not-held">{THIS_PLACE_START} has no Plain Folder named “{name}”. Open the folder from the Graphs page to add it.</p>
            <div class="actions"><a class="gk-button gk-button--primary" href="/graphs">Go to graphs</a></div>
        {:else}
            <p role="alert">Could not read this device’s folders: {gate.message}</p>
            <div class="actions"><a class="gk-button" href="/graphs">Back to graphs</a></div>
        {/if}
    </div>
{/if}

<style>
    .gate {
        position: fixed;
        inset: var(--workspace-top, 3.5rem) 0 0 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 1rem 1.25rem;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
        font-size: 0.875rem;
        line-height: 1.25rem;
    }
    .gate p {
        max-width: 36rem;
        margin: 0;
    }
    .error {
        color: var(--gk-text-danger);
    }
    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }
</style>
