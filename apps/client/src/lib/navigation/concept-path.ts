/**
 * A concept in a URL path (ADR 0023): each `/`-separated segment encoded on its own, so a
 * concept containing `/` spans several path segments and round-trips through a SvelteKit rest
 * param, which re-joins segments with `/` and decodes each. Its own module so the extension
 * address book and the document URLs share it without importing each other.
 */
export function encodeConceptPath(concept: string): string {
    return concept.split('/').map(encodeURIComponent).join('/')
}
