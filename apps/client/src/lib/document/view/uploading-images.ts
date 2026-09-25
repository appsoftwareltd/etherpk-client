/**
 * Which images in the editor are still being stored ([[Rich Paste]], ADR 0090): a [[Remote Image]]
 * the paste wrote shows from its web address meanwhile, with a notice over it that it is uploading,
 * and the notice clears when the stored image takes the link's place, or the upload fails or is
 * cancelled. The set is keyed by the source string the text carries, which is what the image widget
 * (`augmentations/image-embed.ts`) reads and what the upload half (`remote-image-upload.ts`) marks.
 */

import { StateEffect, StateField } from '@codemirror/state'

/** Mark a source as uploading, or clear it. */
export const setImageUploading = StateEffect.define<{ src: string; uploading: boolean }>()

/** The sources whose upload is in flight. A new set on every change, so a field comparing by identity sees it. */
export const uploadingImagesField = StateField.define<ReadonlySet<string>>({
    create: () => new Set(),
    update(set, tr) {
        let next: Set<string> | null = null
        for (const effect of tr.effects) {
            if (!effect.is(setImageUploading)) continue
            next ??= new Set(set)
            if (effect.value.uploading) next.add(effect.value.src)
            else next.delete(effect.value.src)
        }
        return next ?? set
    },
})

/** Whether `src` is uploading, in a state that may or may not carry the field. */
export function isImageUploading(state: { field<T>(field: StateField<T>, required: false): T | undefined }, src: string): boolean {
    return state.field(uploadingImagesField, false)?.has(src) ?? false
}
