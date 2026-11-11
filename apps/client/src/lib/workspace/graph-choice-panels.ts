/**
 * What the Graphs page offers a browser that holds no graph of its own: two choice panels, a Local
 * Graph and a Synced Graph. Everything the panels decide is here, apart from the markup
 * (`GraphChoicePanels.svelte`): which panel comes first, what each button says and does, and whether
 * the synced panel talks about a plan. The page passes in what it knows and acts on the answer.
 *
 * The addresses of the account site (register, Billing, pricing) come from the deployment's
 * configuration through the page's data. Nothing here states a price or a trial's length.
 */
import type { SyncPlusOfferTerms } from '@appsoftwareltd/etherpk-shared'
import type { ServerAuthState } from './graph-picker-helpers'

/** What pressing a panel's button does. The page runs every kind but `link`, which is an anchor. */
export type GraphChoiceAction =
    | { kind: 'open-folder' }
    /** The page's own way to a new synced graph: the naming dialog, or the reason it cannot open. */
    | { kind: 'create-synced' }
    /** The EtherPK sign-in, which comes back to this page. */
    | { kind: 'sign-in' }
    /** The Sync tab's form for a server's address and access token. */
    | { kind: 'connect-server' }
    /** A page on the account site. */
    | { kind: 'link'; href: string }

export interface ChoiceButton {
    label: string
    action: GraphChoiceAction
}

/** One Sync Server this device holds, as far as the synced panel needs it. */
export interface ChoiceServer {
    kind: 'managed' | 'custom'
    authState: ServerAuthState
    /** A managed account whose plan allows no graphs of its own. */
    syncPlusRequired: boolean
    /** That account had Sync+ before, so Checkout starts it again without a trial. */
    planEnded: boolean
    createBlockedReason: string | null
}

export interface GraphChoiceInput {
    /** The browser can open a folder (the File System Access API). */
    folderSupported: boolean
    /** With no server held, the way to a synced graph is the EtherPK account. */
    managedOffered: boolean
    servers: readonly ChoiceServer[]
    /** The account site's registration page, going on to Billing; null when this Client knows no account site. */
    trialUrl: string | null
    billingUrl: string | null
    pricingUrl: string | null
    /**
     * The price and trial the account site offers Sync+ on, read from it by this Client's server;
     * null when they are not known, and the panel then describes the plan without figures.
     */
    offer: SyncPlusOfferTerms | null
}

export interface LocalChoicePanel {
    bullets: readonly string[]
    /** The browser can open a folder. Where it cannot, the panel has no button. */
    available: boolean
    button: ChoiceButton | null
    /** The line above the button: what to choose, or what the browser lacks. */
    help: string
}

export interface SyncedChoicePanel {
    /** Who keeps the graph, in one short sentence. */
    storedBy: string
    bullets: readonly string[]
    primary: ChoiceButton
    secondary: ChoiceButton | null
    /** What the plan asks of the person, with the pricing page when there is one. Null when no plan stands in the way. */
    plan: { text: string; pricingUrl: string | null } | null
    /** Why the button cannot open the naming dialog now, shown as text beside it. */
    reason: string | null
}

export interface GraphChoicePanels {
    order: readonly ['local', 'synced'] | readonly ['synced', 'local']
    local: LocalChoicePanel
    synced: SyncedChoicePanel
}

export const FOLDER_UNAVAILABLE_REASON = 'Needs Chrome or Edge on a computer, or Chrome on Android.'

const LOCAL_BULLETS = [
    'No account or sign-in needed',
    'Your notes stay on this device as plain Markdown files',
    'Works offline, and the same files open in any editor or coding agent',
    'Bring your own sync, such as Git or Syncthing',
] as const

/**
 * What a graph has whichever kind it is, listed under the panels so the choice reads as where the
 * notes are kept and not as two sets of features.
 */
export const ALL_GRAPHS_GET = [
    'Markdown notes with [[wikilinks]] and backlinks',
    'A daily journal',
    'Tasks with priorities and due dates',
    'Kanban boards and maps',
    'PDFs, EBooks and images in your notes',
    'AI agents through the MCP server',
    'Publish pages as a website',
    'Protected Documents, encrypted with a passphrase',
] as const

const CREATE: ChoiceButton = { label: 'Create a synced graph', action: { kind: 'create-synced' } }
const SIGN_IN: ChoiceButton = { label: 'Sign in', action: { kind: 'sign-in' } }

const TRIAL_PLAN_TEXT = 'Synced graphs are part of EtherPK Sync+, a paid plan that starts with a free trial.'
const ACCOUNT_PLAN_TEXT = 'Synced graphs need an EtherPK account with Sync+.'
const ENDED_PLAN_TEXT = 'Your Sync+ subscription has ended. Restart it to create synced graphs.'
const NO_SERVER_CAN = "None of your Sync Servers can take a new graph now. Each one's group below says why."

/** The way to a synced graph from where the device's servers stand. */
type SyncedRoute = 'create' | 'managed-signed-out' | 'trial' | 'restart' | 'connect' | 'blocked'

/** A server the naming dialog can open for: it takes a graph now, or its account check is still out. */
function mayTakeGraph(server: ChoiceServer): boolean {
    return server.authState === 'checking' || (server.authState === 'authenticated' && server.createBlockedReason === null)
}

function syncedRoute(input: GraphChoiceInput): SyncedRoute {
    const { servers } = input
    if (servers.length === 0) return input.managedOffered ? 'managed-signed-out' : 'connect'
    if (servers.some(mayTakeGraph)) return 'create'
    const managed = servers.find((server) => server.kind === 'managed')
    if (managed?.syncPlusRequired) return managed.planEnded ? 'restart' : 'trial'
    if (managed?.authState === 'signed-out' && servers.length === 1) return 'managed-signed-out'
    return 'blocked'
}

/** The one server's own reason, or where to look when the device holds several. */
function blockedReason(servers: readonly ChoiceServer[]): string | null {
    return servers.length === 1 ? servers[0].createBlockedReason : NO_SERVER_CAN
}

type SyncedOffer = Pick<SyncedChoicePanel, 'primary' | 'secondary' | 'plan' | 'reason'>

/** The price as a sentence, such as "Sync+ is (price) a month." */
function priceSentence(offer: SyncPlusOfferTerms, ending = '.'): string {
    return `Sync+ is ${offer.priceDisplay} a ${offer.billingInterval}${ending}`
}

/**
 * What a first subscription is told and what its button says. A trial is named only where one can
 * be started: the terms give its length and say Sync+ can be bought. Without the terms the plan is
 * described with no figures.
 */
function firstSubscription(offer: SyncPlusOfferTerms | null): { text: string; label: string } {
    if (!offer) return { text: TRIAL_PLAN_TEXT, label: 'Start free trial' }
    if (offer.billingEnabled && offer.trialDays > 0) {
        return { text: priceSentence(offer, ` after a ${offer.trialDays}-day free trial.`), label: 'Start free trial' }
    }
    return { text: priceSentence(offer), label: 'Get Sync+' }
}

/** Signed out of Managed Sync: Sync+ for someone new, the sign-in for someone with an account. */
function signedOutOffer(input: GraphChoiceInput): SyncedOffer {
    if (!input.trialUrl) {
        return { primary: SIGN_IN, secondary: null, plan: { text: ACCOUNT_PLAN_TEXT, pricingUrl: input.pricingUrl }, reason: null }
    }
    const { text, label } = firstSubscription(input.offer)
    return {
        primary: { label, action: { kind: 'link', href: input.trialUrl } },
        secondary: SIGN_IN,
        plan: { text, pricingUrl: input.pricingUrl },
        reason: null,
    }
}

/**
 * A managed account without Sync+: Billing, where Checkout starts. An account that had Sync+ before
 * is offered no trial, because Checkout gives one only to a first subscription.
 */
function planOffer(input: GraphChoiceInput, ended: boolean): SyncedOffer {
    // No Billing address known: the page's own route says the gate's reason when pressed.
    if (!input.billingUrl) return { primary: CREATE, secondary: null, plan: null, reason: blockedReason(input.servers) }
    const { text, label } = ended
        ? { text: input.offer ? `${ENDED_PLAN_TEXT} ${priceSentence(input.offer)}` : ENDED_PLAN_TEXT, label: 'Restart Sync+' }
        : firstSubscription(input.offer)
    return {
        primary: { label, action: { kind: 'link', href: input.billingUrl } },
        secondary: null,
        plan: { text, pricingUrl: input.pricingUrl },
        reason: null,
    }
}

function syncedOffer(input: GraphChoiceInput, route: SyncedRoute): SyncedOffer {
    switch (route) {
        case 'managed-signed-out':
            return signedOutOffer(input)
        case 'trial':
            return planOffer(input, false)
        case 'restart':
            return planOffer(input, true)
        case 'connect':
            return {
                primary: { label: 'Connect to a Sync Server', action: { kind: 'connect-server' } },
                secondary: null,
                plan: null,
                reason: null,
            }
        case 'blocked':
            // Still a button that can be pressed: the page then starts the way back in where there
            // is one (a new access token, the passcode), and the reason stays in view either way.
            return { primary: CREATE, secondary: null, plan: null, reason: blockedReason(input.servers) }
        case 'create':
            return { primary: CREATE, secondary: null, plan: null, reason: null }
    }
}

/**
 * Whether the panel speaks for Managed Sync: the graph would be stored by it, and by nothing else
 * the device holds. A device that also holds a custom server gets the neutral wording, because the
 * naming dialog lets the person choose between them.
 */
function storedByManaged(input: GraphChoiceInput, route: SyncedRoute): boolean {
    if (route === 'trial' || route === 'restart' || route === 'managed-signed-out') return true
    return input.servers.length > 0 && input.servers.every((server) => server.kind === 'managed')
}

function syncedPanel(input: GraphChoiceInput): SyncedChoicePanel {
    const route = syncedRoute(input)
    const managed = storedByManaged(input, route)
    return {
        storedBy: managed ? 'Stored by EtherPK Sync+.' : 'Stored on your Sync Server.',
        bullets: [
            'Works on your phone and in every browser',
            'Syncs between your devices',
            // Said here because the Local panel says it: left out, it would read as a difference.
            'Works offline, and syncs when you are back online',
            managed
                ? 'End-to-end encrypted, so EtherPK cannot read your notes'
                : 'End-to-end encrypted, so the server cannot read your notes',
            'Share a notes graph and collaborate in real time',
            // The mirror writes to a folder, so it needs what a Local Graph needs of the browser.
            'Keep a Local Mirror as plain Markdown files, in a browser that can open folders',
        ],
        ...syncedOffer(input, route),
    }
}

function localPanel(folderSupported: boolean): LocalChoicePanel {
    return folderSupported
        ? {
              bullets: LOCAL_BULLETS,
              available: true,
              button: { label: 'Choose a folder', action: { kind: 'open-folder' } },
              help: 'For a new graph, choose a new, empty folder.',
          }
        : { bullets: LOCAL_BULLETS, available: false, button: null, help: FOLDER_UNAVAILABLE_REASON }
}

/** The two panels for a browser with no graph of its own. The one this browser can use comes first. */
export function graphChoicePanels(input: GraphChoiceInput): GraphChoicePanels {
    return {
        order: input.folderSupported ? ['local', 'synced'] : ['synced', 'local'],
        local: localPanel(input.folderSupported),
        synced: syncedPanel(input),
    }
}

/**
 * What the Graphs page does when its address asks for a new synced graph (`?new=synced`), as the
 * account site's Billing page does once Sync+ is active:
 *
 * - `sign-in`: this device is not signed in to Managed Sync, so start the sign-in, which comes back
 *   to the same address.
 * - `wait`: an account check or a plan's confirmation is still out; ask again when it answers.
 * - `open`: a server can take the graph, so open the naming dialog.
 * - `drop`: nothing more to do by itself. The page shows what stands in the way, as on any visit.
 *
 * `arrivedSignedIn` is the address saying a sign-in has just finished here. A device still signed
 * out after one is not sent round again.
 */
export type NewSyncedGraphStep = 'sign-in' | 'wait' | 'open' | 'drop'

export function newSyncedGraphStep(state: {
    managedOffered: boolean
    arrivedSignedIn: boolean
    servers: readonly (Pick<ChoiceServer, 'kind' | 'authState' | 'createBlockedReason'> & { planPending: boolean })[]
}): NewSyncedGraphStep {
    const { servers } = state
    const signIn = state.arrivedSignedIn ? 'drop' : 'sign-in'
    if (servers.length === 0) return state.managedOffered ? signIn : 'drop'
    if (servers.some((server) => server.authState === 'authenticated' && server.createBlockedReason === null)) return 'open'
    if (servers.some((server) => server.authState === 'checking' || server.planPending)) return 'wait'
    const onlyManagedSignedOut = servers.length === 1 && servers[0].kind === 'managed' && servers[0].authState === 'signed-out'
    return onlyManagedSignedOut ? signIn : 'drop'
}
