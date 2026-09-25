/**
 * The document editor's feature stack, assembled in one place.
 *
 * `DocumentView.svelte` used to carry this list inline, between its lifecycle code and its draft
 * handling, and nothing checked it: the order matters (a transaction filter must precede what it
 * guards; the asset-link augmentation must run before the markdown-link one so asset targets are
 * skipped; the completions must sit after the decorations they anchor to), yet it lived only in
 * comments. Now the list is data with a name per feature, `editor-extensions.test.ts` pins the
 * order and presence, and the View passes in the services the features need and nothing else.
 *
 * The services are thunks (`() => …`) where the value can change during the editor's life (the
 * asset store, the graph index) and plain callbacks where the View owns the side effect.
 */

import type { Extension } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'

import type { AssetStore } from '$lib/storage/fs/asset-store'

import type { ConceptCandidate } from '../index-db'
import type { RemoteGraphIndex } from '../index-worker/client'
import { assetDropAugmentation } from './augmentations/asset-drop'
import { assetLinkAugmentation } from './augmentations/asset-link'
import type { Backend } from '$lib/document/frontmatter/proposal'

import { type FrontmatterOptions, frontmatterAugmentation } from './augmentations/frontmatter'
import { frontmatterBoundaryGuard } from './frontmatter-boundary'
import { assetPasteAugmentation } from './augmentations/asset-paste'
import { richPasteAugmentation } from './augmentations/rich-paste'
import { bulletMarkerAugmentation } from './augmentations/bullet-marker'
import { codeScrollAugmentation } from './augmentations/code-scroll'
import { contentClampAugmentation } from './augmentations/content-clamp'
import { dateCalendar } from './augmentations/date-calendar'
import { tableSizePicker } from './augmentations/table-size-picker'
import { fenceRenderAugmentation } from './augmentations/fence-render'
import { protectedFenceAugmentation } from './augmentations/protected-fence'
import { imageEmbedAugmentation } from './augmentations/image-embed'
import { linkCursorAugmentation } from './augmentations/link-cursor'
import { markdownFormatAugmentation } from './augmentations/markdown-format'
import { markdownLinkAugmentation } from './augmentations/markdown-link'
import { markdownTableAugmentation } from './augmentations/markdown-table'
import { mathInlineAugmentation } from './augmentations/math-inline'
import { outlineGuidesAugmentation } from './augmentations/outline-guides'
import { selectionLayerAugmentation } from './augmentations/selection-layer'
import { slashCompletion } from './augmentations/slash-complete'
import { spellCheckAugmentation } from './augmentations/spell-check'
import { taskCheckboxAugmentation } from './augmentations/task-checkbox'
import { taskTagCompletion } from './augmentations/task-tag-complete'
import { wikilinkAugmentation } from './augmentations/wikilink'
import { wikilinkCompletion } from './augmentations/wikilink-complete'
import { blockSelection } from './block-select'
import { caretClamp } from './caret-clamp'
import { type EditRefusal, editRefusalReporter } from './edit-refused'
import { wrapSelectionInput } from './wrap-selection'

export interface EditorExtensionServices {
    /** The active asset store, or `null` when no graph is open (upload, drop, paste, image and link resolution). */
    assetStore: () => AssetStore | null
    /** The graph's derived index, or `null` while none is ready (wikilink styling and completion). */
    graphIndex: () => RemoteGraphIndex | null
    /** Whether a wikilinked concept has no page yet (styles the link as missing). */
    conceptIsMissing: (concept: string) => boolean
    /** Open a wikilinked concept (a click on the link). */
    openConcept: (concept: string) => void
    /**
     * An editing episode inside a wikilink ended having changed its concept (ADR 0065): what
     * it named before, and what the link at that place names now (null when no balanced link
     * survived the edit). The workspace decides whether that is a rename to propose.
     */
    wikilinkEdited?: (before: string, after: string | null) => void
    /** A right-click or long-press on a wikilink: raise the Context Menu for its concept. */
    wikilinkContextMenu?: (concept: string, x: number, y: number) => void
    /**
     * A guard refused the user's edit (`edit-refused.ts`): the View says why, since a keystroke
     * that does nothing reads as a broken editor. Optional for hosts with no dialog to show.
     */
    editRefused?: (reason: EditRefusal) => void
    /** The editor gained focus: the View makes its document and view the active ones. */
    onFocus: (view: EditorView) => void
    /** Every update: the View keeps the Command Bar context, reading position and reveals in step. */
    onUpdate: (update: ViewUpdate) => void
    /**
     * [[Frontmatter]] as a proposal (ADR 0061): what this document's block proposes against the
     * registry, the name the document answers to, and where to report an editing episode's end
     * and the mismatch mark's Restore. Absent outside a graph, where the block is only presented.
     */
    frontmatter?: FrontmatterOptions
    /**
     * Whether this document is a [[Protected Document]]. Per editor, not global: more than one
     * document pane can be open. Unlocked, the projected text carries no fence, so only the
     * document can say.
     */
    isProtectedDocument?: () => boolean
    /** Which backend the open graph stores documents on; null outside a graph. */
    backend?: () => Backend | null
}

/** One named feature of the stack: the name is what the order test asserts on. */
export interface EditorFeature {
    name: string
    extension: Extension
}

/**
 * The features in load order. Each entry's comment says why it sits where it does when the position
 * is load-bearing; the rest are grouped by concern.
 */
export function editorFeatures(services: EditorExtensionServices): EditorFeature[] {
    const store = services.assetStore

    /**
     * The concept keys something actually resolves to, for the date calendar's bold days.
     *
     * Memoised on the snapshot's identity: the calendar asks once per cell, forty-two times a
     * repaint, and the index hands back the same frozen array until it rebuilds.
     */
    let resolvedFrom: readonly ConceptCandidate[] | null = null
    let resolved = new Set<string>()
    function resolvedConcepts(): ReadonlySet<string> {
        const candidates = services.graphIndex()?.allConcepts() ?? []
        if (candidates !== resolvedFrom) {
            resolvedFrom = candidates
            resolved = new Set(
                candidates.filter((c) => c.kind !== 'pageless').map((c) => c.key),
            )
        }
        return resolved
    }

    return [
        // Transaction filters first: a multi-line selection in a bullet region snaps to whole blocks,
        // and an empty-selection caret can never rest left of a line's content column (ADR 0021).
        { name: 'block-selection', extension: blockSelection() },
        { name: 'caret-clamp', extension: caretClamp() },
        // The Frontmatter block's edges: body text never joins onto its closer, and it never grows
        // past what was typed into it (ADR 0061).
        { name: 'frontmatter-boundary', extension: frontmatterBoundaryGuard() },
        // A wrap key over a selection encloses it (ADR 0077): an input handler, so it sees typed text
        // before it becomes a change. It places no ordering constraint on anything and is kept here
        // with the other non-decorating features.
        { name: 'wrap-selection', extension: wrapSelectionInput() },
        // Spell Check's underlines (ADR 0095), prose only. First of the decorating features:
        // CodeMirror nests a later extension's mark OUTSIDE an earlier one's and splits the inner
        // one at the outer's edges, and an underline can be split freely, where the clamp's
        // absolute prefix, a highlight's padded wash and a code line's scroll container cannot.
        { name: 'spell-check', extension: spellCheckAugmentation() },
        // Inline formatting marks, then the outliner chrome drawn over the same lines.
        { name: 'markdown-format', extension: markdownFormatAugmentation() },
        { name: 'bullet-marker', extension: bulletMarkerAugmentation() },
        { name: 'task-checkbox', extension: taskCheckboxAugmentation() },
        { name: 'outline-guides', extension: outlineGuidesAugmentation() },
        // Content-column clamp (ADR 0020), then the selection highlight drawn from the laid-out lines.
        { name: 'content-clamp', extension: contentClampAugmentation() },
        // A code line's scroll container (ADR 0094) fills the geometry the clamp gives the line, and
        // CodeMirror nests a later extension's mark OUTSIDE an earlier one's, so registered after
        // everything that marks inside a code line: the container stays one box.
        { name: 'code-scroll', extension: codeScrollAugmentation() },
        { name: 'selection-layer', extension: selectionLayerAugmentation() },
        { name: 'markdown-table', extension: markdownTableAugmentation() },
        // Frontmatter wears the fenced-code panel over its own parse node — kept beside the
        // fence so the two block-panel constructs stay together.
        {
            name: 'frontmatter',
            extension: frontmatterAugmentation(
                services.frontmatter ?? {
                    proposal: () => [],
                    documentName: () => null,
                    onEpisodeEnd: () => {},
                    onRestore: () => {},
                },
            ),
        },
        // Protected fences come BEFORE fence-render: an `etherpk-cipher` fence dispatches to no
        // renderer, and its widget must be the only thing that ever draws over that range.
        {
            name: 'protected-fence',
            extension: protectedFenceAugmentation({ isProtected: services.isProtectedDocument, backend: services.backend }),
        },
        // Rendered fences and inline maths dispatch to the registered renderers (ADR 0022).
        { name: 'fence-render', extension: fenceRenderAugmentation() },
        { name: 'math-inline', extension: mathInlineAugmentation() },
        // Assets: images resolve through the store; asset links download. Asset-link MUST precede
        // markdown-link, which skips any target the asset augmentation owns.
        {
            name: 'image-embed',
            extension: imageEmbedAugmentation({
                resolveAsset: (ref) => store()?.resolve(ref) ?? Promise.resolve(null),
            }),
        },
        { name: 'asset-link', extension: assetLinkAugmentation({ store }) },
        { name: 'markdown-link', extension: markdownLinkAugmentation() },
        { name: 'asset-drop', extension: assetDropAugmentation({ store }) },
        { name: 'asset-paste', extension: assetPasteAugmentation({ store }) },
        // After asset-paste: clipboard files with no plain text are that route's; HTML is this one's.
        { name: 'rich-paste', extension: richPasteAugmentation({ store }) },
        {
            name: 'wikilink',
            extension: wikilinkAugmentation({
                isMissing: services.conceptIsMissing,
                onOpen: services.openConcept,
                onLinkEdited: services.wikilinkEdited,
                onContextMenu: services.wikilinkContextMenu,
                // Restyle when the index catches up: an editor opened during the initial build
                // otherwise shows every link as missing until edited.
                onIndexUpdated: (listener) => services.graphIndex()?.onUpdated(listener) ?? (() => {}),
            }),
        },
        // The pointer cursor over every link kind above (and the caret cursor while the mod key is held).
        { name: 'link-cursor', extension: linkCursorAugmentation() },
        // Completions and the popovers they open, after the decorations they anchor to.
        {
            name: 'wikilink-completion',
            extension: wikilinkCompletion({
                concepts: () => services.graphIndex()?.allConcepts() ?? [],
                loading: () => services.graphIndex()?.isBuilding() ?? false,
            }),
        },
        { name: 'task-tag-completion', extension: taskTagCompletion() },
        { name: 'slash-completion', extension: slashCompletion() },
        {
            name: 'date-calendar',
            extension: dateCalendar({
                // The candidate snapshot already carries every concept the graph resolves,
                // so marking written days costs a filter over data the editor holds (ADR 0056).
                hasEntry: (iso) => resolvedConcepts().has(iso),
            }),
        },
        // The Table Size Picker: the insert-table Command's popover, a sibling of the calendar.
        { name: 'table-size-picker', extension: tableSizePicker() },
        // A refused edit reaches the user: after every filter that can refuse one.
        { name: 'edit-refusal', extension: editRefusalReporter(services.editRefused ?? (() => {})) },
        // The View's own hooks last: focus makes this editor the active one; updates keep the
        // Command Bar context, reading position and pending reveals in step.
        {
            name: 'view-hooks',
            extension: [
                EditorView.domEventHandlers({
                    focus(_event, view) {
                        services.onFocus(view)
                        return false
                    },
                }),
                EditorView.updateListener.of(services.onUpdate),
            ],
        },
    ]
}

/** The flat extension list `createDocumentEditor` loads. */
export function editorExtensions(services: EditorExtensionServices): Extension[] {
    return editorFeatures(services).map((feature) => feature.extension)
}
