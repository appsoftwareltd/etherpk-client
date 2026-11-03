/**
 * Excalidraw and React, loaded the first time a drawing is drawn, so a document with none never
 * downloads them, and the Client's first load carries none of them. Excalidraw's stylesheet comes
 * with them, scoped under its own classes by the Client's build (`build-plugins/vite-plugins.ts`).
 *
 * Excalidraw's fonts are files of the Client's own build: the build gives every font Excalidraw
 * names its full address on the Client's origin, so Excalidraw needs no `EXCALIDRAW_ASSET_PATH`
 * and never reaches for a font anywhere else.
 */
import type * as ExcalidrawModule from '@excalidraw/excalidraw'
import type * as ReactModule from 'react'
import type * as ReactDomClient from 'react-dom/client'

export interface ExcalidrawKit {
    excalidraw: typeof ExcalidrawModule
    react: typeof ReactModule
    createRoot: typeof ReactDomClient.createRoot
}

let kit: Promise<ExcalidrawKit> | null = null

export function loadExcalidraw(): Promise<ExcalidrawKit> {
    kit ??= (async () => {
        const [excalidraw, react, client] = await Promise.all([
            import('@excalidraw/excalidraw'),
            import('react'),
            import('react-dom/client'),
            import('@excalidraw/excalidraw/index.css'),
        ])
        return { excalidraw, react, createRoot: client.createRoot }
    })()
    // A failed load is not kept, so the next drawing tries again.
    kit.catch(() => {
        kit = null
    })
    return kit
}
