/**
 * The parts of Device Approval (ADR 0125) that the Client and the Sync Server must agree on.
 *
 * The new device posts only a commitment to its one-time public key:
 * `SHA-256(utf8(DEVICE_APPROVAL_COMMIT_LABEL) || publicKey)`. When it later reveals the key, the
 * server checks it against the commitment so an honest server refuses a broken client early. The
 * approving device makes the same check itself, since the server is not trusted to.
 */
export const DEVICE_APPROVAL_COMMIT_LABEL = 'etherpk/device-approval/commit/v2'

/** At most this many requests may be open for one account at a time. */
export const DEVICE_APPROVAL_MAX_OPEN = 3

/** At most this many requests may be made for one account in an hour. */
export const DEVICE_APPROVAL_MAX_PER_HOUR = 20

/** The coded refusal for a client that still speaks the old request shape (ADR 0125). */
export const UPGRADE_REQUIRED_CODE = 'upgrade_required'
