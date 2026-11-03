import type { ExtensionIcons, ExtensionStorage } from '@appsoftwareltd/etherpk-extension-api'

/** What an Ink drawing's widget needs from the extension's context, beyond its fence. */
export interface InkServices {
    icons: ExtensionIcons
    /** This device's storage for the extension, where the chosen brushes are remembered. */
    storage: ExtensionStorage | null
    /** Whether the layout is desktop-like, where a drawing is edited in the document. */
    isDesktop(): boolean
    /** The column width drawings were last measured at, which `height` fits pictures to. */
    columnWidth: number
}
