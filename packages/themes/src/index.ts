/**
 * The first-party [[Theme]]s (ADR 0082), read from this package's directories at build time so
 * they ship inside whatever bundles the publisher: the Client and the Headless Client. A theme
 * is data only: `theme.json`, Mustache templates under `layouts/` and `partials/`, and text
 * assets under `assets/`. Every file is text, which is what lets the same shape live in a URL,
 * a Y.Map or a JSON file interchangeably. The publisher parses and validates the manifest; this
 * module only knows file names and contents.
 */

const files = import.meta.glob<string>('../etherpk-*/**/*', { query: '?raw', import: 'default', eager: true })

export interface BundledTheme {
    /** The directory name, which is the theme's name: `etherpk-docs`, `etherpk-blog`. */
    name: string
    /** Path relative to the theme directory → the file's text. `theme.json` included. */
    files: Map<string, string>
}

const themes = new Map<string, BundledTheme>()
for (const [path, text] of Object.entries(files)) {
    // `../etherpk-docs/layouts/page.html` → theme `etherpk-docs`, file `layouts/page.html`.
    const match = /^\.\.\/([^/]+)\/(.+)$/.exec(path)
    if (!match) continue
    const [, name, file] = match
    let theme = themes.get(name)
    if (!theme) {
        theme = { name, files: new Map() }
        themes.set(name, theme)
    }
    theme.files.set(file, text)
}

/** The bundled themes by name. */
export function bundledThemes(): ReadonlyMap<string, BundledTheme> {
    return themes
}

export function bundledTheme(name: string): BundledTheme | undefined {
    return themes.get(name)
}

/** The bundled theme names, for a picker. */
export function bundledThemeNames(): string[] {
    return [...themes.keys()].sort()
}

/** A bundled theme as a picker shows it: the identifier, and the title its manifest gives it. */
export interface BundledThemeEntry {
    name: string
    title: string
}

/**
 * The display title a theme's manifest declares (`"title": "EtherPK Blog"`), falling back to the
 * name for a manifest without one or one that does not parse. The manifest is validated by the
 * publisher; this reads the one field a picker needs without that machinery.
 */
export function bundledThemeTitle(name: string): string {
    const manifest = themes.get(name)?.files.get('theme.json')
    if (!manifest) return name
    try {
        const parsed: unknown = JSON.parse(manifest)
        const title = typeof parsed === 'object' && parsed !== null ? (parsed as { title?: unknown }).title : undefined
        return typeof title === 'string' && title.trim() !== '' ? title.trim() : name
    } catch {
        return name
    }
}

/** Every bundled theme with its title, sorted by name, for a picker. */
export function bundledThemeList(): BundledThemeEntry[] {
    return bundledThemeNames().map((name) => ({ name, title: bundledThemeTitle(name) }))
}
