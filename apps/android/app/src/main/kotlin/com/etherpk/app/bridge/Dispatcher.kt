package com.etherpk.app.bridge

import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionException
import java.util.concurrent.ExecutionException

/** What a call answers: a value of plain data and [Content], or a failure with its name. */
sealed interface Reply {
    data class Value(val value: Any?) : Reply
    data class Refused(val failure: String, val message: String) : Reply
}

/** Answers one method. A value, or a future of one for a call that waits for the person. */
typealias Handler = (Arguments) -> Any?

/**
 * The fixed table of what the page may ask. A method that is not in it is refused, and whatever a
 * handler throws becomes a failure with a name from the list.
 */
class Dispatcher(private val handlers: Map<String, Handler>, private val log: (String, Throwable) -> Unit = { _, _ -> }) {
    val methods: Set<String> get() = handlers.keys

    fun call(method: String, args: Map<String, Any?>, answer: (Reply) -> Unit) {
        val handler = handlers[method]
        if (handler == null) {
            answer(Reply.Refused(Failure.NOT_SUPPORTED, "This is not a method of the shell."))
            return
        }
        val result = try {
            handler(Arguments(args))
        } catch (error: Throwable) {
            answer(refused(method, error))
            return
        }
        if (result !is CompletableFuture<*>) {
            answer(Reply.Value(result))
            return
        }
        result.whenComplete { value, error -> answer(if (error == null) Reply.Value(value) else refused(method, error)) }
    }

    private fun refused(method: String, thrown: Throwable): Reply {
        val error = if ((thrown is CompletionException || thrown is ExecutionException) && thrown.cause != null) thrown.cause!! else thrown
        if (error is BridgeFailure) {
            // A failure with a cause is one the system reported: the log keeps its detail and trace.
            if (error.cause != null) log(method, error)
            return Reply.Refused(error.failure, error.message.orEmpty())
        }
        // Not a failure the shell foresaw. An out-of-memory error is here too: the call fails, the app
        // does not. The detail goes to the log, and the page, which may show the message, gets none of it.
        log(method, error)
        return Reply.Refused(Failure.OPERATION, UNFORESEEN)
    }
}

/** The message of a failure the shell did not foresee. */
const val UNFORESEEN = "The app could not do this."
