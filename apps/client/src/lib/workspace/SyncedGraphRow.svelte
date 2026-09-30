<script lang="ts">
    /**
     * One synced graph on the Graphs page: what the server says about it (the role, the members,
     * the storage) and what this device holds of it, in one row. The two used to be separate lists,
     * "Graphs on this device" and "Synced graphs", so a graph on this device appeared twice, with
     * Open and Rename on one row and Invite and Delete on the other.
     *
     * The row renders what it is given and reports clicks; the Graphs page owns every action. A row
     * the server has not listed (offline, or the list failed) has no role and offers only what this
     * device can do on its own.
     */
    import { PUBLIC_DOCS_URL, formatBytes } from '@appsoftwareltd/etherpk-shared'
    import type { SyncedMember } from './graph-picker-helpers'
    import { OPEN_BUTTON, OPEN_ICON } from './graphs-page-icons'

    let {
        graphId,
        name,
        role,
        onDevice,
        readOnly = false,
        importInterrupted = false,
        storage = null,
        nameNote = null,
        members,
        message = null,
        canInvite = false,
        checking = false,
        cancellingInvite = null,
        onopen,
        onadd,
        onrename,
        onsettings,
        onforget,
        oninvite,
        ontransfer,
        ondelete,
        onleave,
        oncancelinvite,
    }: {
        graphId: string
        name: string
        /** The account's role, from the server's list; null when the list is not to hand. */
        role: string | null
        /** A copy of the graph is registered in this browser. */
        onDevice: boolean
        /** An owned graph the owner's plan does not let anyone write to. */
        readOnly?: boolean
        importInterrupted?: boolean
        storage?: { docBytes: number; assetBytes: number } | null
        /** Why the row carries the id placeholder rather than a name, when it does. */
        nameNote?: string | null
        /** Members and invitees, for an owner; null when the list could not be read; undefined for a Player. */
        members?: SyncedMember[] | null
        message?: { text: string; tone: 'info' | 'error' } | null
        /** The server accepts new Players on this graph. */
        canInvite?: boolean
        /** A check before a destructive action is running for this row. */
        checking?: boolean
        /** The invite whose cancellation is in flight. */
        cancellingInvite?: string | null
        onopen: () => void
        onadd: () => void
        onrename: () => void
        onsettings: () => void
        onforget: () => void
        oninvite: () => void
        ontransfer: () => void
        ondelete: () => void
        onleave: () => void
        oncancelinvite: (member: SyncedMember) => void
    } = $props()

    const owner = $derived(role === 'owner')
    const activePlayers = $derived((members ?? []).some((m) => m.role === 'player' && m.status !== 'invited'))

    const TEXT_BUTTON =
        'shrink-0 rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 pointer-coarse:min-h-11 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-white/5'
    const DANGER_BUTTON =
        'shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:border-red-500/40 dark:hover:bg-red-950/30'
    const ICON_BUTTON =
        'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-200'
</script>

{#snippet badges()}
    <span class="truncate text-sm font-medium text-gray-950 dark:text-white">{name}</span>
    {#if role}
        <span
            data-testid="synced-role"
            class="rounded-full px-2 py-0.5 text-sm {owner
                ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                : 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-gray-400'}">{owner ? 'Owner' : 'Player'}</span
        >
    {/if}
    {#if importInterrupted}
        <span
            data-testid="synced-import-interrupted"
            class="rounded-full bg-amber-50 px-2 py-0.5 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
            >Import interrupted</span
        >
    {/if}
    {#if readOnly}
        <span
            data-testid="synced-read-only"
            class="rounded-full bg-amber-50 px-2 py-0.5 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
            >Read-only</span
        >
    {/if}
{/snippet}

<li data-testid="synced-graph" data-graph-id={graphId} data-on-device={onDevice} class="space-y-2 px-4 py-3">
    {#if message}
        <p
            data-testid="synced-graph-status"
            role={message.tone === 'error' ? 'alert' : 'status'}
            class="text-sm {message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}"
        >
            {message.text}
        </p>
    {/if}

    <div class="flex items-center gap-2">
        {#if onDevice}
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex min-w-0 flex-wrap items-center gap-2">{@render badges()}</span>
                <span
                    class="truncate text-sm text-gray-500 dark:text-gray-400"
                    data-testid="graphs-cache-hint"
                    title="A synced graph's copy lives in browser storage, not a folder">On this device</span
                >
            </div>
            <button data-testid="graphs-open" aria-label={`Open ${name}`} onclick={onopen} class={OPEN_BUTTON}>
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d={OPEN_ICON} />
                </svg>
                Open
            </button>
            <button
                data-testid="graphs-rename"
                title="Rename (changes the graph name for all members)"
                aria-label="Rename graph"
                onclick={onrename}
                class={ICON_BUTTON}
            >
                <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125" />
                </svg>
            </button>
            <button
                data-testid="graphs-synced-settings"
                title="Graph settings (shared by all members)"
                aria-label="Graph settings"
                onclick={onsettings}
                class={ICON_BUTTON}
            >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>
        {:else}
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="flex min-w-0 flex-wrap items-center gap-2">{@render badges()}</span>
                <span class="text-sm text-gray-500 dark:text-gray-400" data-testid="synced-not-local">Not on this device</span>
            </div>
            <button data-testid="graphs-add-device" onclick={onadd} class={TEXT_BUTTON}>Add to this device</button>
        {/if}
    </div>

    {#if nameNote}
        <!-- The row could not be labelled yet. Say why and what changes it; the line must never
             read as a key failure: "Encrypted name" once sent a user towards Reset (2026-09-01). -->
        <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="synced-name-encrypted" aria-live="polite">{nameNote}</p>
    {/if}

    <p class="flex flex-wrap gap-x-3 text-sm text-gray-500 dark:text-gray-400">
        {#if storage}
            <span data-testid="synced-storage">{formatBytes(storage.docBytes)} notes · {formatBytes(storage.assetBytes)} assets</span>
        {/if}
        <span class="truncate font-mono select-all" data-testid="synced-id">{graphId}</span>
    </p>

    {#if owner && members !== undefined}
        {#if members}
            <ul data-testid="synced-members" class="space-y-1 border-t border-gray-100 pt-2 dark:border-white/10">
                {#each members as m (m.userId)}
                    <li data-testid="synced-member" data-status={m.status ?? 'active'} class="flex items-center gap-2 text-sm">
                        <span class="truncate text-gray-700 dark:text-gray-300">{m.email}</span>
                        <span class="rounded-full bg-gray-100 px-2 py-0.5 text-sm text-gray-600 dark:bg-white/10 dark:text-gray-400">
                            {m.role === 'owner' ? 'Owner' : m.status === 'invited' ? 'Invited' : 'Player'}
                        </span>
                        {#if m.status === 'invited' && m.inviteId}
                            <button
                                data-testid="member-cancel-invite"
                                disabled={cancellingInvite === m.inviteId}
                                onclick={() => oncancelinvite(m)}
                                class="ml-auto shrink-0 rounded-lg px-2 py-1 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-950 disabled:cursor-progress dark:text-gray-400 dark:hover:bg-white/5 dark:hover:text-white"
                                >{cancellingInvite === m.inviteId ? 'Cancelling…' : 'Cancel invite'}</button
                            >
                        {/if}
                    </li>
                {/each}
            </ul>
            <!-- Removing a player is not built yet (it needs the graph's key rotated), and the row
                 offers no control for it. -->
            {#if activePlayers}
                <p data-testid="synced-members-removal-note" class="text-sm text-gray-500 dark:text-gray-400">
                    You can't remove a player yet. Ask them to leave, or transfer or delete the graph.
                    <a
                        href={`${PUBLIC_DOCS_URL}/sharing-a-graph`}
                        class="font-medium text-gray-700 underline underline-offset-2 hover:text-gray-950 dark:text-gray-300 dark:hover:text-white"
                        >Sharing a graph</a
                    >
                </p>
            {/if}
        {:else}
            <p class="border-t border-gray-100 pt-2 text-sm text-gray-500 dark:border-white/10 dark:text-gray-400">
                Could not load the member list.
            </p>
        {/if}
    {/if}

    {#if role || onDevice}
        <div class="flex flex-wrap gap-2">
            {#if owner}
                <!-- The Server refuses new Players on a read-only owner's graph (quota policy), so
                     Invite is not offered; the plan notice says why. Transfer stays: it checks the
                     recipient's allowance, and is one way to keep the graph writable. -->
                {#if canInvite}
                    <button data-testid="graphs-invite" onclick={oninvite} class={TEXT_BUTTON}>Invite</button>
                {/if}
                <button data-testid="graphs-transfer" onclick={ontransfer} class={TEXT_BUTTON}>Transfer ownership</button>
            {/if}
            {#if onDevice}
                <button
                    data-testid="graphs-remove"
                    title="Deletes this browser's copy; the graph stays on the sync server"
                    onclick={onforget}
                    class={TEXT_BUTTON}>Remove from this device</button
                >
            {/if}
            {#if owner}
                <button data-testid="graphs-delete" disabled={checking} aria-busy={checking} onclick={ondelete} class={DANGER_BUTTON}>Delete</button>
            {:else if role}
                <button data-testid="graphs-leave" disabled={checking} aria-busy={checking} onclick={onleave} class={DANGER_BUTTON}>Leave</button>
            {/if}
        </div>
    {/if}
</li>
