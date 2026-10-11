/**
 * The Contribution Point a [[Map Block]] is drawn through as a picture (ADR 0118, ADR 0121): for a
 * publish in the browser, and for a reference quoted in the Backlinks panel. The extension that
 * draws maps registers a {@link MapPictureRenderer} under {@link MAP_PICTURE_KIND}, keyed by the
 * fence's info word. The browser's publish environment asks for it as a publish needs it
 * (host/browser-environment.ts), and the panel as it shows a map (view/quoted-map-pictures.ts).
 * The Headless Client draws maps itself, without extensions.
 *
 * A module of its own, so registering a renderer as a graph opens loads nothing of the publisher.
 */
import type { MapPicture } from './publish'

export const MAP_PICTURE_KIND = 'map-picture'

/**
 * How a picture is asked for outside a publish: the Backlinks panel's size and theme. A publish
 * asks for none, and gets a published page's 800 by 450 in the light style.
 */
export interface MapPictureRequest {
    /** The picture's size in CSS pixels. */
    width: number
    height: number
    /** Drawn for the dark theme. */
    dark: boolean
    /** Drawn over the deployment's basemap, or on the plain background when false. */
    basemap: boolean
}

/** Draws a Map Block, by its fence's body, as `PublishEnvironment.renderMap` does, or as a request asks. */
export type MapPictureRenderer = (source: string, request?: MapPictureRequest) => Promise<MapPicture>
