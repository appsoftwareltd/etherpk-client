/**
 * The Contribution Point a [[Map Block]] is drawn through for a publish in the browser (ADR 0118,
 * ADR 0121). The extension that draws maps registers a {@link MapPictureRenderer} under
 * {@link MAP_PICTURE_KIND}, keyed by the fence's info word, and the browser's publish environment
 * asks for it as a publish needs it (host/browser-environment.ts). The Headless Client draws maps
 * itself, without extensions.
 *
 * A module of its own, so registering a renderer as a graph opens loads nothing of the publisher.
 */
import type { MapPicture } from './publish'

export const MAP_PICTURE_KIND = 'map-picture'

/** Draws a Map Block, by its fence's body, as `PublishEnvironment.renderMap` does. */
export type MapPictureRenderer = (source: string) => Promise<MapPicture>
