/**
 * Augmentation host: **the protected fence** (ADR 0028, ADR 0058, ADR 0060).
 *
 * A [[Protected Document]] whose fence is still in the editor's text is one we could NOT open —
 * locked, or another member's. It renders as an atomic block card and its interior is read-only,
 * because ciphertext has no character-level meaning and one stray keystroke destroys an envelope
 * for good.
 *
 * A **readable** document never reaches here at all: `ProtectedEditorDocument` replaces the whole
 * text with the decrypted body before the editor sees it, so an unlocked Protected Document is
 * ordinary editable content with every augmentation, completion and slash command applying to it
 * unchanged. Nothing is drawn for it here; the tab padlock and the sidebar control carry the state.
 *
 * Only a fence that is the document's **entire body** counts (ADR 0060). A cipher fence anywhere
 * else is ordinary markdown — a code block that happens to hold base64 — and this module ignores
 * it entirely, as does everything else.
 *
 * Unlike every other augmentation here, the locked card **never consults the reveal policy**.
 * Moving the caret into a locked fence must not expose its source; there is nothing there to
 * expose, and revealing base64 would only look broken. `blockWidgetField` is therefore
 * deliberately not reused — it hides its widget when a line is revealed.
 *
 * With no graph open every fence reads as locked, which is the safe default: a graph whose
 * protection has not loaded yet must not imply the content is someone else's.
 */
import { EditorSelection, EditorState, type Extension, Facet, type Range, StateEffect, StateField, type Text } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'

import {
    type ProtectionStatus,
    getActiveProtectionStatus,
    protectionGeneration,
} from '$lib/document/protection/active-protection'
import type { FenceUnreadableReason } from '$lib/document/protection/protection-service'

import { iconSvg } from '$lib/surface/icons'

import { EXTERNAL } from '../cm-document'
import { refuseEdit } from '../edit-refused'
import type { Backend } from '$lib/document/frontmatter/proposal'
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import {
    type ProtectedRange,
    changeTouchesProtected,
    clampOutsideFence,
    lockedCaretHome,
    protectedRanges,
    protectionWouldVanish,
} from './protected-fence-core'
import { type GuardedChange, frontmatterWouldVanish } from '$lib/document/frontmatter/boundary'

/**
 * Whether this editor's document is a [[Protected Document]].
 *
 * Supplied per editor by the View, from the document itself, because the editor cannot tell on
 * its own once unlocked: the projected text is frontmatter followed by ordinary plaintext, with
 * no fence left to find. The frontmatter of a Protected Document is editable in both states
 * (ADR 0061) - it is the part that is *not* protected - and the one thing an edit may not do is
 * make the block vanish, because the title line would then be sealed into the ciphertext.
 */
export type IsProtectedDocument = () => boolean

/**
 * The document's own answer to "am I a Protected Document?", readable from any editor state. What
 * a Command or an upload asks before writing to the body (`view/body-writable.ts`), since the
 * active-view accessor cannot say which pane a drop landed on. Combined so that any provider
 * saying protected wins; an editor with no augmentation reads as not protected.
 */
export const isProtectedDocumentFacet = Facet.define<IsProtectedDocument, IsProtectedDocument>({
    combine: (values) => () => values.some((isProtected) => isProtected()),
})

export interface ProtectedFenceOptions {
    isProtected?: IsProtectedDocument
    /**
     * Which backend the open graph stores documents on, for the locked card's note about
     * attached assets: unencrypted files in the folder on one, encrypted-for-the-graph on the
     * other, and in neither case covered by the passphrase. Null outside a graph.
     */
    backend?: () => Backend | null
}

/**
 * What the locked card says about a document's attached images and files. Protection covers the
 * document's text and nothing else: an asset is stored by the graph, not inside the fence, and
 * any document can link to it. Said on the card, where someone is looking at a padlock and may
 * reasonably assume it covers the picture they dropped in.
 */
export function assetsNote(backend: Backend | null): string {
    if (backend === 'filesystem') {
        return 'Images and files attached to this document are not protected: they are saved as ordinary files in the graph folder, and a link to one from any other document shows it.'
    }
    if (backend === 'server') {
        return 'Images and files attached to this document are not protected by your passphrase: they are encrypted for the graph, so any member can open them, and a link to one from any other document shows it.'
    }
    return 'Images and files attached to this document are not protected, and a link to one from any other document shows it.'
}

/**
 * What the locked card says about the text itself, for someone who wants to know what "protected"
 * means rather than take the padlock on trust: the body is ciphertext under the graph's Protection
 * Key, and the key is unwrapped only by the passphrase or a bound passkey. Mentions the frontmatter
 * only when there is one to point at.
 */
export function encryptionNote(hasFrontmatter: boolean): string {
    const what = hasFrontmatter ? 'Everything below the frontmatter' : 'The document’s text'
    return `${what} is encrypted with this graph’s Protection Key.`
}

/**
 * Dispatched when the lock state changes or a decryption completes, so the card redraws.
 * Needed because neither is a document change: the text is identical, only what we can say
 * about it has moved.
 */
export const protectionTick = StateEffect.define<void>()

class ProtectedFenceWidget extends WidgetType {
    constructor(
        private readonly reason: FenceUnreadableReason,
        private readonly status: ProtectionStatus | null,
        private readonly backend: Backend | null,
        private readonly hasFrontmatter: boolean,
    ) {
        super()
    }

    // Redraw only when what the card SAYS changes. Without this the widget is rebuilt on every
    // keystroke elsewhere in the document, and a block widget rebuild re-measures heights.
    eq(other: ProtectedFenceWidget): boolean {
        return other.reason === this.reason && other.backend === this.backend && other.hasFrontmatter === this.hasFrontmatter
    }

    toDOM(): HTMLElement {
        // The widget's root is a plain block that carries the card's spacing as PADDING: CodeMirror
        // measures a block widget by its border box, so a margin on the card would be height the map
        // never sees, and every line below the card would drift by it (ADR 0022's height-integrity
        // rule; block-widget-height-map.test.ts). The card inside keeps its surface and its classes.
        const block = document.createElement('div')
        block.className = 'gk-protected-block'
        const card = block.appendChild(document.createElement('div'))
        card.className = `gk-protected gk-protected--${this.reason}`
        // Below the frontmatter the card keeps the same distance the block keeps from the top of
        // the editor - the content's own top padding - so the two read as evenly spaced.
        if (this.hasFrontmatter) {
            block.classList.add('gk-protected-block--after-frontmatter')
            // The card keeps the marker as a statement of what it is (protected-documents.test.ts reads
            // it); the gap itself is the root's padding.
            card.classList.add('gk-protected--after-frontmatter')
        }
        card.setAttribute('role', 'group')
        card.append(...this.lockedFace())
        return block
    }

    private lockedFace(): HTMLElement[] {
        if (this.reason === 'other-member') {
            return [
                header('Protected by another member'),
                note('This is encrypted with someone else’s Protection Key. No passphrase of yours will open it.'),
                this.assets(),
            ]
        }
        if (this.reason === 'unreadable') {
            return [header('Protected content damaged'), note('This fence holds nothing that can be decrypted.')]
        }
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'gk-protected-unlock'
        button.textContent = 'Unlock'
        button.addEventListener('click', (event) => {
            event.preventDefault()
            this.status?.requestUnlock()
        })
        const encryption = note(encryptionNote(this.hasFrontmatter))
        encryption.setAttribute('data-testid', 'protected-encryption-note')
        return [header('Protected'), note('Locked. Unlock this graph to read it.'), encryption, this.assets(), button]
    }

    private assets(): HTMLElement {
        const el = note(assetsNote(this.backend))
        el.classList.add('gk-protected-assets')
        el.setAttribute('data-testid', 'protected-assets-note')
        el.setAttribute('data-backend', this.backend ?? 'none')
        return el
    }

    /** The widget owns real interactive DOM (the button), so CodeMirror must not swallow events. */
    ignoreEvent(): boolean {
        return false
    }
}

function header(title: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'gk-protected-title'
    el.innerHTML = iconSvg('lock', { size: 14 })
    el.append(document.createTextNode(` ${title}`))
    return el
}

function note(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'gk-protected-note'
    el.textContent = text
    return el
}

const beforeCard = Decoration.line({ class: 'gk-frontmatter-before-card' })

function buildDecorations(state: EditorState, backend: () => Backend | null): DecorationSet {
    const status = getActiveProtectionStatus()
    const text = state.doc.toString()
    const decos: Range<Decoration>[] = []
    // At most one: the whole-body fence of a Protected Document we could not open. A readable
    // document has been projected away by `ProtectedEditorDocument` before reaching here.
    for (const range of protectedRanges(text)) {
        // The frontmatter's gap below itself is for a first line of TEXT; above the card it only
        // pushes the card away, so the block's last row is told a card follows.
        if (range.from > 0) decos.push(beforeCard.range(state.doc.lineAt(range.from - 1).from))
        const reason = status?.reasonAt(text, range.from) ?? 'locked'
        const widget = new ProtectedFenceWidget(reason, status, backend(), frontmatterSpan(text) !== null)
        decos.push(Decoration.replace({ widget, block: true }).range(range.from, range.to))
    }
    return Decoration.set(decos, true)
}

/**
 * The guard. A user edit that would reach inside the fence is dropped whole rather than clamped:
 * there is no partially-correct edit to ciphertext. And on a Protected Document in either state,
 * an edit that would make its frontmatter block vanish is refused (ADR 0061) - everything else
 * in the block is typed into like any other frontmatter.
 *
 * The block's other edges - body text may not join onto its closer, and it may not grow past
 * what was typed into it - are every document's rules and are held once, for all, by the
 * frontmatter boundary filter (`view/frontmatter-boundary.ts`).
 *
 * Two things pass through — a remote or git-reload write (`EXTERNAL`), and deleting the fence
 * outright, which is how you delete a Protected Document's body and needs no key.
 *
 * The vanishing-block refusal carries its reason (`../edit-refused.ts`) so the View can say why;
 * the fence's own refusals stay silent, since the card and the caret clamp already show the
 * state.
 */
function guard(isProtected: IsProtectedDocument): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr
        if (tr.annotation(EXTERNAL)) return tr

        const changes: GuardedChange[] = []
        tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => changes.push({ from: fromA, to: toA, inserted: toB - fromB }))

        const before = tr.startState.doc.toString()
        const ranges = protectedRanges(before)
        // Locked, the fence is in the text; unlocked, only the document knows it is protected.
        if (ranges.length > 0 || isProtected()) {
            let materialised: string | null = null
            const after = () => (materialised ??= tr.newDoc.toString())
            if (frontmatterWouldVanish(before, changes, after)) return refuseEdit('frontmatter-vanish')
            if (ranges.length > 0 && protectionWouldVanish(before, changes, after)) return []
        }
        if (ranges.length === 0) return tr
        return changeTouchesProtected(ranges, changes, { allowWholeFence: true }) ? [] : tr
    })
}

/**
 * The fence range per document text, so the selection clamp below costs nothing per caret move:
 * a locked document's text only changes when the store rewrites it, and an unlocked one - whose
 * projection may be long - is materialised once per version rather than per click.
 */
const lockedByDoc = new WeakMap<Text, { ranges: ProtectedRange[]; home: number }>()

/**
 * Whether the cipher fence is in this text - locked, masked, or another member's - which is the
 * exact condition under which the guard drops body edits. The session flips to unlocked before
 * the projected plaintext lands, so `body-writable.ts` asks this as well as the session.
 */
export function fenceInText(doc: Text): boolean {
    return lockedFor(doc).ranges.length > 0
}

function lockedFor(doc: Text): { ranges: ProtectedRange[]; home: number } {
    let locked = lockedByDoc.get(doc)
    if (!locked) {
        const text = doc.toString()
        const ranges = protectedRanges(text)
        locked = { ranges, home: lockedCaretHome(text, ranges) ?? 0 }
        lockedByDoc.set(doc, locked)
    }
    return locked
}

/**
 * The selection clamp. While the fence is in the text - the document is locked, or another
 * member's - the caret may rest only in the frontmatter: parked beside the card it looked like
 * document content, which a card is not, and invited typing into something with no characters.
 * Only for a Protected Document, so an ordinary document never pays for the lookup.
 */
function selectionClamp(isProtected: IsProtectedDocument): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.selection || !isProtected()) return tr
        const { ranges, home } = lockedFor(tr.newDoc)
        if (ranges.length === 0) return tr
        const main = tr.newSelection.main
        const head = clampOutsideFence(ranges, main.head, home)
        const anchor = clampOutsideFence(ranges, main.anchor, home)
        if (head === main.head && anchor === main.anchor && tr.newSelection.ranges.length === 1) return tr
        return [tr, { selection: EditorSelection.range(anchor, head), sequential: true }]
    })
}

/**
 * With no frontmatter a locked document is the card and nothing else, so there is nothing a caret
 * could be placed in; `lockedCaretHome` can only offer the document start, in front of the card.
 * The editor is made non-editable for exactly that state, which is what takes the caret away.
 * Computed from the document, so the moment the projection or a block arrives it is editable again.
 */
const editableUnlessBareLocked = EditorView.editable.compute(['doc'], (state) => {
    const { ranges } = lockedFor(state.doc)
    return !(ranges.length > 0 && ranges[0].from === 0)
})

const theme = EditorView.baseTheme({
    // The gap between the card and the lines around it, on the widget's root, as padding (see toDOM).
    '.gk-protected-block': { padding: '0.35em 0' },
    // The editor content's top padding (cm-document.ts), which is the gap the block keeps from
    // the top of the editor; the card keeps the same from the block.
    '.gk-protected-block--after-frontmatter': { paddingTop: '0.75rem' },
    '.gk-protected': {
        display: 'flow-root',
        padding: '0.6em 0.8em',
        borderRadius: '6px',
        background: 'var(--gk-code-bg, rgba(127,127,127,0.10))',
        textIndent: '0',
        whiteSpace: 'normal',
    },
    // Flex, because the app's base styles make every `svg` display:block — which put the padlock
    // on its own line above the title instead of beside it.
    '.gk-protected-title': { display: 'flex', alignItems: 'center', gap: '0.35em', fontWeight: '600', fontSize: '0.9em' },
    '.gk-protected-title svg': { flex: 'none' },
    '.gk-protected-note': { fontSize: '0.85em', opacity: '0.8', marginTop: '0.2em' },
    '.gk-protected-assets': { marginTop: '0.45em' },
    // Four classes out-specify the frontmatter theme's three: the block's own gap - sized for a
    // first line of text - is dropped when the card follows, and the card root's padding is the gap.
    '.cm-line.gk-frontmatter.gk-code-block-last.gk-frontmatter-before-card': { paddingBottom: '0.2em' },
    '.cm-line.gk-frontmatter.gk-code-block-last.gk-frontmatter-before-card::after': { bottom: '0' },
    '.gk-protected-unlock': {
        marginTop: '0.5em',
        padding: '0.25em 0.8em',
        borderRadius: '5px',
        border: '1px solid var(--gk-protected-border, rgba(127,127,127,0.45))',
        background: 'transparent',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '0.85em',
    },
    '.gk-protected--other-member': { opacity: '0.75' },
})

/**
 * Keeps every mounted editor in step with the protection generation, not just the focused one.
 *
 * `protectionTick` can only be dispatched into a view someone holds a reference to — in practice
 * the active one — so a second document pane would sit on a stale locked card after unlocking.
 * Each editor carries its own copy of this plugin and refreshes itself when the counter moves,
 * which costs an integer compare per update and needs no registry of open views.
 */
const generationWatcher = ViewPlugin.fromClass(
    class {
        private seen = protectionGeneration()

        constructor(readonly view: EditorView) { }

        update(): void {
            const current = protectionGeneration()
            if (current === this.seen) return
            this.seen = current
            // Out of the update cycle: dispatching from inside one is what CodeMirror warns about.
            queueMicrotask(() => this.view.dispatch({ effects: protectionTick.of() }))
        }
    },
)

/** The protected-fence augmentation. Mounted in DocumentView alongside the others. */
export function protectedFenceAugmentation(options: ProtectedFenceOptions = {}): Extension {
    const isProtected = options.isProtected ?? (() => false)
    const backend = options.backend ?? (() => null)
    const field = StateField.define<DecorationSet>({
        create: (state) => buildDecorations(state, backend),
        update(deco, tr) {
            // Rebuilt on any document change and on the protection tick the host dispatches when
            // the lock state or a decryption result changes. Never on selection: reveal does not
            // apply to a protected fence.
            if (tr.docChanged || tr.effects.some((e) => e.is(protectionTick))) {
                return buildDecorations(tr.state, backend)
            }
            return deco
        },
        provide: (f) => EditorView.decorations.from(f),
    })
    return [
        field,
        generationWatcher,
        isProtectedDocumentFacet.of(isProtected),
        guard(isProtected),
        selectionClamp(isProtected),
        editableUnlessBareLocked,
        theme,
    ]
}
