package com.etherpk.app.files

/** What the system handed to the app and the page has not taken yet. Each is given once, oldest first. */
class Launches(private val arrived: () -> Unit) {
    private val waiting = ArrayDeque<Map<String, Any?>>()

    fun add(launch: Map<String, Any?>) {
        synchronized(waiting) {
            // A caller that sends without end keeps the newest, and the app its memory.
            if (waiting.size >= MOST) waiting.removeFirst()
            waiting.addLast(launch)
        }
        arrived()
    }

    fun take(): List<Map<String, Any?>> = synchronized(waiting) { waiting.toList().also { waiting.clear() } }

    private companion object {
        const val MOST = 20
    }
}
