package com.etherpk.app.folders

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FolderRegistryTest {
    private val dir = Files.createTempDirectory("etherpk-registry").toFile()
    private val file = File(dir, "folders.json")

    @After fun clear() { dir.deleteRecursively() }

    @Test fun foldersOutlastAStartAndKeepTheirIds() {
        val first = FolderRegistry(file).grant("content://tree/a", listOf("pages", "é"), "é")
        val again = FolderRegistry(file)
        assertEquals(first, again.get(first.id))
        assertEquals(first.id, again.grant("content://tree/a", listOf("pages", "é"), "é").id)
        assertNotEquals(first.id, again.grant("content://tree/a", emptyList(), "a").id)
    }

    @Test fun aTreeIsLetGoWithItsLastFolder() {
        val registry = FolderRegistry(file)
        val tree = registry.grant("tree", emptyList(), "a")
        val child = registry.grant("tree", listOf("b"), "b")
        assertNull(registry.forget(tree.id))
        assertEquals("tree", registry.forget(child.id))
        assertNull(registry.forget(child.id))
        assertNull(FolderRegistry(file).get(tree.id))
    }

    @Test fun aFileThatCannotBeReadIsMovedAside() {
        file.writeText("[{")
        val registry = FolderRegistry(file)
        registry.grant("tree", emptyList(), "a")
        assertTrue(File(dir, "folders.json.unreadable").exists())
        assertEquals(2, dir.list()!!.size)
    }
}
