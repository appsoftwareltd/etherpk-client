/**
 * The changes the Client's build makes to Excalidraw's code, so that it runs under the Client's
 * Content Security Policy (no `unsafe-eval`, fonts from the Client's own origin only). Each is
 * exact text in Excalidraw 0.18.1's production build (`dist/prod`), which is pinned exactly:
 *
 * - **Fonts from the Client.** Excalidraw names each font file relative to its package
 *   (`"./fonts/Excalifont/Excalifont-Regular-….woff2"`) and puts a CDN address after the one it is
 *   told to use. Every name becomes a full address the build chooses (a file of the Client's build,
 *   or the file itself on a development server), which Excalidraw uses as it is, and the CDN
 *   address is taken out.
 * - **Fonts embedded whole.** Excalidraw shrinks the fonts it embeds in an SVG with a WebAssembly
 *   tool whose loader calls `new Function`, which the Client's policy refuses. It embeds each font
 *   whole instead.
 *
 * A patch that finds nothing to change (another Excalidraw version) fails the build, rather than
 * shipping an Excalidraw the Client would refuse. Pure, so it is tested against the real package.
 */

/** Exact text in Excalidraw 0.18.1's production build, and what it becomes. */
export const CODE_PATCHES: readonly { name: string; find: string; replace: string }[] = [
    {
        name: 'no CDN address for fonts',
        find: 'return r.push(new URL(n,jn.ASSETS_FALLBACK_URL)),r',
        replace: 'return r',
    },
    {
        name: 'fonts embedded whole',
        find: 'qd=async(e,t)=>{',
        replace:
            'qd=async(e,t)=>{{let u=new Uint8Array(e),s="";for(let i=0;i<u.length;i+=32768)s+=String.fromCharCode.apply(null,u.subarray(i,i+32768));return"data:font/woff2;base64,"+btoa(s)}',
    },
]

/** The name the font rewrite is known by in the list of patches applied. */
export const FONT_PATCH = 'fonts from the Client'

/** Every patch a build of Excalidraw must apply, by name. */
export const ALL_PATCHES: readonly string[] = [...CODE_PATCHES.map((patch) => patch.name), FONT_PATCH]

/** A font file as Excalidraw's code names it: `"./fonts/<Family>/<file>.woff2"`. */
const FONT_NAME = /"\.\/fonts\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.woff2)"/g

export interface PatchedCode {
    code: string
    /** The patches that changed something, by name. */
    applied: Set<string>
    /** The font files named, relative to the package's `fonts/` folder (`Virgil/Virgil-Regular.woff2`). */
    fonts: string[]
}

/**
 * One file of Excalidraw's production build, patched. `fontAddress` gives the JavaScript expression
 * that evaluates to a font's full address, from its path under `fonts/`.
 */
export function patchExcalidrawCode(code: string, fontAddress: (font: string) => string): PatchedCode {
    const applied = new Set<string>()
    let out = code
    for (const patch of CODE_PATCHES) {
        if (!out.includes(patch.find)) continue
        out = out.replace(patch.find, patch.replace)
        applied.add(patch.name)
    }
    const fonts: string[] = []
    out = out.replace(FONT_NAME, (_, font: string) => {
        fonts.push(font)
        return fontAddress(font)
    })
    if (fonts.length > 0) applied.add(FONT_PATCH)
    return { code: out, applied, fonts }
}

/** The patches of `ALL_PATCHES` missing from `applied`, for the error a build fails with. */
export function missingPatches(applied: ReadonlySet<string>): string[] {
    return ALL_PATCHES.filter((name) => !applied.has(name))
}
