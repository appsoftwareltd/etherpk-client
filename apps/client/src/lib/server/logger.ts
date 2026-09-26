/**
 * The structured JSON logger every EtherPK server shares (packages/shared/src/logging/logger.ts).
 * `hooks.server.ts` initialises it from LOG_LEVEL and OPENOBSERVE_URL; with no URL it writes
 * JSON lines to stdout only, which is what a standalone deployment reads.
 */
export * from '@appsoftwareltd/etherpk-shared/server/logger'
