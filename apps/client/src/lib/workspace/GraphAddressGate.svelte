<script lang="ts">
    /**
     * Between a workspace address and the workspace (ADR 0192): finds the graph a
     * [[Graph Address]] names in this browser, and where it holds none, asks for it.
     *
     * - A `/graph/folder/<name>` address this browser has not seen shows "Open the folder", and
     *   after the folder is chosen and registered, opens what the address names.
     * - Two registered folders with one name are offered as a choice, each time a link from
     *   outside EtherPK names them. A graph the person chose in EtherPK on the way here (the
     *   Graphs menu, the Graphs page) opens without the question: the history entry says which
     *   (chosen-graph.ts). The same holds for Back and Forward between the two.
     * - A `/graph/browser/<id>` address for a graph that is not here says so. Development makes
     *   the graph instead, which is how the test suite opens a graph without the folder picker.
     *
     * The decisions are graph-address-gate.ts; this component reads the registry and draws.
     */
    import { THIS_PLACE, THIS_PLACE_START } from '#lib/native/place.js'
    import { onDestroy, onMount } from 'svelte'

    import { dev } from '$app/env'
    import { afterNavigate, goto } from '$app/navigation'
    import { page } from '$app/state'

    import OpeningNotice from '#lib/components/OpeningNotice.svelte'
    import { peekPendingShare } from '#lib/document/share-target.js'
    import type { GraphAddress } from '#lib/navigation/graph-address.js'
    import { queueHistoryWrite } from '#lib/navigation/history-writes.js'
    import { readGraphFolderPath } from '#lib/storage/fs/folder-path.js'
    import { isPickerCancel } from '#lib/storage/fs/picker-cancel.js'
    import { canPickFolder, pickFolder } from '#lib/storage/folder-access.js'
    import type { GraphRecord } from '#lib/storage/graph-registry.js'
    import { createIdbGraphRegistry } from '#lib/storage/graph-registry-idb.js'

    import { chosenGraphState } from './chosen-graph'
    import { graphAccentFor } from './graph-accent.svelte.js'
    import { choiceDetail, foldersNamedHeading, gateFor, graphAskedFor, type GraphGate, graphIdsNamed, wrongFolderMessage } from './graph-address-gate'
    import { FOLDER_GRAPHS_NEED } from './graph-choice-panels'
    import GraphWorkspace from './GraphWorkspace.svelte'
    import { openChosenFolder } from './open-chosen-folder'
    import { setOpenGraphId } from './open-graph-id.svelte.js'

    type WorkspaceProps = Omit<import('svelte').ComponentProps<typeof GraphWorkspace>, 'graphId' | 'opfs' | 'graphAddress' | 'graphsAtAddress'>

    let { address, ...workspace }: { address: GraphAddress } & WorkspaceProps = $props()

    const registry = createIdbGraphRegistry()

    type Gate = GraphGate<GraphRecord> | { kind: 'reading' } | { kind: 'unreadable'; message: string }

    // A synced graph needs nothing read, so its workspace mounts in the first render as it did
    // before the gate existed. The component is keyed by the address, so this is read once.
    // svelte-ignore state_referenced_locally
    let gate = $state<Gate>(address.where === 'sync' ? gateFor(address, [], dev) : { kind: 'reading' })
    /**
     * The graphs the address names, as the registry last said. The workspace is told, so it can
     * tell a history entry of the other folder with this name from one of its own.
     */
    let named = $state.raw<string[]>([])
    let choosing = $state(false)
    let problem = $state<string | null>(null)

    let folderSupported = $state(true)
    /** A [[Share Target]] share is waiting for the graph this address names by id (ADR 0087). */
    let shareWaiting = $state(false)

    /** The graph this history entry says the person chose, or null (chosen-graph.ts). */
    const chosenId = () => page.state.etherpkGraph ?? null

    async function read() {
        try {
            const graphs = await registry.listGraphs()
            named = graphIdsNamed(address, graphs)
            // The entry is read after the registry, so a navigation that landed meanwhile is the one answered.
            gate = gateFor(address, graphs, dev, chosenId())
        } catch (error) {
            console.error('[graph-address] the graph list could not be read', error)
            gate = { kind: 'unreadable', message: `EtherPK could not read its list of graphs in ${THIS_PLACE}.` }
        }
    }

    // The registry is IndexedDB, and the folder picker is the browser's: both are read once
    // mounted, so a server render draws the same "reading" notice the browser starts from.
    onMount(() => {
        folderSupported = canPickFolder()
        shareWaiting = address.where === 'browser' && peekPendingShare()?.graphId === address.name
        if (gate.kind === 'reading') void read()
    })

    /**
     * A navigation that stays at this address can still name another graph: the other of two
     * folders with one name, from the Graphs menu, or by Back and Forward between them. The
     * layout keys this component by address, so it is not rebuilt, and the entry's graph is read
     * here. Only a graph the address names is opened, and an entry that names none changes
     * nothing: the graph that is open stays open.
     */
    afterNavigate((navigation) => {
        // A read in flight answers from the entry when it lands.
        if (address.where !== 'folder' || gate.kind === 'reading') return
        const asked = graphAskedFor(navigation, chosenId(), gate.kind === 'open' ? gate.graphId : null)
        if (asked !== null) void switchTo(asked)
    })

    let destroyed = false
    onDestroy(() => {
        destroyed = true
    })

    async function switchTo(chosen: string) {
        let next: Gate
        try {
            const graphs = await registry.listGraphs()
            named = graphIdsNamed(address, graphs)
            next = gateFor(address, graphs, dev, chosen)
        } catch (error) {
            // The graph that is open stays open: the registry said nothing about another.
            console.error('[graph-address] the graph list could not be read', error)
            return
        }
        // Still the entry's graph, and one the address names. Anything else leaves the gate as it is.
        if (next.kind === 'open' && next.graphId === chosen && chosenId() === chosen) gate = next
    }

    /**
     * Open the graph the person has just chosen here, and write the choice into this history
     * entry, so that Back to the entry from the other folder's graph opens this one again.
     */
    function openChosen(graph: { id: string }) {
        gate = { kind: 'open', graphId: graph.id, createInBrowser: false }
        void queueHistoryWrite(() => {
            // The write waits its turn, and by then the person may have left this graph or this
            // address: the entry in front is then another's, and is left as it is.
            if (destroyed || gate.kind !== 'open' || gate.graphId !== graph.id) return
            return goto(`${location.pathname}${location.search}${location.hash}`, {
                shallow: true,
                replace: true,
                state: { ...page.state, ...chosenGraphState(graph) },
            })
        })
    }

    // The header's Graphs menu marks the open graph, and an address cannot say which of two
    // folders with one name that is.
    $effect(() => {
        if (gate.kind === 'open') return setOpenGraphId(gate.graphId)
    })

    /** Choose folder…: the picker, the name check, then the registration the Graphs page does. */
    async function chooseFolder() {
        // Guarded here and not only by the button: a second press must not open a second picker.
        if (choosing) return
        choosing = true
        problem = null
        try {
            const handle = await pickFolder()
            const wrong = wrongFolderMessage(handle.name, address.name)
            if (wrong) {
                problem = wrong
                return
            }
            const outcome = await openChosenFolder(handle, registry)
            if (outcome.kind === 'refused') {
                problem = outcome.message
                return
            }
            // The folder just registered is one more graph this address names.
            named = [...new Set([...named, outcome.graph.id])]
            openChosen(outcome.graph)
        } catch (error) {
            // Closing the picker is a choice, not a failure.
            if (isPickerCancel(error)) return
            console.error('[graph-address] could not open the chosen folder', error)
            problem = `EtherPK could not open that folder. ${error instanceof Error ? error.message : ''}`.trim()
        } finally {
            choosing = false
        }
    }

    /**
     * What tells two folders with one name apart: the Graph Name, the graph's own colour where it
     * has one (as the Graphs menu shows it), and when it was added, after its path where known.
     */
    function describe(graph: GraphRecord): { name: string; detail: string; colour: string | null } {
        return {
            name: graph.name,
            detail: choiceDetail({ createdAt: graph.createdAt, path: readGraphFolderPath(graph.id) }),
            colour: graphAccentFor(graph.id, graph.toolbarColor),
        }
    }

    function focusOnShow(node: HTMLElement) {
        node.focus()
    }
</script>

{#if gate.kind === 'open'}
    <!-- Keyed by graph: the other of two folders with one name is another workspace at the same address. -->
    {#key gate.graphId}
        <GraphWorkspace graphId={gate.graphId} opfs={gate.createInBrowser} graphAddress={address} graphsAtAddress={named} {...workspace} />
    {/key}
{:else if gate.kind === 'reading'}
    <!-- The same notice, under the same test id, as the workspace's own while it opens: the
         registry read is the first part of opening the graph, and "no graph-loading on the page"
         is what says an open has finished. The workspace's notice takes this one's place in the
         same update, so there is no moment without one. -->
    <OpeningNotice testid="graph-loading" />
{:else if gate.kind === 'choose-folder'}
    <div class="notice" data-testid="graph-choose-folder">
        <h2 tabindex="-1" {@attach focusOnShow}>Open the folder “{address.name}”</h2>
        <p>
            This link opens a page in a graph folder on this device. {THIS_PLACE_START} has not opened that folder yet. Choose the
            “{address.name}” folder to give EtherPK permission to open it. EtherPK remembers the folder for any future links.
        </p>
        {#if problem}
            <p role="alert" class="notice__error" data-testid="graph-choose-folder-error">{problem}</p>
        {/if}
        {#if folderSupported}
            <div class="notice__actions">
                <!-- aria-disabled, not disabled: focus stays on the button while the picker is open. -->
                <button class="gk-button gk-button--primary" data-testid="graph-choose-folder-button" onclick={chooseFolder} aria-disabled={choosing} aria-busy={choosing}>
                    {choosing ? 'Waiting for the folder…' : 'Choose folder…'}
                </button>
                <button class="gk-button" data-testid="graph-choose-folder-back" onclick={() => goto('/graphs')}>Back to graphs</button>
            </div>
        {:else}
            <p data-testid="graph-choose-folder-unsupported">{FOLDER_GRAPHS_NEED}</p>
            <div class="notice__actions">
                <button class="gk-button" data-testid="graph-choose-folder-back" onclick={() => goto('/graphs')}>Back to graphs</button>
            </div>
        {/if}
    </div>
{:else if gate.kind === 'choose-graph'}
    <div class="notice" data-testid="graph-choose-graph">
        <h2 tabindex="-1" {@attach focusOnShow}>{foldersNamedHeading(gate.graphs.length, address.name)}</h2>
        <p>{THIS_PLACE_START} has opened more than one folder with that name. Choose the one this link is for.</p>
        <ul class="notice__choices">
            {#each gate.graphs as graph (graph.id)}
                {@const described = describe(graph)}
                <li>
                    <button data-own-button-style="a choice row of two lines, not a push button" data-testid="graph-choose-graph-option" onclick={() => openChosen(graph)}>
                        <!-- The graph's own colour, a person's choice (ADR 0179), as a mark beside its name. -->
                        {#if described.colour}
                            <span class="notice__choice-colour" data-testid="graph-choose-graph-colour" style:background={described.colour} aria-hidden="true"></span>
                        {/if}
                        <span class="notice__choice-name">{described.name}</span>
                        <span class="notice__choice-detail">{described.detail}</span>
                    </button>
                </li>
            {/each}
        </ul>
        <p class="notice__hint" data-testid="graph-choose-graph-hint">To tell them apart, give a graph its own name or colour in its settings.</p>
        <div class="notice__actions">
            <button class="gk-button" data-testid="graph-choose-graph-back" onclick={() => goto('/graphs')}>Back to graphs</button>
        </div>
    </div>
{:else}
    <div class="notice" data-testid="graph-not-in-browser" role="alert">
        <h2 tabindex="-1" {@attach focusOnShow}>That graph is not in {THIS_PLACE}</h2>
        <p>
            {gate.kind === 'unreadable'
                ? gate.message
                : 'This link is for a graph kept in one browser’s own storage, such as the demo. It cannot be opened from another browser or device.'}
        </p>
        <!-- A share stashed for this graph is in sessionStorage, not on this page, so the notice
             says it is safe and where to take it (rule 4 of the interaction standard). -->
        {#if shareWaiting}
            <p data-testid="share-waiting" class="notice__share">
                What you shared is still waiting. <a class="gk-link" href="/share" data-testid="share-choose-another">Choose another graph</a>
            </p>
        {/if}
        <div class="notice__actions">
            {#if gate.kind === 'unreadable'}
                <button class="gk-button" data-testid="graph-address-retry" onclick={read}>Try again</button>
            {/if}
            <button class="gk-button" data-testid="graph-not-in-browser-back" onclick={() => goto('/graphs')}>Back to graphs</button>
        </div>
    </div>
{/if}

<style>
    /* The same notice the workspace shows while it opens (WorkspaceOpenState.svelte). */
    .notice {
        position: fixed;
        inset: var(--workspace-top, 3.5rem) 0 0 0;
        display: grid;
        place-content: center;
        gap: 0.75rem;
        text-align: center;
        color: var(--gk-text-default);
        max-width: 32rem;
        margin: 0 auto;
        padding: 1rem;
    }
    .notice h2 {
        font-size: 1.05rem;
        font-weight: 600;
        margin: 0;
        overflow-wrap: anywhere;
    }
    .notice h2:focus {
        outline: none;
    }
    .notice p {
        margin: 0;
    }
    .notice__error {
        color: var(--gk-text-danger, #b91c1c);
        overflow-wrap: anywhere;
    }
    .notice__hint {
        color: var(--gk-text-muted);
    }
    .notice__share {
        color: var(--gk-text-subtle, #737373);
    }
    .notice__actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        justify-content: center;
    }
    .notice__choices {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 0.5rem;
    }
    /* A choice is a row of two lines, a name over its detail, drawn here in the control tokens:
       the actions under the list are the push buttons (`gk-button`). */
    .notice__choices button {
        display: grid;
        grid-template-columns: auto 1fr;
        align-items: center;
        gap: 0.125rem 0.625rem;
        width: 100%;
        min-height: 2.5rem;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--gk-control-border);
        border-radius: 0.5rem;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
    }
    .notice__choices button:hover {
        background: var(--gk-control-hover);
    }
    .notice__choices button:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
    .notice__choice-colour {
        grid-row: 1 / span 2;
        width: 0.875rem;
        height: 0.875rem;
        border-radius: 999px;
        border: 1px solid var(--gk-border-soft);
    }
    .notice__choice-name,
    .notice__choice-detail {
        grid-column: 2;
    }
    /* With no colour there is one column, and the text starts at the button's edge. */
    .notice__choices button:not(:has(.notice__choice-colour)) {
        grid-template-columns: 1fr;
    }
    .notice__choices button:not(:has(.notice__choice-colour)) > span {
        grid-column: 1;
    }
    .notice__choice-name {
        font-weight: 600;
    }
    .notice__choice-detail {
        color: var(--gk-text-muted);
        overflow-wrap: anywhere;
    }
</style>
