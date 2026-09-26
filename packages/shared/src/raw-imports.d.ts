/** Vite's `?raw` suffix imports a file's text; the apps' builds and Vitest both resolve it. */
declare module '*?raw' {
    const text: string
    export default text
}
