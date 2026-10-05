/**
 * The Trusted Types policy names the Client's CSP allows (ADR 0130). `svelte.config.ts` reads this
 * when it builds the CSP, before Vite runs, so it imports nothing.
 */

/** The Client's own icon markup (`surface/icons.ts`). */
export const ICONS_POLICY = 'etherpk-icons'
/** HTML that never runs in this origin: parsed and never shown, or shown in a sandboxed frame. */
export const INERT_POLICY = 'etherpk-inert'

export const CLIENT_TRUSTED_TYPES_POLICIES = [
    // Svelte's own, for its component templates. `{@html}` writes to innerHTML as it is, so a
    // plain string there meets the default policy.
    'svelte-trusted-html',
    // DOMPurify's own, for what it returns as a trusted type.
    'dompurify',
    ICONS_POLICY,
    INERT_POLICY,
    // The safety net for libraries that write strings to sinks (trusted-types.ts).
    'default',
] as const
