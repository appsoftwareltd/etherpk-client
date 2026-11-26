package com.etherpk.app.bridge

import java.util.concurrent.CompletableFuture

/** The names a failure may have on the bridge (NativeErrorName in packages/native-bridge). */
object Failure {
    const val ABORT = "AbortError"
    const val NOT_FOUND = "NotFoundError"
    const val NOT_ALLOWED = "NotAllowedError"
    const val TYPE_MISMATCH = "TypeMismatchError"
    const val INVALID_MODIFICATION = "InvalidModificationError"
    const val NO_MODIFICATION = "NoModificationAllowedError"
    const val BUSY = "InvalidStateError"
    const val QUOTA = "QuotaExceededError"
    const val NOT_READABLE = "NotReadableError"
    const val NOT_SUPPORTED = "NotSupportedError"
    const val SECURITY = "SecurityError"
    const val NETWORK = "NetworkError"
    const val OPERATION = "OperationError"
}

/** A failure the page is told by name. The message is for the log, and the page words its own. */
class BridgeFailure(val failure: String, message: String, cause: Throwable? = null) : Exception(message, cause)

/** `CompletableFuture.failedFuture`, which Android has from version 12. */
fun <T> failed(error: Throwable): CompletableFuture<T> = CompletableFuture<T>().also { it.completeExceptionally(error) }
