/**
 * A [[Theme]]'s manifest and files (ADR 0082). A theme is data: Mustache templates under
 * `layouts/` and `partials/`, text assets under `assets/`, and `theme.json` describing them.
 * Every file is text in the first version (webfonts and icons are a later addition), which is
 * what lets a theme live in a Y.Map, a JSON file, a URL or the app bundle interchangeably.
 */

import type { PublicationKind } from '../types'

/** The view shape this publisher writes. A theme names the contract it was written for. */
export const THEME_CONTRACT = 1

export interface ThemeIncludeSlot {
    name: string
    description: string
    /** `css` for the one slot that is appended to the stylesheet rather than rendered as a partial. */
    kind?: 'html' | 'css'
}

export interface ThemeManifest {
    /** The identifier: what a publication's `theme:` names. Kebab case for the bundled ones. */
    name: string
    /** What a person sees it called, in a picker or a report; the name when absent. */
    title?: string
    version: string
    contract: number
    description?: string
    kinds: PublicationKind[]
    includes: ThemeIncludeSlot[]
    /** Paths relative to the manifest, for a theme fetched from a URL. */
    files: string[]
}

/** A theme as the publisher consumes it: the manifest and every file's text by path. */
export interface ThemeFiles {
    manifest: ThemeManifest
    files: ReadonlyMap<string, string>
}

export interface ManifestValidation {
    manifest: ThemeManifest | null
    errors: string[]
}

const KINDS = new Set<PublicationKind>(['docs', 'blog'])
const SLOT_NAME = /^[a-z][a-z0-9-]*$/

/** Parse and validate a `theme.json` text. */
export function parseThemeManifest(json: string): ManifestValidation {
    let raw: unknown
    try {
        raw = JSON.parse(json)
    } catch {
        return { manifest: null, errors: ['theme.json is not valid JSON.'] }
    }
    return validateThemeManifest(raw)
}

export function validateThemeManifest(raw: unknown): ManifestValidation {
    const errors: string[] = []
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { manifest: null, errors: ['theme.json must be an object.'] }
    }
    const data = raw as Record<string, unknown>
    const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : null
    if (!name) errors.push('theme.json needs a `name`.')
    const version = typeof data.version === 'string' && data.version.trim() !== '' ? data.version.trim() : '0.0.0'
    const contract = typeof data.contract === 'number' && Number.isInteger(data.contract) ? data.contract : null
    if (contract === null) errors.push('theme.json needs an integer `contract`, the view version the theme was written for.')
    else if (contract > THEME_CONTRACT) {
        errors.push(`The theme was written for view contract ${contract}; this EtherPK writes contract ${THEME_CONTRACT}. Update EtherPK, or use an older theme.`)
    }
    const kinds: PublicationKind[] = []
    if (Array.isArray(data.kinds)) {
        for (const k of data.kinds) if (KINDS.has(k as PublicationKind)) kinds.push(k as PublicationKind)
    }
    if (kinds.length === 0) kinds.push('docs', 'blog')
    const includes: ThemeIncludeSlot[] = []
    if (Array.isArray(data.includes)) {
        for (const entry of data.includes) {
            if (typeof entry !== 'object' || entry === null) continue
            const e = entry as Record<string, unknown>
            if (typeof e.name !== 'string' || !SLOT_NAME.test(e.name)) {
                errors.push(`Include slot "${String(e.name)}" is not a valid name (lower-case letters, digits and hyphens).`)
                continue
            }
            includes.push({
                name: e.name,
                description: typeof e.description === 'string' ? e.description : '',
                ...(e.kind === 'css' ? { kind: 'css' as const } : {}),
            })
        }
    }
    const files: string[] = []
    if (Array.isArray(data.files)) {
        for (const f of data.files) if (typeof f === 'string' && f !== '' && !f.startsWith('/') && !f.includes('..')) files.push(f)
    }
    if (errors.length > 0 || !name || contract === null) return { manifest: null, errors }
    return {
        manifest: {
            name,
            ...(typeof data.title === 'string' && data.title.trim() !== '' ? { title: data.title.trim() } : {}),
            version,
            contract,
            ...(typeof data.description === 'string' ? { description: data.description } : {}),
            kinds,
            includes,
            files,
        },
        errors: [],
    }
}

/** The layout a page kind renders with, falling back the way the plan says. */
export function layoutFor(files: ReadonlyMap<string, string>, kind: 'page' | 'home' | 'journal' | 'archive' | '404'): string | null {
    const wanted = `layouts/${kind}.html`
    const found = files.get(wanted)
    if (found !== undefined) return found
    return files.get('layouts/page.html') ?? null
}

/** Check a theme's files are enough to render with: at least the page layout. */
export function themeFileErrors(theme: ThemeFiles): string[] {
    const errors: string[] = []
    if (!theme.files.has('layouts/page.html')) errors.push('The theme has no `layouts/page.html`.')
    for (const slot of theme.manifest.includes) {
        if (slot.kind === 'css') continue
        if (!theme.files.has(`partials/${slot.name}.html`)) {
            errors.push(`The theme declares the include slot "${slot.name}" but has no \`partials/${slot.name}.html\`.`)
        }
    }
    return errors
}
