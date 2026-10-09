/**
 * Where MapLibre's worker is loaded from in the Client: Vite emits the worker module as an asset
 * and hands back its address. Imported for its effect by everything in the Client that draws a
 * map, before the first map is made.
 */
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'

setWorkerUrl(workerUrl)
