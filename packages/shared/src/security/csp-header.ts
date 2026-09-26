/**
 * Adjust a Content-Security-Policy header after SvelteKit has built it.
 *
 * The directives are baked into each image at build time (`kit.csp`), which suits everything
 * that is the same in every deployment. A source that depends on runtime configuration, such as
 * Corporate's analytics host (present only where `ANALYTICS_WEBSITE_ID` is set), is added to the
 * response header instead, so a deployment without it never allows the host.
 */
export function addCspSource(policy: string, directiveNames: readonly string[], source: string): string {
    return policy
        .split(';')
        .map((directive) => {
            const tokens = directive.trim().split(/\s+/)
            if (!directiveNames.includes(tokens[0]) || tokens.includes(source)) return directive.trim()
            return [...tokens, source].join(' ')
        })
        .filter((directive) => directive.length > 0)
        .join('; ')
}
