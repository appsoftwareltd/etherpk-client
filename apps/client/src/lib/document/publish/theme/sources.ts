/**
 * Where a [[Theme]] comes from (ADR 0082): bundled with the app, a URL to a manifest, or a copy
 * in the graph's theme container. One loader resolves a publication's `theme:` to files; the
 * publisher never knows which it was beyond the report's `source`.
 */

import { type BundledTheme, bundledTheme } from '@appsoftwareltd/etherpk-themes'

import type { LoadedTheme } from '../publish'
import { type GraphTheme, themeFilesOf } from './graph-theme'
import { type ThemeFiles, parseThemeManifest } from './manifest'

export interface ThemeSourceDeps {
    /** Fetch a URL as text; throws on a non-2xx response. Absent where the host has no network. */
    fetchText?(url: string): Promise<string>
    /** A theme from the graph's container, or null when the id names none. */
    graphTheme?(id: string): Promise<GraphTheme | null>
}

export function isThemeUrl(ref: string): boolean {
    return /^https?:\/\//i.test(ref)
}

/** The files of a bundled theme as the publisher consumes them. */
export function themeFilesOfBundled(theme: BundledTheme): ThemeFiles {
    const json = theme.files.get('theme.json')
    if (json === undefined) throw new Error(`The bundled theme "${theme.name}" has no theme.json.`)
    const { manifest, errors } = parseThemeManifest(json)
    if (!manifest) throw new Error(`The bundled theme "${theme.name}" is invalid: ${errors.join(' ')}`)
    const files = new Map<string, string>()
    for (const [path, text] of theme.files) if (path !== 'theme.json') files.set(path, text)
    return { manifest, files }
}

/** Fetch a theme from its manifest URL; every file the manifest lists, relative to it. */
export async function fetchTheme(url: string, fetchText: (url: string) => Promise<string>): Promise<ThemeFiles> {
    let json: string
    try {
        json = await fetchText(url)
    } catch (error) {
        throw new Error(`The theme at ${url} could not be fetched: ${error instanceof Error ? error.message : String(error)}`)
    }
    const { manifest, errors } = parseThemeManifest(json)
    if (!manifest) throw new Error(`The theme at ${url} cannot be used: ${errors.join(' ')}`)
    if (manifest.files.length === 0) throw new Error(`The theme at ${url} lists no files in its manifest, so nothing can be fetched.`)
    const base = new URL(url)
    const files = new Map<string, string>()
    for (const path of manifest.files) {
        const fileUrl = new URL(path, base).toString()
        try {
            files.set(path, await fetchText(fileUrl))
        } catch (error) {
            throw new Error(`The theme file ${path} could not be fetched from ${fileUrl}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
    return { manifest, files }
}

/** A `loadTheme` for the publisher over the three sources. */
export function createThemeLoader(deps: ThemeSourceDeps): (ref: string) => Promise<LoadedTheme> {
    return async (ref: string): Promise<LoadedTheme> => {
        if (isThemeUrl(ref)) {
            if (!deps.fetchText) throw new Error(`The theme "${ref}" is a url and this host cannot fetch one.`)
            return { theme: await fetchTheme(ref, deps.fetchText), source: 'url' }
        }
        const graph = deps.graphTheme ? await deps.graphTheme(ref) : null
        if (graph) return { theme: themeFilesOf(graph), source: 'graph' }
        const bundled = bundledTheme(ref)
        if (bundled) return { theme: themeFilesOfBundled(bundled), source: 'bundled' }
        throw new Error(`No theme is called "${ref}": it is not bundled with EtherPK, not a theme in this graph, and not a url.`)
    }
}
