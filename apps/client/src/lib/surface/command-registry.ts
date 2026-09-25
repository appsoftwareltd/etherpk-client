/**
 * The Command registry (Extension Architecture.md → Command registry — contract).
 * A named, invocable action surface. Its genuine first *indirect* consumer is the
 * app-level keyboard-shortcut layer (keybindings.ts) — keys → command ids — which is
 * why it lands now (Dual Mode Editor.md → Command & contribution registries).
 *
 * Stringly-typed with an untyped payload (the honest runtime shape — extension command
 * ids and args are dynamic). First-party callers use typed wrappers over this.
 */

const ID_SEPARATOR = ':' // reserved for viewKey; commands use `.`

export type CommandHandler = (arg?: unknown) => unknown | Promise<unknown>

export interface CommandRegistry {
    /** Register a handler. Throws on collision or a non-registerable id. Returns an unregister fn. */
    register(id: string, handler: CommandHandler): () => void
    /** Invoke a command. Always returns a Promise (await-safe for sync or async handlers). */
    execute(id: string, arg?: unknown): Promise<unknown>
    has(id: string): boolean
}

/** First-party ids are domained-but-unprefixed (`layout.toggleSidebar`); no `:`. */
export function isRegisterableCommandId(id: string): boolean {
    return id.length > 0 && !id.includes(ID_SEPARATOR)
}

export function createCommandRegistry(): CommandRegistry {
    const handlers = new Map<string, CommandHandler>()
    return {
        register(id, handler) {
            if (!isRegisterableCommandId(id)) {
                throw new Error(`Command id "${id}" is not registerable (must be non-empty and contain no ':').`)
            }
            if (handlers.has(id)) throw new Error(`Command "${id}" is already registered.`)
            handlers.set(id, handler)
            return () => {
                if (handlers.get(id) === handler) handlers.delete(id)
            }
        },
        async execute(id, arg) {
            const handler = handlers.get(id)
            if (!handler) throw new Error(`No command registered for "${id}".`)
            return handler(arg)
        },
        has: (id) => handlers.has(id),
    }
}
