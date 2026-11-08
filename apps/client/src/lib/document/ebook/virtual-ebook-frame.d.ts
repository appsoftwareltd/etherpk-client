/** The page an EBook reads in, built by `ebook-frame-plugin.ts`. */
declare module 'virtual:etherpk-ebook-frame' {
    export const html: string
    export const contentSecurityPolicy: string
}

/** A file's address in the build, never inlined: the app's policy refuses to fetch a `data:` address. */
declare module '*?url&no-inline' {
    const address: string
    export default address
}
