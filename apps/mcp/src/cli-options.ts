/**
 * The flags the `etherpk-mcp` command line takes, for `parseArgs` in `main.ts`. Kept apart so the
 * Claude Code plugin's test reads the arguments it starts the server with as the command does.
 */
export const CLI_OPTIONS = {
    'sync-server': { type: 'string' },
    pat: { type: 'string' },
    code: { type: 'string' },
    'recovery-code': { type: 'boolean' },
    graph: { type: 'string' },
    folder: { type: 'string' },
    'no-semantic': { type: 'boolean' },
    publication: { type: 'string' },
    out: { type: 'string' },
    github: { type: 'string' },
    replace: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    all: { type: 'boolean' },
    name: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
} as const
