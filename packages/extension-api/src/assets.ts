/**
 * Images an extension hands to the open graph (ADR 0147): made smaller the way a pasted image is,
 * and kept as one of the graph's assets, so a document can show it. And the assets a document
 * refers to, named and shown as the document's own editor names and shows them.
 */

/**
 * What a document's reference to an asset names.
 *
 * @public
 */
export interface AssetDescription {
    /**
     * The file's name as a person reads it, without the hash or id the graph adds to keep names
     * apart: `plan.png` for `plan.3f9a1c2e.png`.
     */
    name: string
    /** The file's whole name, as the reference writes it: for a tooltip, or where two names read alike. */
    fileName: string
    /** A document shows the asset as an image. */
    image: boolean
}

/**
 * Images to show in the Client's Lightbox, the dialog a picture's View larger opens.
 *
 * @public
 */
export interface ViewImagesOptions {
    /**
     * The images, as a document's references write them (`../assets/plan.3f9a1c2e.png`), in the
     * order Previous and Next step through them. A reference that names no image asset is left out.
     */
    refs: readonly string[]
    /** The reference the Lightbox opens on. The first image when left out, or when it is not among them. */
    start?: string
}

/**
 * What became of an image given to {@link ExtensionAssets.storeImage}.
 *
 * @beta
 */
export type StoredImage =
    | {
          stored: true
          /** The reference a document writes for the image, such as `../assets/plan.3f9a1c2e.webp`. */
          ref: string
          /** The markdown that shows the image in a document, as {@link ExtensionAssets.saveImage} answers. */
          markdown: string
      }
    | {
          stored: false
          /** Why not, in words for the person, such as that the account's storage is full. */
          reason: string
      }

/**
 * The open graph's assets, as far as an extension may add to them.
 *
 * @public
 */
export interface ExtensionAssets {
    /**
     * An image made ready to send or keep, as a pasted image is: a large photo or screenshot is
     * scaled down and re-encoded, and an image that is small enough comes back as it was. Rejects
     * when the bytes are not an image the browser can read.
     */
    prepareImage(image: Blob): Promise<Blob>
    /**
     * Keep an image as one of the graph's assets, made smaller first as {@link ExtensionAssets.prepareImage}
     * does, and answer the markdown that shows it in a document, such as
     * `![photo](assets/photo.3f9a1c2e.webp)`. The file is named from `name` and a short hash of its
     * bytes, so two images never take the same name, and the same image kept twice is one file.
     * An asset is part of the graph: it syncs, and every member of a shared graph can see it. Null
     * where the graph keeps no assets here, or the image was refused.
     */
    saveImage(image: Blob, name: string): Promise<string | null>
    /**
     * Keep an image as {@link ExtensionAssets.saveImage} does, and answer its reference as well as its
     * markdown, or why it was not kept. For an extension that holds the reference in data of its own.
     *
     * @beta
     */
    storeImage(image: Blob, name: string): Promise<StoredImage>
    /**
     * What the asset reference `ref` names, as a document writes it (`../assets/plan.3f9a1c2e.png`),
     * or null when `ref` names no asset.
     */
    describe(ref: string): AssetDescription | null
    /**
     * An address an `<img>` shows the image `ref` names at, read from the graph as the editor reads
     * an image it draws: decrypted, in a synced graph. It lasts while the graph is open. Null when
     * `ref` names no image, the graph keeps no assets here, or the image cannot be read just now.
     */
    imageUrl(ref: string): Promise<string | null>
    /**
     * Show the images `options.refs` name in the Client's Lightbox, over whatever is open, a dialog
     * of the extension's own included: each as large as the window allows, under its name, with
     * Previous and Next (and ← and →) when there is more than one. Esc, its close button or a
     * click outside the picture closes it, and the keyboard returns to the element that had it.
     * Resolves once it closes. One Lightbox is open at a time: showing others closes the first.
     * Nothing opens when no reference names an image.
     */
    viewImages(options: ViewImagesOptions): Promise<void>
}
