/**
 * A Sync Server a Native App was pointed at in place of the one it was built with (ADR 0214), as the
 * deployment's servers read it (`sync-deployment.ts`). Set once as the page starts, from the app's
 * shell; null in a browser. The sync code does not ask the shell itself: the Headless Client bundles
 * it, and has none.
 *
 * A module of its own, importing nothing, because `hooks.client.ts` sets it before Zod is told not to
 * compile schemas, and an import of the shared package here would build its schemas first.
 */
let server: string | null = null

export function useShellSyncServer(origin: string | null): void {
    server = origin
}

export function shellSyncServerInUse(): string | null {
    return server
}
