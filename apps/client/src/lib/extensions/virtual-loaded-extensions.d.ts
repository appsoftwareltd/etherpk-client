/** The loaded Built-in Extensions the Vite plugin found (extensions-plugin.ts, ADR 0121). */
declare module 'virtual:etherpk-loaded-extensions' {
    /** Each package's package.json, the address its root is served at, and whether it is a Built-in Extension. */
    const loaded: { packageJson: unknown; base: string; builtIn: boolean }[]
    export default loaded
}
