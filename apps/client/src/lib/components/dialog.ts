/**
 * The shared modal dialog shell (`@appsoftwareltd/etherpk-shared/dialog`), as the Client's own
 * module, so a compiled-in extension reaches it through `#lib` as it reaches the rest of the Client
 * (ADR 0121): the Kanban Board's Task Editor (ADR 0170) is one.
 */
export { default as Dialog } from '@appsoftwareltd/etherpk-shared/dialog'
