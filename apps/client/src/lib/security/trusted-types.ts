/**
 * Trusted Types for the Client (ADR 0130). The Client's CSP says `require-trusted-types-for
 * 'script'`, so the browser refuses a plain string at an HTML sink (`innerHTML`, `srcdoc`,
 * `DOMParser`) or a script-URL sink (a worker's URL) unless a named policy made it. The policies the
 * CSP allows are Svelte's and DOMPurify's own, and these:
 *
 * - `etherpk-icons`: the Client's own icon markup, from the one table in `surface/icons.ts`,
 *   constant text in the source. Only that module calls `trustedIconMarkup`, which lint enforces.
 * - `etherpk-inert`: HTML that never runs in this origin. A pasted page parsed by `DOMParser`, whose
 *   document never joins the page, and a page shown in a sandboxed frame with an opaque origin.
 * - `default`: the safety net for libraries that write strings to sinks, Mermaid on every render
 *   above all. Text with no markup passes, markup goes through DOMPurify, script URLs pass only from
 *   this origin (its own blob URLs included), and script text is refused.
 *
 * Every sink in the Client's own code goes through a function here, which is what the lint rule
 * checks. Where the browser has no Trusted Types the strings pass as they are, as the browser takes
 * them; the Chromium suite is where the policies are enforced and tested.
 */
import DOMPurify from 'dompurify'
import { ICONS_POLICY, INERT_POLICY } from './trusted-types-policies'

declare const trustedMarkupBrand: unique symbol
/**
 * Markup a policy made. Not a string type, so a plain string cannot stand in for it. A template
 * string built from it is a plain string again, which the default policy sanitizes.
 */
export type TrustedMarkup = { readonly [trustedMarkupBrand]: true }

/** The parts of the Trusted Types API used here: TypeScript's DOM types do not include it. */
interface PolicyOptions {
    createHTML?: (input: string) => string | null
    createScript?: (input: string) => string | null
    createScriptURL?: (input: string) => string | null
}
interface Policy {
    createHTML(input: string): unknown
}
interface PolicyFactory {
    createPolicy(name: string, options: PolicyOptions): Policy
}

function policyFactory(): PolicyFactory | null {
    if (typeof window === 'undefined') return null
    return (window as unknown as { trustedTypes?: PolicyFactory }).trustedTypes ?? null
}

/** A pass-through HTML policy, made the first time it is needed. Null where there are no Trusted Types. */
function passThroughPolicy(name: string): () => Policy | null {
    let policy: Policy | null | undefined
    return () => {
        policy ??= policyFactory()?.createPolicy(name, { createHTML: (html) => html }) ?? null
        return policy
    }
}

const iconsPolicy = passThroughPolicy(ICONS_POLICY)
const inertPolicy = passThroughPolicy(INERT_POLICY)

function through(policy: Policy | null, html: string): TrustedMarkup {
    return (policy ? policy.createHTML(html) : html) as TrustedMarkup
}

/** The Client's own icon markup, ready for an HTML sink. Only `surface/icons.ts` calls this. */
export function trustedIconMarkup(svg: string): TrustedMarkup {
    return through(iconsPolicy(), svg)
}

/**
 * SVG a library drew from document content (a Mermaid diagram), sanitized by DOMPurify with the
 * settings Mermaid uses for its own output: HTML is kept inside `foreignObject`, where Mermaid puts
 * its labels, so sanitizing Mermaid's output again changes nothing.
 */
export function sanitizedSvgMarkup(svg: string): TrustedMarkup {
    // DOMPurify needs a DOM to sanitize against. Without one (the Node tests) there is no page
    // and no sink either, so the markup has nowhere to run.
    if (!DOMPurify.isSupported) return svg as unknown as TrustedMarkup
    return DOMPurify.sanitize(svg, {
        ADD_TAGS: ['foreignobject'],
        ADD_ATTR: ['dominant-baseline'],
        HTML_INTEGRATION_POINTS: { foreignobject: true },
        RETURN_TRUSTED_TYPE: true,
    }) as unknown as TrustedMarkup
}

/**
 * An icon an extension's manifest added (ADR 0121), sanitized by DOMPurify as SVG alone. Its markup
 * is not constant text in this repository, so it never goes through `etherpk-icons`: an extension's
 * icon cannot bring a script, an event handler or HTML into the page.
 */
export function sanitizedIconMarkup(svg: string): TrustedMarkup {
    // Without a DOM (the Node tests) there is no page and no sink either.
    if (!DOMPurify.isSupported) return svg as unknown as TrustedMarkup
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true }, RETURN_TRUSTED_TYPE: true }) as unknown as TrustedMarkup
}

/** Put markup a policy made into `element`, replacing what it held. */
export function setTrustedMarkup(element: Element, markup: TrustedMarkup): void {
    element.innerHTML = markup as unknown as string
}

/** Parse HTML into a document that never joins the page, so nothing in it runs (rich paste). */
export function parseInertHtml(html: string): Document {
    return new DOMParser().parseFromString(through(inertPolicy(), html) as unknown as string, 'text/html')
}

/**
 * Show `html` in `frame` as its `srcdoc`. Only for a frame sandboxed without `allow-same-origin`: the
 * page then has an opaque origin and the app's CSP, so nothing in it reaches the app.
 */
export function setSandboxedSrcdoc(frame: HTMLIFrameElement, html: string): void {
    if (frame.sandbox.contains('allow-same-origin')) throw new Error('A srcdoc frame here must not share the app’s origin')
    frame.srcdoc = through(inertPolicy(), html) as unknown as string
}

/**
 * What the default policy lets through, given how markup is sanitized and this page's origin.
 * Separate from the policy so it can be tested where there are no Trusted Types.
 */
export function defaultPolicyRules(sanitize: (html: string) => string, origin: string) {
    return {
        // Text with no `<` cannot add an element: Mermaid writes its style text and labels this way.
        createHTML: (input: string): string => (input.includes('<') ? sanitize(input) : input),
        createScriptURL: (input: string): string | null => (sameOrigin(input, origin) ? input : null),
        // Nothing in the Client needs to run script text, and nothing should.
        createScript: (_input: string): null => null,
    }
}

function sameOrigin(input: string, origin: string): boolean {
    try {
        // A blob URL's origin is the origin of the page that made it.
        return new URL(input, origin).origin === origin
    } catch {
        return false
    }
}

/**
 * Create the default policy, once, before anything writes to a sink. A second call (a module
 * evaluated again in development) leaves the first in place.
 */
export function installDefaultPolicy(): void {
    const factory = policyFactory()
    if (!factory) return
    try {
        factory.createPolicy('default', defaultPolicyRules((html) => DOMPurify.sanitize(html), window.location.origin))
    } catch {
        // Already created: the browser allows one default policy per page.
    }
}
