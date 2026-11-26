/**
 * What an open graph, and an open Plain Folder, print (ADR 0207): the workspace's side of
 * `print-commands.ts`. Plain TypeScript over injected parts, so the rules test without a workspace.
 * The code that renders is fetched the first time something is printed.
 */
import type { PublishedFence } from '@appsoftwareltd/etherpk-extension-api'

import { isExtensionFenceInfo } from '#lib/document/extension-fence.js'
import type { PrintCommandDeps, PrintSubject } from '#lib/document/commands/print-commands.js'
import { ProtectedPrintError, protectedNow, textToPrint } from '#lib/document/print/print-text.js'
import type { PrintEnvironment } from '#lib/document/print/render-for-print.js'
import type { DocumentStore } from '#lib/document/types.js'
import { findFence } from '#lib/document/view/detached-fence.js'
import { quotedFences } from '#lib/document/view/quoted-fences.js'
import { type FenceRef, parseFenceViewTarget } from '#lib/document/view/fence-hosting.js'

import type { InteractiveFence } from '#lib/document/view/augmentations/interactive-fence-contract.js'
import type { ViewRef } from '#lib/layout/index.js'

/** Pictures on the web and in the text itself are shown where they are. */
const isWebAddress = (reference: string) => /^https?:/i.test(reference)
const isEmbedded = (reference: string) => /^data:image\//i.test(reference)

export interface GraphPrintParts {
    /** The store the editors read, an unlocked Protected Document seen as one. */
    store(): DocumentStore | null
    isProtected(concept: string): boolean
    /** What draws diagrams and maps. */
    drawing(): Pick<PrintEnvironment, 'renderMermaid' | 'renderMap'>
    /** Where an asset the graph holds is, by its reference. */
    asset(reference: string): Promise<string | null>
    /** The View in front in the main region. */
    front(): ViewRef | null
    fence(info: string): InteractiveFence | null | undefined
    /**
     * What an open [[Block View]] prints (ADR 0209): its document, its title and its Block's
     * markdown, or null when no such View is open or it has no Block. Absent where there are none.
     */
    block?(target: string): { document: string; title: string; markdown: string } | null
}

function documentOrFence(view: ViewRef | null): PrintSubject | null {
    if (view?.kind === 'document') return { kind: 'document', target: view.target }
    if (view?.kind === 'block') return { kind: 'block', target: view.target }
    return view?.kind === 'fence' ? { kind: 'fence', target: view.target } : null
}

export function graphPrinting(parts: GraphPrintParts): PrintCommandDeps {
    /** Asked again at each step: protection can arrive from another device while a print is prepared. */
    const refuseProtected = (concept: string) => {
        if (parts.isProtected(concept)) throw new ProtectedPrintError('This is a Protected Document')
    }

    /**
     * What an extension's fence prints as: what a quote of the fence shows, which is made for any
     * document. Its `publish` is called for public content only, as the Extension API promises. With
     * nothing to show, an ordinary fence prints as its code and an Extension Fence is left out.
     */
    const quoted: PrintEnvironment['publishFence'] = ({ info, body, document }) => {
        const fence = parts.fence(info)
        if (!fence?.quote) return undefined
        refuseProtected(document)
        const answer = quotedFences.quote(fence, { info, body, document, dark: false })
        return isExtensionFenceInfo(info) ? answer : orCode(answer)
    }

    /** As the dialog is about to open: the last moment a document that became protected is kept back. */
    const ready = (concept: string, onReady: () => void) => () => {
        refuseProtected(concept)
        if (protectedNow(storeNow(), concept)) throw new ProtectedPrintError('This is a Protected Document')
        onReady()
    }

    /** What draws a document's diagrams and maps. A map is drawn by an extension, so it is asked about too. */
    function drawnFor(concept: string): PrintEnvironment {
        const { renderMermaid, renderMap } = parts.drawing()
        const guarded: PrintEnvironment['renderMap'] = async (source) => {
            refuseProtected(concept)
            return renderMap!(source)
        }
        return { renderMermaid, ...(renderMap ? { renderMap: guarded } : {}), publishFence: quoted }
    }

    /** The fence a tab shows, with its registration, where the extension gives a picture of it. */
    function drawing(target: string): { ref: FenceRef; fence: InteractiveFence } | null {
        const ref = parseFenceViewTarget(target)
        const fence = ref && parts.fence(ref.info)
        return ref && fence?.quote && fence.identify ? { ref, fence } : null
    }

    const concept = (subject: PrintSubject) => {
        if (subject.kind === 'document') return subject.target
        if (subject.kind === 'block') return parts.block?.(subject.target)?.document ?? subject.target
        return parseFenceViewTarget(subject.target)?.document ?? subject.target
    }

    function storeNow(): DocumentStore {
        const store = parts.store()
        if (!store) throw new Error('The graph is closed')
        return store
    }

    async function printDrawing(target: string, onReady: () => void) {
        const found = drawing(target)
        if (!found) throw new Error('Its extension is switched off or not installed')
        const { ref, fence } = found
        const picture = await pictureOf(ref, fence, await textToPrint(storeNow(), ref.document))
        const { printPicture } = await import('#lib/document/print/print-document.js')
        return printPicture(picture, { name: ref.document, onReady: ready(ref.document, onReady) })
    }

    /** A Block View's Block and what is nested under it, headed by its title over its document's name. */
    async function printBlock(target: string, onReady: () => void) {
        const block = parts.block?.(target)
        if (!block) throw new Error('The block is no longer open')
        refuseProtected(block.document)
        const { printDocument } = await import('#lib/document/print/print-document.js')
        return printDocument(
            { name: block.document, heading: block.title || block.document, from: block.document, text: block.markdown },
            {
                environment: drawnFor(block.document),
                picture: async (reference) => (isWebAddress(reference) || isEmbedded(reference) ? reference : parts.asset(reference)),
                onReady: ready(block.document, onReady),
            },
        )
    }

    return {
        nameOf: concept,
        active: () => documentOrFence(parts.front()),
        printable(subject) {
            if (subject.kind === 'fence' && drawing(subject.target) === null) return 'no'
            if (subject.kind === 'block' && !parts.block?.(subject.target)) return 'no'
            return parts.isProtected(concept(subject)) ? 'protected' : 'yes'
        },
        async print(subject, onReady) {
            if (subject.kind === 'fence') return printDrawing(subject.target, onReady)
            if (subject.kind === 'block') return printBlock(subject.target, onReady)
            const text = await textToPrint(storeNow(), subject.target)
            const { printDocument } = await import('#lib/document/print/print-document.js')
            return printDocument(
                { name: subject.target, text },
                {
                    environment: drawnFor(subject.target),
                    picture: async (reference) => (isWebAddress(reference) || isEmbedded(reference) ? reference : parts.asset(reference)),
                    onReady: ready(subject.target, onReady),
                },
            )
        },
    }
}

/** An ordinary fence an extension shows nothing for is its code: the publisher reads a failure as that. */
async function orCode(answer: Promise<PublishedFence | null>): Promise<PublishedFence> {
    const out = await answer
    if (out === null) throw new Error('it has nothing to show')
    return out
}

/** The picture an extension gives of its fence, as a quote of the fence shows it. */
async function pictureOf(ref: FenceRef, fence: InteractiveFence, text: string): Promise<Extract<PublishedFence, { kind: 'picture' }>> {
    const body = findFence(text, ref, fence.identify!.bind(fence))?.body
    if (!body) throw new Error(`It is no longer in "${ref.document}"`)
    const answer = await quotedFences.quote(fence, { info: ref.info, body, document: ref.document, dark: false })
    if (answer?.kind !== 'picture') throw new Error('It is empty')
    return answer
}

export interface PlainPrintParts {
    store(): DocumentStore | null
    environment(): PrintEnvironment | Promise<PrintEnvironment>
    /** Whether the file opens in the Markdown Editor: a file shown as text does not print. */
    isMarkdown(path: string): boolean
    /** Where a file the folder holds is, by a reference in the file at `path`. */
    file(path: string, reference: string): Promise<string | null>
    /** Whether pictures from the web load in this folder. */
    remoteImages(): boolean
    nameOf(path: string): string
    front(): ViewRef | null
}

export function plainPrinting(parts: PlainPrintParts): PrintCommandDeps {
    return {
        nameOf: (subject) => parts.nameOf(subject.target),
        active: () => documentOrFence(parts.front()),
        printable: (subject) => (subject.kind === 'document' && parts.isMarkdown(subject.target) ? 'yes' : 'no'),
        async print(subject, onReady) {
            const store = parts.store()
            if (!store) throw new Error('The folder is closed')
            const text = await textToPrint(store, subject.target)
            const { printDocument } = await import('#lib/document/print/print-document.js')
            return printDocument(
                { name: parts.nameOf(subject.target), text },
                {
                    environment: await parts.environment(),
                    // A picture on the web waits for the person's word here, in print as on screen.
                    picture: async (reference) => {
                        if (isWebAddress(reference)) return parts.remoteImages() ? reference : null
                        return isEmbedded(reference) ? reference : parts.file(subject.target, reference)
                    },
                    onReady,
                },
            )
        },
    }
}
