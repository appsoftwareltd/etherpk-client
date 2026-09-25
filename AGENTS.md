# Agent instructions

This repository holds the EtherPK Client (`apps/client`, SvelteKit 2 with Svelte 5 runes), the
Headless Client (`apps/mcp`, a Node MCP server that bundles `apps/client/src/lib` through a `$lib`
alias), and the packages both use (`packages/shared`, `packages/themes`).

## Before you change anything

- This repository is a one-way export of a private repository. A change committed here is
  overwritten by the next export; propose changes as issues. See `CONTRIBUTING.md`.
- Comments cite design records (`ADR 0072`) and glossary terms (`[[Knowledge Graph]]`) from the
  private repository. They are not published here; read the code they annotate instead.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check     # type check every package
pnpm lint
pnpm test      # Vitest suites, beside the code in src/**/*.test.ts
pnpm build
```

Run one package's tests with `pnpm --filter @appsoftwareltd/etherpk-client exec vitest run <path>`.

## Conventions

- Svelte 5 runes only: `$state`, `$derived`, `$props`, `onclick={...}`, snippets. No stores for
  new shared state, no `export let`.
- Tailwind CSS v4. The smallest text size is `text-sm`; de-emphasise with colour, not size.
- Documents are plain Markdown with wikilinks. The editor never rewrites the source to render it.
- Settings the Client reads are listed in `apps/client/.env.example`, and
  `apps/client/src/env-example.test.ts` fails when the two disagree. Add a new setting to both.
- The sync protocol lives in `packages/shared/src/sync-protocol.ts` and is shared with the Sync
  Server. Changing a message shape means a new `SYNC_PROTOCOL_VERSION`.
