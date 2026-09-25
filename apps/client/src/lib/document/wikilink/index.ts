/**
 * Public entry point for the wikilink core (pure, headless — used by the editor
 * decoration, and later the backlink index and publish). See ADR 0011.
 */

export { parseWikilinks } from './parser'
export {
    type Wikilink,
    type WikilinkSegment,
    conceptOf,
    innermostWikilinkAt,
    wikilinkSegments,
} from './model'
export { onDiskName, portableFileStem, publishSlug } from './derive'
export { type CodeRange, codeRanges, isInCode } from './code-ranges'
export {
    type WikilinkOccurrence,
    wikilinkSegmentsInSource,
    wikilinkOccurrencesInSource,
} from './source'
export { renderWikilinkSegmentsToHtml } from './render-html'
export { type ResolvedTarget, type WikilinkResolver, createSlugResolver } from './resolver'
