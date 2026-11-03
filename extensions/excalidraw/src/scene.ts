/**
 * A drawing's lines as Excalidraw draws them, in the browser, where Excalidraw runs.
 *
 * - **Restoring.** Each element is restored on its own first, so one Excalidraw cannot read is left
 *   out of the scene rather than taking the whole drawing with it. It stays in the document as
 *   written, since a save leaves what it never loaded (`planWrite`). The readable ones are then
 *   restored together with Excalidraw's binding repair, as Excalidraw loads a file of its own. Text is
 *   not measured again (`refreshDimensions`), as Excalidraw does not when it loads a file: measured
 *   before its fonts load, text would move in drawings that were right.
 * - **Converting skeletons.** Shapes written without Excalidraw's bookkeeping (`format.ts`) become
 *   full elements through Excalidraw's own `convertToExcalidrawElements`, which needs a page to
 *   measure text in. Ids are made the same on every device that converts the same lines, so two
 *   converting at once write one drawing, not two copies of it.
 */
import { type ElementRecord, type SkeletonRecord, skeletonPrefix, withMadeUpIdsFixed, withSkeletonIds } from './format'
import type { ExcalidrawKit } from './load'

/** The elements Excalidraw can draw, restored, leaving out any it cannot read. */
export function restoreScene(kit: ExcalidrawKit, elements: readonly ElementRecord[]): ElementRecord[] {
    const { restoreElements } = kit.excalidraw
    const alone: ElementRecord[] = []
    const readable = elements.filter((element) => {
        try {
            alone.push(...(restoreElements([element] as never, null) as unknown as ElementRecord[]))
            return true
        } catch (error) {
            console.warn(`[excalidraw] the element ${element.id} could not be read, so it is not drawn. It stays in the document as written.`, error)
            return false
        }
    })
    try {
        return restoreElements(readable as never, null, { repairBindings: true, refreshDimensions: false }) as unknown as ElementRecord[]
    } catch (error) {
        // The repair needs the elements together. Failing that, each as it restored on its own.
        console.warn('[excalidraw] the drawing could not be repaired, so it is drawn as written', error)
        return alone
    }
}

/** The key a skeleton is known by between reading it and writing its conversion back. */
export function skeletonKey(skeleton: SkeletonRecord): string {
    return JSON.stringify(skeleton)
}

/**
 * Skeletons as the full elements they become, and the keys of those that converted. Converted
 * together, so an arrow can bind to a shape on another line. Failing that, each on its own, leaving
 * out any that cannot convert, which stay in the document as written.
 */
export function convertSkeletons(kit: ExcalidrawKit, skeletons: readonly SkeletonRecord[]): { elements: ElementRecord[]; converted: Set<string> } {
    const { convertToExcalidrawElements } = kit.excalidraw
    const withIds = withSkeletonIds(skeletons)
    const convert = (some: readonly SkeletonRecord[]) => convertToExcalidrawElements(some as never, { regenerateIds: false }) as unknown as ElementRecord[]
    let made: ElementRecord[] = []
    const converted = new Set<string>()
    try {
        made = convert(withIds)
        for (const skeleton of skeletons) converted.add(skeletonKey(skeleton))
    } catch {
        withIds.forEach((skeleton, n) => {
            try {
                made.push(...convert([skeleton]))
                converted.add(skeletonKey(skeletons[n]))
            } catch (error) {
                console.warn('[excalidraw] a shape written by hand could not be drawn. It stays in the document as written.', error)
            }
        })
    }
    const given = new Set(withIds.map((skeleton) => skeleton.id as string))
    return { elements: withMadeUpIdsFixed(made, given, skeletonPrefix(skeletons)), converted }
}
