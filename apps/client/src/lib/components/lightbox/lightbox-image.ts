/**
 * An image as the [[Lightbox]] shows it, kept apart from the component that draws it (`lightbox.ts`),
 * so what builds one (the asset Commands, `context.assets.viewImages`) needs no Svelte to load.
 */
import type { AssetStore } from '#lib/storage/fs/asset-store.js'

/** One image the Lightbox can show. */
export interface LightboxImage {
    /** The heading over the image, and its alt text. */
    name: string
    /**
     * Read the address the image shows at. Asked when the image is first shown, so a run of
     * pictures reads only those a person steps to. Null, or a rejection, shows the image as one
     * that could not be loaded.
     */
    load(): Promise<string | null>
}

/** One of the graph's assets as the Lightbox shows it, read through `store` as the editor reads the images it draws. */
export function assetLightboxImage(store: () => AssetStore | null, ref: string, name: string): LightboxImage {
    return { name, load: async () => (await store()?.resolve(ref))?.url ?? null }
}
