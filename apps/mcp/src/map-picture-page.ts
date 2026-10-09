/**
 * The page the Headless Client draws map pictures in (map-pictures.ts), built as a browser bundle
 * of its own (`vite.map-page.config.ts`) beside the Node one. It runs the maps extension's own
 * drawing code, its `/picture` export, so a map published from here looks as it does published
 * from the browser, and leaves MapLibre to the page's import map, which names the copy this
 * package installs.
 */
import { setWorkerUrl } from 'maplibre-gl'

import { drawMapPicture } from '@appsoftwareltd/etherpk-extension-maps/picture'

// The page serves MapLibre's worker beside its other files.
setWorkerUrl(new URL('/maplibre-gl-worker.mjs', location.href).toString())

declare global {
    interface Window {
        etherpkDrawMapPicture?: typeof drawMapPicture
    }
}

window.etherpkDrawMapPicture = drawMapPicture
