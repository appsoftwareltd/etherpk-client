/**
 * This Client's release: the version in `apps/client/package.json`, frozen into the build by the
 * `define` in vite.config.ts. `pnpm release:version` gives the Client, the Sync Server and the
 * Headless Client of one release the same version.
 */
export const RELEASE_VERSION: string = __RELEASE_VERSION__
