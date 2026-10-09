/** The loaded Built-in Extensions the Vite plugin found (extensions-plugin.ts, ADR 0121). */
declare module 'virtual:etherpk-loaded-extensions' {
    /** Each package's package.json, and the address its root is served at. */
    const loaded: { packageJson: unknown; base: string }[]
    export default loaded
}
