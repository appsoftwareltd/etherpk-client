/**
 * A PDF as a [[Favourite]]: `{ kind: 'asset', concept: <the Asset's identity>, name }`. The name is
 * stored with it, because a synced Asset's identity is a bare id, and a Sidebar row should not
 * fetch a file's metadata to label itself. Only PDFs are favourites here, not other Assets.
 */
import { addFavourite, getFavourites, removeFavourite, restoreFavourite, subscribeFavourites } from '../favourites'
import { isViewFavourite, type ViewFavourite } from '../favourite-entry'

export const ASSET_VIEW_KIND = 'asset'

/** The identity two references to one PDF share, stripped of the extension a synced id's tab wears. */
export function pdfFavouriteTarget(target: string): string {
    return target.replace(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[^.]+$/, '$1')
}

/** Stored as the tab's own target, so opening the favourite finds a tab already open on the PDF. */
export function pdfFavourite(target: string, name: string): ViewFavourite {
    return { kind: ASSET_VIEW_KIND, concept: target, name }
}

export function isPdfFavourite(target: string): boolean {
    return getFavourites().some((entry) => isViewFavourite(entry) && entry.kind === ASSET_VIEW_KIND && entry.concept === target)
}

/** The PDF's Favourite follows a rename, staying where it is in the list. */
export async function renamePdfFavourite(from: string, to: string, name: string): Promise<void> {
    const removed = await removeFavourite(pdfFavourite(from, ''))
    if (removed) await restoreFavourite(pdfFavourite(to, name), removed.index)
}

export async function addPdfFavourite(target: string, name: string): Promise<void> {
    await addFavourite(pdfFavourite(target, name))
}

export async function removePdfFavourite(target: string): Promise<void> {
    await removeFavourite(pdfFavourite(target, ''))
}

export const subscribePdfFavourites = subscribeFavourites
