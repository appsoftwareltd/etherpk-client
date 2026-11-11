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
     *
     * A card of its own: a band with the graph's name and main controls, in its toolbar colour when
     * this device knows one (graph-card.ts), over a neutral panel with everything else. A notice in
     * amber or red stays on the panel, since neither can be promised to read on a colour a person chose.
     */
    import { formatBytes } from '@appsoftwareltd/etherpk-shared'
    import { inkFor } from '#lib/contrast-ink.js'
    import GraphGrip, { type GraphGripProps } from './GraphGrip.svelte'
    import { tick } from 'svelte'
    import { BADGE_ON_COLOUR, GRAPH_CARD, GRAPH_CARD_UNCLIPPED, ICON_ON_COLOUR, OPEN_ON_COLOUR } from './graph-card'
    import type { SyncedMember } from './graph-picker-helpers'
    import { OPEN_BUTTON, OPEN_ICON } from './graphs-page-icons'

    let {
        graphId,
        name,
        role,
        onDevice,
        locked = false,
        accent = null,
        grip = null,
        readOnly = false,
        importInterrupted = false,
        storage = null,
        nameNote = null,
        members,
        message = null,
        canInvite = false,
        checking = false,
        cancellingInvite = null,
        keyNotice = null,
        rotating = false,
        removingMember = null,
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
        onverify,
        onremovemember,
        onrotate,
        onverifyowner,
    }: {
        graphId: string
        name: string
        /** The account's role, from the server's list; null when the list is not to hand. */
        role: string | null
        /** A copy of the graph is registered in this browser. */
        onDevice: boolean
        /**
         * The server's Encryption Keys are locked on this device: the row is a placeholder under
         * the group's unlock step until they are unlocked. Deleting the graph and leaving it need
         * no key, and are the only way to drop one graph for somebody who can never unlock (a
         * reset drops them all), so they stay, behind the row's menu.
         */
        locked?: boolean
        /** Its toolbar colour, when this device knows one. */
        accent?: string | null
        /** Its handle in a list that can be put in order; null where there is nothing to order. */
        grip?: GraphGripProps | null
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
        /**
         * For a Player: why the newest copy of the graph's key was not used (ADR 0127), and whether
         * comparing the owner's fingerprint is the way on.
         */
        keyNotice?: { text: string; verifyOwner: boolean } | null
        /** For the owner: the graph's key is being changed from this page. */
        rotating?: boolean
        /** The member whose removal is in flight. */
        removingMember?: string | null
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
        /** Compare a member's fingerprint and pin it (ADR 0126). */
        onverify: (member: SyncedMember) => void
        /** Remove a Player, once the owner has confirmed it here (ADR 0127). */
        onremovemember: (member: SyncedMember) => void
        /** Give the graph a new key now. */
        onrotate: () => void
        /** Compare the owner's new fingerprint and pin it, so their copy of the key is used. */
        onverifyowner: () => void
    } = $props()

    const owner = $derived(role === 'owner')
    const ink = $derived(accent ? inkFor(accent) : null)

    // Removing a Player asks first, in place, beside the Player: what it does cannot be undone, and
    // the sentence says what it means for what they already have.
    let confirmingRemoval = $state<string | null>(null)
    /** Each member's Remove button, so stepping back can return the focus to it. */
    const removeTriggers = new Map<string, HTMLElement>()

    function removeTrigger(userId: string) {
        return (element: HTMLElement) => {
            removeTriggers.set(userId, element)
            return () => {
                if (removeTriggers.get(userId) === element) removeTriggers.delete(userId)
            }
        }
    }

    function cancelRemoval() {
        const userId = confirmingRemoval
        confirmingRemoval = null
        if (userId) removeTriggers.get(userId)?.focus()
    }

    function escapeCancels(event: KeyboardEvent) {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        cancelRemoval()
    }

    function confirmRemoval(member: SyncedMember) {
        confirmingRemoval = null
        onremovemember(member)
    }

    /** The confirmation's first control takes the focus, so a keyboard user lands on the choice. */
    function focusOnMount(element: HTMLElement) {
        element.focus()
    }

    // A locked row's menu: one item, Delete for the owner or Leave for a Player. Enter or a click
    // opens it on that item; Escape, or the focus leaving, closes it.
    let menuOpen = $state(false)
    let menuTrigger = $state<HTMLButtonElement>()
    const menuId = $props.id()

    async function closeMenu(returnFocus: boolean) {
        menuOpen = false
        if (!returnFocus) return
        await tick()
        menuTrigger?.focus()
    }

    function menuKeydown(event: KeyboardEvent) {
        if (event.key !== 'Escape' || !menuOpen) return
        event.stopPropagation()
        void closeMenu(true)
    }

    function menuFocusOut(event: FocusEvent) {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !(event.currentTarget as HTMLElement).contains(next)) menuOpen = false
    }

    function choose(action: () => void) {
        menuOpen = false
        action()
    }

    /** A closed padlock (Heroicons outline), beside a locked row's name. */
    const LOCK_ICON =
        'M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z'

    const TEXT_BUTTON =
        'shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 pointer-coarse:min-h-11 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-white/5'
    const DANGER_BUTTON =
        'shrink-0 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:border-red-500/40 dark:hover:bg-red-950/30'
    const MENU_DANGER_ITEM =
        'flex w-full items-center rounded-md px-3 py-2 text-left text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:text-red-400 dark:hover:bg-red-950/30'
    const ICON_BUTTON =
        'shrink-0 rounded-lg p-1.5 pointer-coarse:p-3 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-200'
</script>

<!-- The name and the role. `coloured`: on the band in the graph's toolbar colour, which a locked
     row does not draw. -->
{#snippet badges(coloured: boolean)}
    <span data-testid="graph-card-name" class="truncate text-sm font-medium {coloured ? '' : 'text-neutral-950 dark:text-white'}">{name}</span>
    {#if role}
        <span
            data-testid="synced-role"
            class={coloured
                ? BADGE_ON_COLOUR
                : `rounded-full px-2 py-0.5 text-sm ${owner ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-400'}`}>{owner ? 'Owner' : 'Player'}</span
        >
    {/if}
{/snippet}

{#if locked}
    <!-- Locked: what the graph is to this account and how much it holds. The group's unlock step,
         above, is the one action in view; the id is left out, and deleting or leaving the graph,
         which need no key, are behind the menu. -->
    <div data-testid="synced-graph" data-graph-id={graphId} data-on-device={onDevice} data-locked="true" class={GRAPH_CARD_UNCLIPPED}>
        <div data-testid="graph-band" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
            <svg class="h-4 w-4 shrink-0 text-neutral-500 dark:text-neutral-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d={LOCK_ICON} />
            </svg>
            <span class="flex min-w-0 flex-1 basis-40 flex-wrap items-center gap-2">{@render badges(false)}</span>
            <span class="text-sm text-neutral-500 dark:text-neutral-400" data-testid="synced-locked-detail">
                {[onDevice ? 'On this device' : 'Not on this device', ...(storage ? [`${formatBytes(storage.docBytes)} notes`, `${formatBytes(storage.assetBytes)} assets`] : [])].join(' · ')}
            </span>
            {#if role}
                <!-- The handlers watch the menu's own controls: Escape and the focus leaving close it. -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="relative" onkeydown={menuKeydown} onfocusout={menuFocusOut}>
                    <button
                        bind:this={menuTrigger}
                        type="button"
                        data-testid="graphs-locked-menu"
                        aria-label={`More actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-controls={menuOpen ? menuId : undefined}
                        onclick={() => (menuOpen = !menuOpen)}
                        class={ICON_BUTTON}
                    >
                        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z" />
                        </svg>
                    </button>
                    {#if menuOpen}
                        <div
                            id={menuId}
                            role="menu"
                            aria-label={`More actions for ${name}`}
                            class="absolute right-0 top-full z-20 mt-1 min-w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-(--gk-surface-2)"
                        >
                            {#if owner}
                                <button
                                    {@attach focusOnMount}
                                    type="button"
                                    role="menuitem"
                                    data-testid="graphs-delete"
                                    disabled={checking}
                                    aria-busy={checking}
                                    onclick={() => choose(ondelete)}
                                    class={MENU_DANGER_ITEM}>Delete graph…</button
                                >
                            {:else}
                                <button
                                    {@attach focusOnMount}
                                    type="button"
                                    role="menuitem"
                                    data-testid="graphs-leave"
                                    disabled={checking}
                                    aria-busy={checking}
                                    onclick={() => choose(onleave)}
                                    class={MENU_DANGER_ITEM}>Leave graph…</button
                                >
                            {/if}
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
        {#if message}
            <p
                data-testid="synced-graph-status"
                role={message.tone === 'error' ? 'alert' : 'status'}
                class="px-4 pb-3 text-sm {message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'}"
            >
                {message.text}
            </p>
        {/if}
    </div>
{:else}
<div data-testid="synced-graph" data-graph-id={graphId} data-on-device={onDevice} data-locked="false" class={GRAPH_CARD}>
    <div
        data-testid="graph-band"
        class="flex flex-wrap items-center gap-2 px-4 py-3"
        style:background-color={accent}
        style:color={ink}
        style:--graph-colour={accent}
        style:--graph-ink={ink}
    >
        {#if grip}<GraphGrip {grip} coloured={accent !== null} />{/if}
        {#if onDevice}
            <!-- The basis keeps room for the name: on a narrow screen the controls drop to a line of
                 their own rather than squeezing it away. -->
            <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
                <span class="flex min-w-0 flex-wrap items-center gap-2">{@render badges(accent !== null)}</span>
                <span
                    class="truncate text-sm {accent ? '' : 'text-neutral-500 dark:text-neutral-400'}"
                    data-testid="graphs-cache-hint"
                    title="A synced graph's copy is stored in the browser, not in a folder">On this device</span
                >
            </div>
            <div class="ml-auto flex items-center gap-2">
            <button data-testid="graphs-open" aria-label={`Open ${name}`} onclick={onopen} class={accent ? OPEN_ON_COLOUR : OPEN_BUTTON}>
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
                class={accent ? ICON_ON_COLOUR : ICON_BUTTON}
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
                class={accent ? ICON_ON_COLOUR : ICON_BUTTON}
            >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
                    <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>
            </div>
        {:else}
            <div class="flex min-w-0 flex-1 basis-40 flex-col gap-0.5">
                <span class="flex min-w-0 flex-wrap items-center gap-2">{@render badges(accent !== null)}</span>
                <span class="text-sm text-neutral-500 dark:text-neutral-400" data-testid="synced-not-local">Not on this device</span>
            </div>
            <button data-testid="graphs-add-device" onclick={onadd} class="ml-auto {TEXT_BUTTON}">Add to this device</button>
        {/if}
    </div>

    <div class="space-y-2 px-4 pb-3 {accent ? 'pt-3' : ''}">
    {#if message}
        <p
            data-testid="synced-graph-status"
            role={message.tone === 'error' ? 'alert' : 'status'}
            class="text-sm {message.tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-neutral-600 dark:text-neutral-400'}"
        >
            {message.text}
        </p>
    {/if}

    {#if keyNotice}
        <div data-testid="synced-key-notice" class="flex flex-wrap items-center gap-2">
            <p role="alert" class="min-w-0 flex-1 text-sm text-amber-800 dark:text-amber-200">{keyNotice.text}</p>
            {#if keyNotice.verifyOwner}
                <button data-testid="synced-verify-owner" onclick={onverifyowner} class={TEXT_BUTTON}>Verify</button>
            {/if}
        </div>
    {/if}

    {#if importInterrupted || readOnly}
        <p class="flex flex-wrap gap-2">
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
        </p>
    {/if}

    {#if nameNote}
        <!-- The row could not be labelled yet. Say why and what changes it; the line must never
             read as a key failure: "Encrypted name" once sent a user towards Reset (2026-09-01). -->
        <p class="text-sm text-neutral-500 dark:text-neutral-400" data-testid="synced-name-encrypted" aria-live="polite">{nameNote}</p>
    {/if}

    <p class="flex flex-wrap gap-x-3 text-sm text-neutral-500 dark:text-neutral-400">
        {#if storage}
            <span data-testid="synced-storage">{formatBytes(storage.docBytes)} notes · {formatBytes(storage.assetBytes)} assets</span>
        {/if}
        <span class="truncate font-mono select-all" data-testid="synced-id">{graphId}</span>
    </p>

    {#if owner && members !== undefined}
        {#if members}
            <ul data-testid="synced-members" class="space-y-1 border-t border-neutral-100 pt-2 dark:border-white/10">
                {#each members as m (m.userId)}
                    <li
                        data-testid="synced-member"
                        data-status={m.status ?? 'active'}
                        data-trust={m.trust}
                        class="flex flex-wrap items-center gap-2 text-sm"
                    >
                        <span class="truncate text-neutral-700 dark:text-neutral-300">{m.email}</span>
                        <span class="rounded-full bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600 dark:bg-white/10 dark:text-neutral-400">
                            {m.role === 'owner' ? 'Owner' : m.status === 'invited' ? 'Invited' : 'Player'}
                        </span>
                        <!-- What the owner's pins say about the member's key (ADR 0126); shown only
                             while the keys are unlocked here, since the pins are in the vault. -->
                        {#if m.trust === 'verified'}
                            <span
                                data-testid="member-trust"
                                class="rounded-full bg-emerald-50 px-2 py-0.5 text-sm text-emerald-800 dark:bg-emerald-400/10 dark:text-emerald-200"
                                >Verified</span
                            >
                        {:else if m.trust === 'changed'}
                            <span
                                data-testid="member-trust"
                                class="rounded-full bg-amber-50 px-2 py-0.5 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
                                >Key changed</span
                            >
                        {:else if m.trust === 'unverified'}
                            <span data-testid="member-trust" class="rounded-full bg-neutral-100 px-2 py-0.5 text-sm text-neutral-600 dark:bg-white/10 dark:text-neutral-400"
                                >Unverified</span
                            >
                        {:else if m.trust === 'not-upgraded'}
                            <span data-testid="member-trust" class="text-sm text-neutral-500 dark:text-neutral-400"
                                >Can be verified once they next open EtherPK</span
                            >
                        {:else if m.trust === 'signing-key-missing'}
                            <!-- No Verify: there is no signing key to compare. The rotation notice says
                                 what the owner can do instead. -->
                            <span
                                data-testid="member-trust"
                                class="rounded-full bg-amber-50 px-2 py-0.5 text-sm text-amber-800 dark:bg-amber-400/10 dark:text-amber-200"
                                >Signing key missing</span
                            >
                        {/if}
                        <span class="ml-auto flex shrink-0 gap-1">
                            {#if m.trust === 'unverified' || m.trust === 'changed'}
                                <button
                                    data-testid="member-verify"
                                    onclick={() => onverify(m)}
                                    class="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950 pointer-coarse:min-h-11 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-white"
                                    >Verify</button
                                >
                            {/if}
                            {#if m.status === 'invited' && m.inviteId}
                                <button
                                    data-testid="member-cancel-invite"
                                    disabled={cancellingInvite === m.inviteId}
                                    onclick={() => oncancelinvite(m)}
                                    class="rounded-lg px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-50 hover:text-neutral-950 disabled:cursor-progress dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-white"
                                    >{cancellingInvite === m.inviteId ? 'Cancelling…' : 'Cancel invite'}</button
                                >
                            {/if}
                            {#if m.role === 'player' && m.status !== 'invited'}
                                <button
                                    {@attach removeTrigger(m.userId)}
                                    data-testid="member-remove"
                                    disabled={removingMember === m.userId}
                                    aria-busy={removingMember === m.userId}
                                    aria-expanded={confirmingRemoval === m.userId}
                                    onclick={() => (confirmingRemoval = m.userId)}
                                    class="rounded-lg px-2 py-1 text-sm text-red-700 hover:bg-red-50 disabled:cursor-progress pointer-coarse:min-h-11 dark:text-red-400 dark:hover:bg-red-950/30"
                                    >{removingMember === m.userId ? 'Removing…' : 'Remove'}</button
                                >
                            {/if}
                        </span>
                        {#if confirmingRemoval === m.userId}
                            <!-- Escape steps back, and the focus returns to the Remove that opened it. -->
                            <div
                                data-testid="member-remove-confirm"
                                role="group"
                                aria-label={`Remove ${m.email}`}
                                class="flex basis-full flex-wrap items-center gap-2 rounded-lg bg-red-50 px-3 py-2 dark:bg-red-950/30"
                            >
                                <p class="min-w-0 flex-1 text-sm text-red-800 dark:text-red-200">
                                    Remove {m.email}? They lose access now. Anything they already opened stays on their devices.
                                </p>
                                <button
                                    {@attach focusOnMount}
                                    data-testid="member-remove-confirm-button"
                                    onkeydown={escapeCancels}
                                    onclick={() => confirmRemoval(m)}
                                    class="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 pointer-coarse:min-h-11 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-950/30"
                                    >Remove</button
                                >
                                <button data-testid="member-remove-cancel" onkeydown={escapeCancels} onclick={cancelRemoval} class={TEXT_BUTTON}
                                    >Cancel</button
                                >
                            </div>
                        {/if}
                    </li>
                {/each}
            </ul>
        {:else}
            <p class="border-t border-neutral-100 pt-2 text-sm text-neutral-500 dark:border-white/10 dark:text-neutral-400">
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
                <!-- A new key for everyone in the graph; nothing to confirm, since nobody loses anything. -->
                <button
                    data-testid="graphs-rotate-key"
                    title="Make a new key for this graph. Its members receive it automatically."
                    disabled={rotating}
                    aria-busy={rotating}
                    onclick={onrotate}
                    class="{TEXT_BUTTON} disabled:cursor-progress">{rotating ? 'Changing key…' : 'Rotate key'}</button
                >
            {/if}
            {#if onDevice}
                <button
                    data-testid="graphs-remove"
                    title="Deletes this browser's copy - the graph stays on the sync server"
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
    </div>
</div>
{/if}
