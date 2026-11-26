/**
 * Failures, in the vocabulary of the Native Bridge. Everything below the port throws a
 * {@link NativeFailure} or a raw Node error, and {@link failureOf} turns either into the name the page
 * reads. A name the page does not know would fall through its handling, so the table is complete:
 * anything unrecognised is an `OperationError`.
 */
import type { NativeErrorName } from '@appsoftwareltd/etherpk-native-bridge'

export class NativeFailure extends Error {
    constructor(readonly failure: NativeErrorName, message: string) {
        super(message)
        this.name = failure
    }
}

/** What each system error code means to the page. */
const CODES: Record<string, NativeErrorName> = {
    ENOENT: 'NotFoundError',
    ENOTDIR: 'NotFoundError',
    EISDIR: 'TypeMismatchError',
    EACCES: 'NotAllowedError',
    EPERM: 'NotAllowedError',
    EROFS: 'NoModificationAllowedError',
    EEXIST: 'InvalidModificationError',
    ENOTEMPTY: 'InvalidModificationError',
    EINVAL: 'InvalidModificationError',
    ENAMETOOLONG: 'InvalidModificationError',
    EBUSY: 'InvalidStateError',
    ETXTBSY: 'InvalidStateError',
    EAGAIN: 'InvalidStateError',
    EMFILE: 'InvalidStateError',
    ENFILE: 'InvalidStateError',
    ENOSPC: 'QuotaExceededError',
    EDQUOT: 'QuotaExceededError',
    EFBIG: 'QuotaExceededError',
    EIO: 'NotReadableError',
    ENXIO: 'NotReadableError',
    ENODEV: 'NotReadableError',
    ESTALE: 'NotReadableError',
    ETIMEDOUT: 'NotReadableError',
    ENOTCONN: 'NotReadableError',
    EHOSTDOWN: 'NotReadableError',
    ERR_FS_FILE_TOO_LARGE: 'NotReadableError',
    ELOOP: 'SecurityError',
    ENOSYS: 'NotSupportedError',
    ENOTSUP: 'NotSupportedError',
    EOPNOTSUPP: 'NotSupportedError',
}

/**
 * What the page is told of a system error, one sentence for each name. The system's own message
 * holds the full path of the file, which the page never has, so that goes to the log alone.
 */
const MESSAGES: Record<NativeErrorName, string> = {
    AbortError: 'It was cancelled.',
    NotFoundError: 'Nothing is there.',
    NotAllowedError: 'The system does not allow it.',
    TypeMismatchError: 'It is not the kind of entry that was asked for.',
    InvalidModificationError: 'That change cannot be made there.',
    NoModificationAllowedError: 'The file cannot be changed.',
    InvalidStateError: 'The file is in use. Try again.',
    QuotaExceededError: 'The disk is full.',
    NotReadableError: 'The file could not be read.',
    NotSupportedError: 'The system does not support it.',
    SecurityError: 'It leads out of the folder.',
    NetworkError: 'The network could not be reached.',
    OperationError: 'It did not work.',
}

/** System errors that are an ordinary answer (nothing there, something there already), not a fault. */
const ORDINARY = new Set(['ENOENT', 'ENOTDIR', 'EEXIST', 'ENOTEMPTY'])

export function codeOf(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' ? code : null
}

export function isMissing(error: unknown): boolean {
    const code = codeOf(error)
    return code === 'ENOENT' || code === 'ENOTDIR'
}

export function failureOf(error: unknown): NativeFailure {
    if (error instanceof NativeFailure) return error
    const code = codeOf(error)
    const name = (code && CODES[code]) || 'OperationError'
    return new NativeFailure(name, MESSAGES[name])
}

/**
 * Whether a failure is a fault the log needs: anything the shell did not expect, and every system
 * error but the ordinary answers. A refusal of the shell's own (`NativeFailure`) is an answer.
 */
export function isFault(error: unknown): boolean {
    if (error instanceof NativeFailure) return error.failure === 'OperationError'
    const code = codeOf(error)
    return code === null || !ORDINARY.has(code)
}
