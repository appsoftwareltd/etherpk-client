/** The manifest demo-graph-plugin.ts derives from static/demo-graph at build time. */
declare module 'virtual:demo-graph' {
    import type { DemoBundleManifest } from '#lib/demo/bundle-manifest.js'

    const manifest: DemoBundleManifest
    export default manifest
}
