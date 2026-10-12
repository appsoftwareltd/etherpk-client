/**
 * The extension host (ADR 0121): it declares every [[Built-in Extension]]'s View kinds before any
 * extension runs, starts each extension that is switched on as a graph opens, and takes everything
 * back as the graph closes or an extension is switched off.
 *
 * A declared View kind gets a **slot**, which its tabs draw from. A slot waits while its extension
 * starts, holds the View once the extension supplies it, and says so when the extension failed or
 * is switched off. So a restored tab shows that it is loading, never that its kind is unknown, and
 * a failing extension shows why in its own tabs while every other extension and the graph carry
 * on.
 *
 * Plain TypeScript with listeners, so it is tested in Node. The workspace wires it to the Layout
 * and Settings reads it.
 */
import type { ExtensionModule, ViewContribution, ViewDeclaration, ViewRef } from '@appsoftwareltd/etherpk-extension-api'

import { type AddressBook, createAddressBook } from './addresses'
import type { Catalogue, CatalogueEntry } from './catalogue'
import { createScopedContext, type ScopedContext } from './scoped-context'
import type { ClientServices, GraphServices } from './services'
import type { ExtensionSwitches } from './switches'

/** Where an extension stands on this device. */
export type ExtensionStatus =
    | { state: 'off' }
    /** On, with no graph open to start it in. */
    | { state: 'idle' }
    | { state: 'starting' }
    | { state: 'running' }
    | { state: 'failed'; message: string }

/** What a declared View kind's tabs can draw. */
export type SlotState = { status: 'waiting' } | { status: 'ready'; view: ViewContribution } | { status: 'failed'; message: string } | { status: 'off' }

export interface ViewSlot {
    readonly kind: string
    readonly extensionId: string
    /** The extension's name, for what a tab says while it cannot draw. */
    readonly displayName: string
    /** A loaded extension's Views mount in a shadow root holding these stylesheets; others, null. */
    readonly isolation: { styles: string[] } | null
    state(): SlotState
    subscribe(listener: () => void): () => void
}

/** A View kind as the workspace registers it with the Layout. */
export interface DeclaredView {
    extensionId: string
    declaration: ViewDeclaration
    slot: ViewSlot
    /** The tab's icon, under the name the Client knows it by. */
    icon?: string
    title(view: ViewRef): string
    /** The fixed label before the target, when the title names the target. */
    titlePrefix?: string
    /** Its Views are about a concept, and follow it through a rename. */
    conceptTarget: boolean
}

/** A View kind that lives in a Sidebar from the moment a graph opens. */
export interface DeclaredResident {
    kind: string
    side: 'left' | 'right'
    desktopOnly: boolean
    /** The View to open when the resident has been closed. */
    fallback: ViewRef
}

export interface ExtensionHost {
    readonly catalogue: Catalogue
    readonly addresses: AddressBook
    /** Every declared View kind, for the workspace to register before any extension runs. */
    views(): DeclaredView[]
    residents(): DeclaredResident[]
    /** The icons manifests give, under the names the Client registers them by. */
    icons(): Record<string, string>
    /** Start every extension that is on, in this graph. Resolves once every one has settled. */
    start(graph: GraphServices): Promise<void>
    /** Take back everything every extension added: the graph is closing. */
    stop(): void
    isOn(id: string): boolean
    /** Switch an extension on or off on this device, starting or stopping it in an open graph. */
    setOn(id: string, on: boolean): Promise<void>
    /** Stop an extension and start it again in the open graph: what "Try again" runs. */
    retry(id: string): Promise<void>
    status(id: string): ExtensionStatus
    /** Called after any status or slot changes. Returns the unsubscribe. */
    subscribe(listener: () => void): () => void
    /**
     * Add an extension installed from the Extension Directory while the Client runs, checked first
     * (`admitInstalled`): its icons and View kinds are declared at once, told to `onDeclared`, and
     * it starts in the open graph if it is on. A Sidebar resident it declares appears once a graph
     * opens again, since a graph's Sidebars are laid out as it opens.
     */
    add(entry: CatalogueEntry): Promise<void>
    /** Stop an extension and take it out of the catalogue: it was removed from this device. */
    remove(id: string): void
    /** Hear View kinds declared by `add`, to register them as the first ones were. Returns the unsubscribe. */
    onDeclared(listener: (views: DeclaredView[], icons: Record<string, string>) => void): () => void
}

export interface ExtensionHostOptions {
    catalogue: Catalogue
    client: ClientServices
    switches: ExtensionSwitches
    /** How a loaded extension's module is fetched: a dynamic import, but for tests. */
    importModule?: (url: string) => Promise<unknown>
    /**
     * How a loaded extension that mounts in the page has its stylesheets checked and adopted by the
     * document (page-styles.ts), resolving to the way to take them out: but for tests.
     */
    pageStyles?: (urls: readonly string[], extensionId: string) => Promise<() => void>
}

interface Running {
    scoped: ScopedContext
    returned: (() => void) | undefined
}

export function createExtensionHost(options: ExtensionHostOptions): ExtensionHost {
    const { client, switches } = options
    // The host's own copy, since `add` and `remove` change it and the built-in catalogue is shared.
    const catalogue: Catalogue = { extensions: [...options.catalogue.extensions], broken: [...options.catalogue.broken] }
    const importModule = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url))
    const pageStyles = options.pageStyles ?? ((urls: readonly string[], id: string) => import('./page-styles').then((module) => module.adoptPageStyleSheets(urls, id)))
    /** The way to take out the page stylesheets of each started extension that mounts in the page. */
    const pageStylesAdopted = new Map<string, () => void>()
    const listeners = new Set<() => void>()
    const notify = () => {
        for (const listener of listeners) listener()
    }

    const slots = new Map<string, MutableSlot>()
    const declared: DeclaredView[] = []
    const residents: DeclaredResident[] = []
    const icons: Record<string, string> = {}

    /**
     * Declare an extension's icons and View kinds, returning the View kinds new to the host. A View
     * kind an earlier release of the same extension declared keeps its slot, which the workspace
     * already registered, so an update registers nothing twice.
     */
    function declare(entry: CatalogueEntry): { views: DeclaredView[]; icons: Record<string, string> } {
        const manifest = entry.package.manifest
        const own = new Set(Object.keys(manifest.icons ?? {}))
        const added: DeclaredView[] = []
        const addedIcons: Record<string, string> = {}
        for (const [name, markup] of Object.entries(manifest.icons ?? {})) {
            icons[`${entry.id}.${name}`] = markup
            addedIcons[`${entry.id}.${name}`] = markup
        }
        // A loaded extension's Views mount in a shadow root, unless it mounts in the page, whose
        // stylesheets the document adopts as it starts (ADR 0121, amended 2026-10-10).
        const isolation = entry.source === 'loaded' && manifest.isolation !== 'page' ? { styles: (manifest.styles ?? []).map((path) => resolve(entry.base, path)) } : null
        const initial: SlotState = switches.isOn(entry.id) ? { status: 'waiting' } : { status: 'off' }
        for (const declaration of manifest.views ?? []) {
            const earlier = slots.get(declaration.kind)
            if (earlier) {
                earlier.set(initial)
                continue
            }
            const slot = createSlot(declaration.kind, entry.id, manifest.displayName, isolation, initial, notify)
            slots.set(declaration.kind, slot)
            const [prefix] = declaration.title.split('{target}')
            const view: DeclaredView = {
                extensionId: entry.id,
                declaration,
                slot,
                ...(declaration.icon === undefined ? {} : { icon: own.has(declaration.icon) ? `${entry.id}.${declaration.icon}` : declaration.icon }),
                title: (ref) => declaration.title.replaceAll('{target}', ref.target),
                ...(declaration.title.endsWith('{target}') && prefix !== '' ? { titlePrefix: prefix } : {}),
                conceptTarget: declaration.address?.target === 'concept',
            }
            declared.push(view)
            added.push(view)
            if (declaration.resident) {
                residents.push({
                    kind: declaration.kind,
                    side: declaration.resident.side,
                    desktopOnly: declaration.resident.desktopOnly ?? false,
                    fallback: { kind: declaration.kind, target: declaration.target ?? '' },
                })
            }
        }
        return { views: added, icons: addedIcons }
    }
    for (const entry of catalogue.extensions) declare(entry)
    const declaredListeners = new Set<(views: DeclaredView[], icons: Record<string, string>) => void>()

    const statuses = new Map<string, ExtensionStatus>()
    for (const entry of catalogue.extensions) statuses.set(entry.id, switches.isOn(entry.id) ? { state: 'idle' } : { state: 'off' })
    const setStatus = (id: string, status: ExtensionStatus) => {
        statuses.set(id, status)
        notify()
    }

    const running = new Map<string, Running>()
    const modules = new Map<string, Promise<unknown>>()
    let graph: GraphServices | null = null
    // Bumped by every stop and every switch, so a bundle arriving after its start was abandoned
    // starts nothing.
    const generation = new Map<string, number>()
    const bump = (id: string) => generation.set(id, (generation.get(id) ?? 0) + 1)

    const slotsOf = (entry: CatalogueEntry) => (entry.package.manifest.views ?? []).map((declaration) => slots.get(declaration.kind)!)

    /** A loaded extension's module, imported once for the Client's whole run. */
    async function importOf(entry: Extract<CatalogueEntry, { source: 'loaded' }>): Promise<ExtensionModule> {
        let pending = modules.get(entry.id)
        if (!pending) {
            pending = importModule(resolve(entry.base, entry.package.manifest.main))
            // A failed fetch is not remembered, so switching the extension back on tries again.
            pending.catch(() => modules.delete(entry.id))
            modules.set(entry.id, pending)
        }
        const module = await pending
        if (typeof (module as Partial<ExtensionModule> | null)?.activate !== 'function') {
            throw new Error(`${relativeMain(entry.package.manifest.main)} does not export an activate function.`)
        }
        return module as ExtensionModule
    }

    /** Run `activate` with a fresh context, and judge what the extension supplied. */
    function activate(entry: CatalogueEntry, module: ExtensionModule, services: GraphServices): void {
        const scoped = createScopedContext(entry, services, client, (kind, view) => slots.get(kind)!.supply(view))
        let returned: unknown
        try {
            returned = module.activate(scoped.context)
        } catch (error) {
            scoped.dispose()
            throw error
        }
        running.set(entry.id, { scoped, returned: typeof returned === 'function' ? (returned as () => void) : undefined })
        const name = entry.package.manifest.displayName
        for (const slot of slotsOf(entry)) {
            if (slot.state().status === 'waiting') slot.set({ status: 'failed', message: `${name} did not supply this View.` })
        }
        setStatus(entry.id, { state: 'running' })
    }

    function fail(entry: CatalogueEntry, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[extensions] ${entry.id} could not start`, error)
        for (const slot of slotsOf(entry)) slot.set({ status: 'failed', message: `${entry.package.manifest.displayName} could not start: ${message}` })
        setStatus(entry.id, { state: 'failed', message })
    }

    /**
     * Start one extension. A compiled-in one starts before this returns, so the Layout a graph
     * restores finds its Views ready and its Commands registered. A loaded one starts once its
     * bundle has arrived, unless its graph closed or it was switched in the meantime.
     */
    function startOne(entry: CatalogueEntry, services: GraphServices): Promise<void> {
        if (entry.source === 'compiled-in') {
            try {
                activate(entry, entry.module, services)
            } catch (error) {
                fail(entry, error)
            }
            return Promise.resolve()
        }
        const ticket = generation.get(entry.id) ?? 0
        const stale = () => graph !== services || (generation.get(entry.id) ?? 0) !== ticket
        setStatus(entry.id, { state: 'starting' })
        const manifest = entry.package.manifest
        const styled =
            manifest.isolation === 'page' && !pageStylesAdopted.has(entry.id)
                ? pageStyles(
                      (manifest.styles ?? []).map((path) => resolve(entry.base, path)),
                      entry.id,
                  )
                : Promise.resolve(null)
        return Promise.all([importOf(entry), styled]).then(
            ([module, unstyle]) => {
                if (unstyle) {
                    // A start abandoned meanwhile (the graph closed, the switch flipped) takes them out at once.
                    if (stale()) {
                        unstyle()
                        return
                    }
                    pageStylesAdopted.set(entry.id, unstyle)
                }
                if (stale()) return
                try {
                    activate(entry, module, services)
                } catch (error) {
                    fail(entry, error)
                }
            },
            (error) => {
                if (!stale()) fail(entry, error)
            },
        )
    }

    function stopOne(entry: CatalogueEntry, next: SlotState, status: ExtensionStatus) {
        bump(entry.id)
        const active = running.get(entry.id)
        running.delete(entry.id)
        if (active) {
            active.scoped.dispose()
            try {
                active.returned?.()
            } catch (error) {
                console.error(`[extensions] ${entry.id}: its own clean-up failed`, error)
            }
        }
        // A page-mounted extension's stylesheets leave the document with it.
        pageStylesAdopted.get(entry.id)?.()
        pageStylesAdopted.delete(entry.id)
        for (const slot of slotsOf(entry)) slot.set(next)
        setStatus(entry.id, status)
    }

    return {
        catalogue,
        // Read live, so a View address of an extension installed while the Client runs works at once.
        addresses: createAddressBook(() => catalogue.extensions),
        views: () => declared,
        residents: () => residents,
        icons: () => icons,
        async start(services) {
            graph = services
            await Promise.all(catalogue.extensions.filter((entry) => switches.isOn(entry.id)).map((entry) => startOne(entry, services)))
        },
        stop() {
            graph = null
            for (const entry of catalogue.extensions) {
                const on = switches.isOn(entry.id)
                stopOne(entry, on ? { status: 'waiting' } : { status: 'off' }, on ? { state: 'idle' } : { state: 'off' })
            }
        },
        isOn: (id) => switches.isOn(id),
        async setOn(id, on) {
            const entry = catalogue.extensions.find((candidate) => candidate.id === id)
            if (!entry || switches.isOn(id) === on) return
            switches.set(id, on)
            if (!on) {
                stopOne(entry, { status: 'off' }, { state: 'off' })
                return
            }
            bump(id)
            for (const slot of slotsOf(entry)) slot.set({ status: 'waiting' })
            if (graph) await startOne(entry, graph)
            else setStatus(id, { state: 'idle' })
        },
        async retry(id) {
            const entry = catalogue.extensions.find((candidate) => candidate.id === id)
            if (!entry || !graph || !switches.isOn(id)) return
            stopOne(entry, { status: 'waiting' }, { state: 'idle' })
            await startOne(entry, graph)
        },
        status: (id) => statuses.get(id) ?? { state: 'off' },
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        async add(entry) {
            if (catalogue.extensions.some((existing) => existing.id === entry.id)) throw new Error(`The extension "${entry.id}" is already here.`)
            catalogue.extensions.push(entry)
            const { views, icons: addedIcons } = declare(entry)
            if (views.length > 0 || Object.keys(addedIcons).length > 0) {
                for (const listener of declaredListeners) listener(views, addedIcons)
            }
            const on = switches.isOn(entry.id)
            statuses.set(entry.id, on ? { state: 'idle' } : { state: 'off' })
            notify()
            if (on && graph) await startOne(entry, graph)
        },
        remove(id) {
            const index = catalogue.extensions.findIndex((candidate) => candidate.id === id)
            if (index === -1) return
            const entry = catalogue.extensions[index]
            stopOne(entry, { status: 'failed', message: `${entry.package.manifest.displayName} was removed from this device.` }, { state: 'off' })
            catalogue.extensions.splice(index, 1)
            statuses.delete(id)
            // A later release has another address, so its module is imported afresh.
            modules.delete(id)
            notify()
        },
        onDeclared(listener) {
            declaredListeners.add(listener)
            return () => declaredListeners.delete(listener)
        },
    }
}

interface MutableSlot extends ViewSlot {
    set(state: SlotState): void
    /** The extension supplied its View. Returns the undo, which sends the slot back to waiting. */
    supply(view: ViewContribution): () => void
}

function createSlot(
    kind: string,
    extensionId: string,
    displayName: string,
    isolation: { styles: string[] } | null,
    initial: SlotState,
    notifyHost: () => void,
): MutableSlot {
    let state = initial
    const listeners = new Set<() => void>()
    const set = (next: SlotState) => {
        if (sameState(state, next)) return
        state = next
        for (const listener of listeners) listener()
        notifyHost()
    }
    return {
        kind,
        extensionId,
        displayName,
        isolation,
        state: () => state,
        subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        set,
        supply(view) {
            set({ status: 'ready', view })
            return () => {
                if (state.status === 'ready' && state.view === view) set({ status: 'waiting' })
            }
        },
    }
}

function sameState(a: SlotState, b: SlotState): boolean {
    if (a.status !== b.status) return false
    if (a.status === 'ready' && b.status === 'ready') return a.view === b.view
    if (a.status === 'failed' && b.status === 'failed') return a.message === b.message
    return true
}

/** A path in a package, as its manifest writes it, under the address the package is served at. */
function resolve(base: string, path: string): string {
    return `${base}${relativeMain(path)}`
}

function relativeMain(path: string): string {
    return path.replace(/^\.\//, '')
}
