package com.etherpk.app.bridge

/**
 * What the page sent with one call. Nothing in it is trusted: a value that is missing or of another
 * kind refuses the call.
 */
class Arguments(private val values: Map<String, Any?>) {
    private inline fun <reified T> of(name: String): T = values[name] as? T
        ?: throw BridgeFailure(Failure.OPERATION, "The argument $name is missing or of the wrong kind.")

    fun text(name: String): String = of(name)
    fun flag(name: String): Boolean = values[name] as? Boolean ?: false
    fun content(name: String): Content = of(name)

    fun whole(name: String): Long {
        val number = of<Number>(name).toDouble()
        if (number != Math.rint(number) || number < 0 || number > MAX_SAFE) throw BridgeFailure(Failure.OPERATION, "The argument $name is not a whole number.")
        return number.toLong()
    }

    fun texts(name: String): List<String> = of<List<*>>(name).map {
        it as? String ?: throw BridgeFailure(Failure.OPERATION, "The argument $name holds something other than text.")
    }

    /** A value that may be left out. */
    fun any(name: String): Any? = values[name]

    private companion object {
        /** The largest whole number the page's numbers hold exactly. */
        const val MAX_SAFE = 9007199254740991.0
    }
}
