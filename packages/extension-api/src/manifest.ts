/**
 * An extension's manifest: the `etherpk` field of its package.json (ADR 0121), and the one helper
 * that reads and checks it. The Client reads the same field with the same function, so an author
 * and the Client never disagree about what a manifest means.
 */

/**
 * Where a View kind opens when nothing says otherwise.
 *
 * @beta
 */
export type ViewRegion = 'main' | 'left-sidebar' | 'right-sidebar'

/**
 * One View kind an extension adds, declared so the Client can show its tabs, titles and loading
 * state before any of the extension's code has run.
 *
 * @beta
 */
export interface ViewDeclaration {
    /** The kind, `<extension id>.<name>`: the key every saved Layout stores it under. */
    kind: string
    /**
     * The target of a kind with one View per graph, a Sidebar resident or a whole-graph View
     * (`"whole"`). A kind whose Views differ by target, one board per concept, leaves it out.
     */
    target?: string
    /**
     * The tab's title. `{target}` stands for the View's target, so `"Kanban: {target}"` titles a
     * board by its concept. The text before `{target}` is a fixed label the tab keeps room for.
     */
    title: string
    /** An icon drawn before the title: one of the extension's own icons, or one of the Client's. */
    icon?: string
    /** Where the kind opens when nothing says otherwise. */
    region: ViewRegion
    /**
     * The View lives in a Sidebar from the moment a graph opens, beside the Client's own residents,
     * and the Sidebar's toggle brings it back if it was closed. `desktopOnly` keeps it off a phone.
     */
    resident?: { side: 'left' | 'right'; desktopOnly?: boolean }
    /**
     * A short address of the View's own: `/g/<graph>/<segment>`, followed by the target when
     * `target` is `concept`. Only a Built-in Extension may declare one. A View kind whose address
     * takes a concept follows that concept through a rename.
     */
    address?: { segment: string; target?: 'concept' }
}

/**
 * One thing an extension asks the person to set (ADR 0134). The Client draws it under the
 * extension's entry in Settings and Extensions → Extensions, where it can be set while the extension
 * is off, and keeps the answer with the person: on this device, and in their account where it syncs
 * a graph, so it follows them to their other devices. The extension reads it through
 * `context.settings`.
 *
 * @beta
 */
export interface SettingDeclaration {
    /** Unique within the extension: lowercase letters, digits and hyphens, such as `mapbox-token`. */
    id: string
    /**
     * `text`; `secret` for a key or a password, which is shown masked until the person asks to see
     * it; or `boolean`, a switch, which `context.settings` reads as `'true'` or `'false'`.
     */
    type: 'text' | 'secret' | 'boolean'
    /** The field's label, or for a switch what it turns on. */
    title: string
    /** A switch's position until the person changes it. Only on a `boolean` setting, and off when left out. */
    default?: boolean
    /** Plain text under the field: what the setting does, and what the person needs for it. */
    description?: string
    /** Example text shown in the empty field. */
    placeholder?: string
    /** A page that explains the setting, linked under its description. An `https` address. */
    link?: { title: string; url: string }
}

/**
 * The `etherpk` field of an extension's package.json.
 *
 * @beta
 */
export interface ExtensionManifest {
    /**
     * Lowercase letters, digits and hyphens, starting with a letter. It prefixes every View kind,
     * Command id, icon name and storage key the extension owns, so it is short.
     */
    id: string
    /** The name people see, in Settings and wherever the extension is listed. */
    displayName: string
    /** Who made the extension. */
    publisher: string
    /** The lowest Client version the extension runs on, `x.y.z`. Required of a loaded extension. */
    minClientVersion?: string
    /** The module that exports `activate`, relative to the package's root. */
    main: string
    /**
     * Stylesheets adopted into the shadow root of each of the extension's Views, relative to the
     * package's root. Only a loaded extension has them: a compiled-in one shares the Client's.
     */
    styles?: string[]
    /** Icons by name: the inner markup of a 16 by 16 SVG drawn with `currentColor` strokes. */
    icons?: Record<string, string>
    /** The View kinds the extension adds. */
    views?: ViewDeclaration[]
    /** What the extension asks the person to set, in the order it is shown. */
    settings?: SettingDeclaration[]
}

/**
 * An extension's package as the Client reads it: the standard package.json fields it uses and the
 * manifest.
 *
 * @beta
 */
export interface ExtensionPackage {
    /** The npm package name. */
    name: string
    /** The package version, which is the extension's version. */
    version: string
    /** The package's description, when it has one. */
    description?: string
    /** The package's licence, an SPDX identifier, when it names one. */
    license?: string
    /** The `etherpk` field. */
    manifest: ExtensionManifest
}

/**
 * The answer of {@link readExtensionPackage}: the package, or every way its manifest is wrong.
 *
 * @beta
 */
export type ReadExtensionPackageResult = { ok: true; extension: ExtensionPackage } | { ok: false; errors: string[] }

const NAME = /^[a-z][a-z0-9-]*$/
const VERSION = /^\d+\.\d+\.\d+$/
const REGIONS: readonly ViewRegion[] = ['main', 'left-sidebar', 'right-sidebar']

/**
 * Read an extension's package.json, already parsed, and check its manifest.
 *
 * Checks what the Client depends on: names it uses as keys, paths it resolves, and declarations
 * it registers before any of the extension's code runs. It does not check that files exist.
 *
 * @beta
 */
export function readExtensionPackage(packageJson: unknown): ReadExtensionPackageResult {
    const errors: string[] = []
    const json = isRecord(packageJson) ? packageJson : {}
    const name = json.name
    const version = json.version
    if (typeof name !== 'string' || name === '') errors.push('package.json has no "name".')
    if (typeof version !== 'string' || !VERSION.test(version)) errors.push('package.json\'s "version" is not x.y.z.')
    const field = json.etherpk
    if (!isRecord(field)) {
        errors.push('package.json has no "etherpk" field, so it is not an EtherPK extension.')
        return { ok: false, errors }
    }

    const id = field.id
    if (typeof id !== 'string' || !NAME.test(id)) errors.push('"etherpk.id" must be lowercase letters, digits and hyphens, starting with a letter.')
    const ownId = typeof id === 'string' ? id : ''
    for (const key of ['displayName', 'publisher', 'main'] as const) {
        if (typeof field[key] !== 'string' || (field[key] as string).trim() === '') errors.push(`"etherpk.${key}" must be a non-empty string.`)
    }
    if (typeof field.main === 'string' && field.main.trim() !== '' && !relativePath(field.main)) errors.push('"etherpk.main" must be a path inside the package.')
    if (field.minClientVersion !== undefined && (typeof field.minClientVersion !== 'string' || !VERSION.test(field.minClientVersion))) {
        errors.push('"etherpk.minClientVersion" must be x.y.z.')
    }
    if (field.styles !== undefined && (!Array.isArray(field.styles) || !field.styles.every((path) => typeof path === 'string' && relativePath(path)))) {
        errors.push('"etherpk.styles" must be a list of paths inside the package.')
    }
    if (field.icons !== undefined) {
        if (!isRecord(field.icons)) errors.push('"etherpk.icons" must map names to SVG markup.')
        else
            for (const [iconName, markup] of Object.entries(field.icons)) {
                if (!NAME.test(iconName)) errors.push(`Icon "${iconName}" must be lowercase letters, digits and hyphens.`)
                if (typeof markup !== 'string' || markup.trim() === '') errors.push(`Icon "${iconName}" has no markup.`)
            }
    }
    const views = field.views === undefined ? [] : field.views
    if (!Array.isArray(views)) errors.push('"etherpk.views" must be a list.')
    else {
        const kinds = new Set<string>()
        const segments = new Set<string>()
        views.forEach((view, index) => checkView(view, index, ownId, kinds, segments, errors))
    }
    const settings = field.settings === undefined ? [] : field.settings
    if (!Array.isArray(settings)) errors.push('"etherpk.settings" must be a list.')
    else {
        const ids = new Set<string>()
        settings.forEach((setting, index) => checkSetting(setting, index, ids, errors))
    }

    if (errors.length > 0) return { ok: false, errors }
    return {
        ok: true,
        extension: {
            name: name as string,
            version: version as string,
            ...(typeof json.description === 'string' ? { description: json.description } : {}),
            ...(typeof json.license === 'string' ? { license: json.license } : {}),
            manifest: field as unknown as ExtensionManifest,
        },
    }
}

const SETTING_TYPES: readonly SettingDeclaration['type'][] = ['text', 'secret', 'boolean']

function checkSetting(setting: unknown, index: number, ids: Set<string>, errors: string[]): void {
    const where = `"etherpk.settings[${index}]"`
    if (!isRecord(setting)) {
        errors.push(`${where} must be an object.`)
        return
    }
    if (typeof setting.id !== 'string' || !NAME.test(setting.id)) errors.push(`${where}.id must be lowercase letters, digits and hyphens, starting with a letter.`)
    else if (ids.has(setting.id)) errors.push(`${where}.id "${setting.id}" is declared twice.`)
    else ids.add(setting.id)
    if (!SETTING_TYPES.includes(setting.type as SettingDeclaration['type'])) errors.push(`${where}.type must be one of ${SETTING_TYPES.join(', ')}.`)
    if (typeof setting.title !== 'string' || setting.title.trim() === '') errors.push(`${where}.title must be a non-empty string.`)
    for (const key of ['description', 'placeholder'] as const) {
        if (setting[key] !== undefined && typeof setting[key] !== 'string') errors.push(`${where}.${key} must be a string.`)
    }
    if (setting.default !== undefined && (setting.type !== 'boolean' || typeof setting.default !== 'boolean')) {
        errors.push(`${where}.default must be true or false, and only on a boolean setting.`)
    }
    if (setting.link !== undefined) {
        const link = setting.link
        if (!isRecord(link) || typeof link.title !== 'string' || link.title.trim() === '' || typeof link.url !== 'string' || !httpsUrl(link.url)) {
            errors.push(`${where}.link must be { title, url }, the url an https address.`)
        }
    }
}

function httpsUrl(value: string): boolean {
    try {
        return new URL(value).protocol === 'https:'
    } catch {
        return false
    }
}

function checkView(view: unknown, index: number, id: string, kinds: Set<string>, segments: Set<string>, errors: string[]): void {
    const where = `"etherpk.views[${index}]"`
    if (!isRecord(view)) {
        errors.push(`${where} must be an object.`)
        return
    }
    const kind = view.kind
    const prefix = `${id}.`
    if (typeof kind !== 'string' || !kind.startsWith(prefix) || !NAME.test(kind.slice(prefix.length))) {
        errors.push(`${where}.kind must be "${prefix}<name>", the name in lowercase letters, digits and hyphens.`)
    } else if (kinds.has(kind)) errors.push(`${where}.kind "${kind}" is declared twice.`)
    else kinds.add(kind)
    if (view.target !== undefined && (typeof view.target !== 'string' || view.target === '')) errors.push(`${where}.target must be a non-empty string.`)
    if (typeof view.title !== 'string' || view.title.trim() === '') errors.push(`${where}.title must be a non-empty string.`)
    if (view.icon !== undefined && typeof view.icon !== 'string') errors.push(`${where}.icon must be an icon's name.`)
    if (!REGIONS.includes(view.region as ViewRegion)) errors.push(`${where}.region must be one of ${REGIONS.join(', ')}.`)
    if (view.resident !== undefined) {
        const resident = view.resident
        if (!isRecord(resident) || (resident.side !== 'left' && resident.side !== 'right') || (resident.desktopOnly !== undefined && typeof resident.desktopOnly !== 'boolean')) {
            errors.push(`${where}.resident must be { side: "left" | "right", desktopOnly?: boolean }.`)
        }
    }
    if (view.address !== undefined) {
        const address = view.address
        if (!isRecord(address) || typeof address.segment !== 'string' || !NAME.test(address.segment)) {
            errors.push(`${where}.address.segment must be lowercase letters, digits and hyphens.`)
        } else if (segments.has(address.segment)) errors.push(`${where}.address.segment "${address.segment}" is declared twice.`)
        else segments.add(address.segment)
        if (isRecord(address) && address.target !== undefined && address.target !== 'concept') errors.push(`${where}.address.target may only be "concept".`)
    }
}

/** A path that stays inside the package: relative, and never climbing out of it. */
function relativePath(path: string): boolean {
    return path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
