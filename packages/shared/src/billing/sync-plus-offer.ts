/**
 * The offer a Free account sees wherever it meets Sync+: the Sync Server's dashboard, the
 * Client's Graphs page (the Synced graphs group and the Sync tab) and Corporate's Billing page.
 * One sentence and one look on every origin. `SyncPlusOffer.svelte` renders it. The dashboard
 * keeps its own notice box, a live region that stays in place from "Confirming your plan" to the
 * answer so the answer is read out once, and styles it with this same panel class. The offer's
 * button is the primary `gk-button` everywhere.
 */

export const SYNC_PLUS_OFFER_TEXT =
    'Folder graphs are free. Sync+ adds end-to-end encrypted sync across your devices, multiplayer and managed storage. Synced graphs shared with you are free.'

/** The offer's button, to Corporate's pricing page. Billing offers Checkout in its place. */
export const SYNC_PLUS_PRICING_LABEL = 'Sync+ Pricing'

export const SYNC_PLUS_OFFER_PANEL_CLASS =
    'flex min-h-11 flex-col gap-3 rounded-lg bg-neutral-50 px-4 py-3 text-sm leading-5 text-neutral-950 ring-1 ring-neutral-950/10 sm:flex-row sm:items-center sm:justify-between dark:bg-white/5 dark:text-neutral-100 dark:ring-white/10'
