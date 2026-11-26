package com.etherpk.app

import com.etherpk.app.files.OpenedFiles
import com.etherpk.app.files.Saves
import com.etherpk.app.folders.FolderMethods
import com.etherpk.app.folders.FolderRegistry
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CompletableFuture
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The shell and the interface in packages/native-bridge say the same. */
class BridgeInterfaceTest {
    private val root = File(System.getProperty("etherpk.repository")!!)
    private val text = File(root, "packages/native-bridge/src/index.ts").readText()
    private val table = text.substringAfter("METHOD_TABLE = {").substringBefore("}")
    private val methods = Regex("'([a-zA-Z.]+)': 1").findAll(table).map { it.groupValues[1] }.toSet()

    @Test fun theVersionAndOriginAreTheInterfaces() {
        assertTrue(text.contains("NATIVE_BRIDGE_VERSION = ${Shell.BRIDGE_VERSION}\n"))
        assertTrue(text.contains("INSTALLED_APP_ORIGIN = '${com.etherpk.app.web.APP_ORIGIN}'"))
        assertTrue(File(root, "apps/android/app/src/main/res/raw/port.js").readText().contains("'etherpkNative'"))
    }

    /** Every method has a handler, and no handler is outside the table. The shell's own are read from its source. */
    @Test fun theTableOfMethodsIsTheInterfaces() {
        val dir = Files.createTempDirectory("etherpk-interface").toFile()
        val system = java.lang.reflect.Proxy.newProxyInstance(javaClass.classLoader, arrayOf(com.etherpk.app.folders.FolderSystem::class.java)) { _, _, _ -> null } as com.etherpk.app.folders.FolderSystem
        val built = FolderMethods(FolderRegistry(File(dir, "f")), system, { _, _ -> }).handlers.keys + OpenedFiles().handlers.keys + Saves(dir) { _, _ -> CompletableFuture() }.handlers.keys
        val own = Regex("\"([a-z]+\\.[a-zA-Z]+)\" to \\{").findAll(File(root, "apps/android/app/src/main/kotlin/com/etherpk/app/Shell.kt").readText()).map { it.groupValues[1] }.toSet()
        dir.deleteRecursively()
        assertEquals(methods, built + own)
        assertTrue(methods.size > 30)
    }
}
