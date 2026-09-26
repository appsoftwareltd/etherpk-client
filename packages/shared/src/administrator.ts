/**
 * Who administers a deployment is deployment configuration, not a runtime race.
 *
 * `ADMINISTRATOR_EMAIL_ADDRESS` names the operators of one application - the Sync Server names its
 * own, the Account site names its own - in the same way every other trust decision here is
 * expressed in the environment rather than inferred from whoever registered first. It holds one
 * address, or several separated by commas. It is checked on every request, so setting it after an
 * operator has registered works at once, and removing an address takes the privilege away again.
 */
export function isConfiguredAdministrator(
    email: string | null | undefined,
    configured: string | null | undefined,
): boolean {
    const address = normalise(email)
    if (!address) return false
    return (configured ?? '').split(',').some((entry) => normalise(entry) === address)
}

/**
 * Addresses arrive from OAuth providers, invitations and typing, and differ in case and padding
 * without differing in identity. The local part is case-sensitive in the RFC and case-insensitive
 * at every provider anyone actually uses; matching case-insensitively is the safe reading for a
 * grant that an operator sets by hand.
 */
function normalise(value: string | null | undefined): string | null {
    const trimmed = value?.trim().toLowerCase()
    return trimmed ? trimmed : null
}
