/**
 * The Client's own Commands that any extension may run (ADR 0120, amended 2026-10-17): through
 * `commands.execute`, or as the Command of a menu row or a button it adds. Each one keeps its id
 * and the argument it takes in every release, as the rest of the Stable API does. An extension may
 * also run its own Commands and those of the other extensions running, by their ids.
 *
 * - `agents.settings`: open Settings and Extensions at the Agents tab. It takes no argument.
 *
 * @public
 */
export const CLIENT_COMMANDS: readonly string[] = ['agents.settings']
