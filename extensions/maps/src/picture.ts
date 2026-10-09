/**
 * A Map Block as the picture a published page shows, for the Headless Client (ADR 0118, ADR 0121):
 * the package's `/picture` export. The Headless Client loads no extensions, so it draws maps with
 * this, in a page of its own, over EtherPK's map host unless told of another basemap. The Client
 * reaches the same drawing through the extension's publish contribution instead (register.ts).
 */
export { drawMapPicture, type MapPictureOptions, PICTURE_HEIGHT, PICTURE_WIDTH } from './map-picture'
export { DEFAULT_MAP_STYLES, type MapStyles } from './map-host'
