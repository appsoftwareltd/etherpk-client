/**
 * How tall a drawing is in the document: its picture fitted to the column, never magnified,
 * between a floor and a ceiling; and a fixed height while it is edited there. Pure, checked in Node.
 */
import type { FenceInfo } from '@appsoftwareltd/etherpk-extension-api'

import { readInk } from './format'
import { boundsHeight, boundsWidth } from './geometry'
import { pictureView } from './svg'

/** The picture's least and greatest height in the document, in CSS pixels. */
export const PICTURE_MIN_HEIGHT = 120
export const PICTURE_MAX_HEIGHT = 480
/** The board's height while the drawing is edited in the document (the Client adds its toolbar). */
export const EDITING_HEIGHT = 520
/** The column width assumed until a drawing has been measured. */
export const DEFAULT_COLUMN_WIDTH = 640

export interface PictureFit {
    /** The picture's drawn size. */
    width: number
    height: number
    /** The height of the box it is drawn in: the picture's, within the floor and the ceiling. */
    boxHeight: number
}

/**
 * The picture of a `pictureWidth` × `pictureHeight` drawing in a column `columnWidth` wide:
 * at its own size where it fits, shrunk to the column's width or the ceiling's height where not.
 */
export function fitPicture(pictureWidth: number, pictureHeight: number, columnWidth: number): PictureFit {
    const column = columnWidth > 0 ? columnWidth : DEFAULT_COLUMN_WIDTH
    const scale = Math.min(1, column / Math.max(1, pictureWidth), PICTURE_MAX_HEIGHT / Math.max(1, pictureHeight))
    const width = pictureWidth * scale
    const height = pictureHeight * scale
    return { width, height, boxHeight: Math.round(Math.min(PICTURE_MAX_HEIGHT, Math.max(PICTURE_MIN_HEIGHT, height))) }
}

/** A drawing's height: the board's while edited, else its picture's fitted to the column. */
export function inkHeight(info: FenceInfo, columnWidth: number): number {
    if (info.editing) return EDITING_HEIGHT
    const drawing = readInk(info.body)
    if (drawing.newer || drawing.strokes.length === 0) return PICTURE_MIN_HEIGHT
    const view = pictureView(drawing)
    return fitPicture(boundsWidth(view), boundsHeight(view), columnWidth).boxHeight
}
