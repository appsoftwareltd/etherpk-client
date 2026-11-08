/** The parts of foliate-js the frame uses. It ships as plain JavaScript with no types. */
declare module 'foliate-js/view.js' {
    export interface FoliateContents {
        doc: Document
        index: number
        overlayer?: { element: SVGElement; add(key: string, range: Range, draw: unknown, options?: unknown): void; remove(key: string): void }
    }
    export interface FoliateRenderer extends HTMLElement {
        setStyles?(styles: string): void
        getContents(): FoliateContents[]
        next(): Promise<void>
        prev(): Promise<void>
        nextSection(): Promise<void>
        scrollToAnchor(anchor: Range): Promise<void>
        primaryIndex: number
    }
    export interface FoliateRelocate {
        cfi: string
        fraction: number
        range?: Range
        tocItem?: { label?: string }
        pageItem?: { label?: string }
        time?: { section?: number; total?: number }
    }
    export interface FoliateEbook {
        dir?: string
        toc?: { label: string; href: string; subitems?: unknown[] }[]
        pageList?: unknown[]
        metadata?: { title?: unknown; author?: unknown; language?: unknown }
        rendition?: { layout?: string }
        sections: unknown[]
        isExternal?(href: string): boolean
        transformTarget?: EventTarget
    }
    export class View extends HTMLElement {
        book: FoliateEbook
        renderer: FoliateRenderer
        isFixedLayout: boolean
        lastLocation: FoliateRelocate | null
        history: EventTarget & { canGoBack: boolean; canGoForward: boolean; back(): void; forward(): void }
        open(book: unknown): Promise<void>
        init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>
        close(): void
        next(): Promise<void>
        prev(): Promise<void>
        goTo(target: string): Promise<unknown>
        goToFraction(fraction: number): Promise<void>
        getCFI(index: number, range?: Range): string
        getProgressOf(index: number, range: Range): { tocItem?: { label?: string } }
        getCFIProgress(cfi: string): Promise<{ fraction: number } | null>
        resolveCFI(cfi: string): { index: number }
        addAnnotation(annotation: { value: string; colour?: string; hasNote?: boolean }, remove?: boolean): Promise<unknown>
        deleteAnnotation(annotation: { value: string }): Promise<unknown>
        search(options: { query: string }): AsyncGenerator<unknown>
        clearSearch(): void
        deselect(): void
    }
}
declare module 'foliate-js/dict.js' {
    export class StarDict {
        ifo: Record<string, string>
        loadIfo(file: Blob): Promise<void>
        loadDict(file: Blob, inflate: (chunk: Uint8Array) => Uint8Array): Promise<void>
        loadIdx(file: Blob): Promise<void>
        loadSyn(file?: Blob): Promise<void> | undefined
        lookup(query: string): Promise<{ word: string; data: [string, Uint8Array][] }[]>
    }
}
declare module 'foliate-js/tts.js' {
    export function getSentences(doc: Document, walker: unknown, nodeFilter: ((node: Node) => number) | undefined, granularity: 'sentence' | 'word'): Generator<{ blockIndex: number; markName: string; range: Range }>
}
declare module 'foliate-js/text-walker.js' {
    export const textWalker: unknown
}
declare module 'foliate-js/footnotes.js' {
    export class FootnoteHandler extends EventTarget {
        handle(book: unknown, event: Event): Promise<void> | undefined
    }
}
declare module 'foliate-js/epub.js' {
    export class EPUB {
        constructor(loader: {
            entries: { filename: string }[]
            loadText(name: string): Promise<string | null> | string | null
            loadBlob(name: string, type?: string): Promise<Blob | null> | Blob | null
            getSize(name: string): number
            sha1?(text: string): Promise<Uint8Array>
        })
        init(): Promise<import('foliate-js/view.js').FoliateEbook>
    }
}
declare module 'foliate-js/overlayer.js' {
    export class Overlayer {
        static highlight(rects: unknown, options?: { color?: string }): SVGElement
        static underline(rects: unknown, options?: { color?: string; width?: number }): SVGElement
        static outline(rects: unknown, options?: { color?: string; width?: number }): SVGElement
    }
}
declare module 'foliate-js/epubcfi.js' {
    export function collapse(cfi: string, toEnd?: boolean): string
    export function compare(a: string, b: string): number
}
