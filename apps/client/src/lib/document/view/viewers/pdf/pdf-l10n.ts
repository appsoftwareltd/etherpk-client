/**
 * The strings pdf.js's viewer asks for, in place of its own localisation. Its stock one fetches a
 * locale list this build does not serve, and writes strings holding markup to `innerHTML`. The
 * Client's interface is English, and the viewer's visible chrome is the Client's own, so what is
 * left is the accessible name of a page and of a few form controls.
 */
const STRINGS: Record<string, (args: Record<string, unknown>) => string> = {
    'pdfjs-page-landmark': (args) => `Page ${String(args.page ?? '')}`.trim(),
    'pdfjs-text-annotation-type': () => 'Annotation',
    'pdfjs-password-label': () => 'Password',
}

function text(id: string, args: Record<string, unknown>, fallback?: string): string {
    return STRINGS[id]?.(args) ?? fallback ?? ''
}

function argsOf(element: HTMLElement): Record<string, unknown> {
    try {
        return JSON.parse(element.getAttribute('data-l10n-args') ?? '{}') as Record<string, unknown>
    } catch {
        return {}
    }
}

function translateOne(element: HTMLElement): void {
    const id = element.getAttribute('data-l10n-id')
    if (!id || !STRINGS[id]) return
    element.setAttribute('aria-label', text(id, argsOf(element)))
}

export const pdfL10n = {
    getLanguage: () => 'en-GB',
    getDirection: () => 'ltr' as const,
    get: async (ids: string | string[], args: Record<string, unknown> = {}, fallback?: string) => {
        if (Array.isArray(ids)) return ids.map((id) => text(id, args, fallback))
        return text(ids, args, fallback)
    },
    translate: async (element: HTMLElement | DocumentFragment) => {
        if (element instanceof HTMLElement) translateOne(element)
        for (const child of element.querySelectorAll<HTMLElement>('[data-l10n-id]')) translateOne(child)
    },
    translateOnce: async (element: HTMLElement) => translateOne(element),
    destroy: async () => {},
    pause: () => {},
    resume: () => {},
}
