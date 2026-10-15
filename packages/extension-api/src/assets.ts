/**
 * Images an extension hands to the open graph (ADR 0147): made smaller the way a pasted image is,
 * and kept as one of the graph's assets, so a document can show it.
 */

/**
 * The open graph's assets, as far as an extension may add to them.
 *
 * @beta
 */
export interface ExtensionAssets {
    /**
     * An image made ready to send or keep, as a pasted image is: a large photo or screenshot is
     * scaled down and re-encoded, and an image that is small enough comes back as it was. Rejects
     * when the bytes are not an image the browser can read.
     */
    prepareImage(image: Blob): Promise<Blob>
    /**
     * Keep an image as one of the graph's assets, and answer the markdown that shows it in a
     * document, such as `![photo](assets/photo.webp)`. Null where the graph keeps no assets here,
     * or the image was refused.
     */
    saveImage(image: Blob, name: string): Promise<string | null>
}
