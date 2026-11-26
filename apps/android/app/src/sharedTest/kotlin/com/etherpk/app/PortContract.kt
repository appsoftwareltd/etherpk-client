package com.etherpk.app

import com.etherpk.app.bridge.BytesContent
import com.etherpk.app.bridge.Content
import com.etherpk.app.bridge.Dispatcher
import com.etherpk.app.bridge.Frame
import com.etherpk.app.bridge.Port
import com.etherpk.app.bridge.bytes
import com.etherpk.app.folders.checkedRelativePath
import java.io.File
import java.text.Normalizer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/** A reply as the page has it, its bytes as arrays. */
class Answer(val ok: Boolean, val value: Any?, val name: String, val message: String)

/** The page's end of a port, in Kotlin: every call and answer goes through the same frames. */
class TestPort(dispatcher: Dispatcher, private val scratch: File, parallel: Int = 8) {
    private val workers = Executors.newFixedThreadPool(parallel)
    val port = Port(dispatcher, workers, File(scratch, "uploads"))
    val events = CopyOnWriteArrayList<Pair<String, Map<*, *>>>()
    private val ids = AtomicLong()

    fun send(method: String, args: Any?): CompletableFuture<Answer> {
        val id = ids.incrementAndGet()
        val answered = CompletableFuture<Answer>()
        val message = Frame.write(mapOf("id" to id, "method" to method, "args" to sendable(args)), Long.MAX_VALUE) { error("nothing is streamed to the shell") }
        port.receive(message) { answered.complete(read(it)) }
        return answered
    }

    fun call(method: String, args: Any?): Answer = send(method, args).get(60, TimeUnit.SECONDS)

    fun emit(name: String, detail: Any?) {
        events.add(name to Frame.read(port.event(name, detail))!!.value("detail") as Map<*, *>)
    }

    private fun sendable(value: Any?): Any? = when (value) {
        is ByteArray -> BytesContent(value)
        is Map<*, *> -> value.mapValues { sendable(it.value) }
        is List<*> -> value.map(::sendable)
        else -> value
    }

    private fun read(message: ByteArray): Answer {
        val frame = Frame.read(message)!!
        val header = frame.header
        return Answer(header.getBoolean("ok"), received(frame.value("value")), header.optString("name"), header.optString("message"))
    }

    private fun received(value: Any?): Any? = when (value) {
        is Content -> value.bytes()
        is Map<*, *> -> if (value.containsKey(Frame.STREAM)) port.takeStream(value[Frame.STREAM] as String)!!.bytes() else value.mapValues { received(it.value) }
        is List<*> -> value.map(::received)
        is Int -> value.toLong()
        else -> value
    }

    fun close() = workers.shutdownNow().let { }
}

/** The disk as another program sees it. Paths are from a scratch directory of the test's own. */
interface ContractDisk {
    fun write(path: String, text: String)
    fun read(path: String): String?
    fun makeDirectory(path: String)
    fun remove(path: String)
    fun names(path: String): List<String>
    /** False where there are no links. */
    fun link(path: String, target: String): Boolean
    /** Renames a file or a directory in place. False where the test's disk cannot. */
    fun rename(path: String, to: String): Boolean = false
}

interface ContractHarness {
    val port: TestPort
    val disk: ContractDisk
    val ignoresCase: Boolean
    /** Whether a name given decomposed stays so on this disk. */
    val keepsNameForm: Boolean get() = true
    val watches: Boolean
    /** Whether a reader can meet a half-written file: SAF has no way to replace one in a step. */
    val replacesAtOnce: Boolean get() = true
    /** Whether a directory can be moved. Not every document provider can. */
    val movesDirectories: Boolean get() = true
    fun answerFolder(path: String?)
    /** Null where the harness cannot answer a save dialog. */
    fun answerSave(path: String?): Boolean = false
    fun openFile(path: String): Map<*, *>? = null
    fun dispose()
}

/**
 * The suite every shell's port runs (packages/native-bridge/src/contract.ts), in Kotlin. It runs on the
 * JVM over a directory, and on a device over shared storage and over a document provider. Keep the two
 * in step: a rule added there is added here.
 */
abstract class PortContract {
    abstract fun makeHarness(): ContractHarness

    private lateinit var world: ContractHarness
    private lateinit var folder: Map<*, *>
    private lateinit var id: String
    private val disk get() = world.disk

    @Before fun makeWorld() {
        world = makeHarness()
        disk.write("outside.md", "not the app’s")
        disk.write("Notes/pages/A.md", "one")
        folder = pick("Notes")
        id = folder["id"] as String
    }

    @After fun endWorld() { if (::world.isInitialized) world.dispose() }

    private fun pick(path: String): Map<*, *> {
        world.answerFolder(path)
        return call("folders.pick") as Map<*, *>
    }

    private fun call(method: String, vararg args: Pair<String, Any?>): Any? {
        val answer = world.port.call(method, mapOf(*args))
        if (!answer.ok) throw AssertionError("$method was refused: ${answer.name}: ${answer.message}")
        return answer.value
    }

    private fun refusal(method: String, vararg args: Pair<String, Any?>): String =
        world.port.call(method, mapOf(*args)).let { if (it.ok) "nothing" else it.name }

    private fun file(path: String, content: String) = disk.write("Notes/$path", content)
    private fun readText(path: String, folder: String = id) = String((call("fs.read", "folder" to folder, "path" to path) as Map<*, *>)["bytes"] as ByteArray)
    private fun list(path: String, stamps: Boolean = false) = (call("fs.list", "folder" to id, "path" to path, "stamps" to stamps) as List<*>).map { it as Map<*, *> }
    private fun listedNames(path: String) = list(path).map { it["name"] as String }.sorted()
    private fun stampOf(answer: Any?): Map<String, Any?> = (answer as Map<*, *>).let { mapOf("lastModified" to it["lastModified"], "size" to it["size"]) }
    private fun write(path: String, content: String, vararg more: Pair<String, Any?>) =
        call("fs.write", "folder" to id, "path" to path, "bytes" to content.toByteArray(), *more) as Map<*, *>
    private fun refusedWrite(path: String, content: String, vararg more: Pair<String, Any?>) =
        refusal("fs.write", "folder" to id, "path" to path, "bytes" to content.toByteArray(), *more)
    private fun walk(path: String, skip: List<String>, limit: Int) = call("fs.walk", "folder" to id, "path" to path, "skip" to skip, "limit" to limit) as Map<*, *>
    private fun decomposed(name: String) = Normalizer.normalize(name, Normalizer.Form.NFD)

    /** Every call with a path in it. */
    private fun callsWithPath(path: String, folder: String = id): List<Pair<String, Map<String, Any?>>> = listOf(
        "fs.list" to mapOf("folder" to folder, "path" to path, "stamps" to false),
        "fs.stat" to mapOf("folder" to folder, "path" to path),
        "fs.canonicalPath" to mapOf("folder" to folder, "path" to path),
        "fs.read" to mapOf("folder" to folder, "path" to path),
        "fs.readMany" to mapOf("folder" to folder, "paths" to listOf(path)),
        "fs.write" to mapOf("folder" to folder, "path" to path, "bytes" to "x".toByteArray(), "createDirectories" to true),
        "fs.createDirectory" to mapOf("folder" to folder, "path" to path),
        "fs.remove" to mapOf("folder" to folder, "path" to path),
        "fs.move" to mapOf("folder" to folder, "from" to path, "to" to "there.md"),
        "fs.move" to mapOf("folder" to folder, "from" to "pages/A.md", "to" to path),
        "fs.walk" to mapOf("folder" to folder, "path" to path, "skip" to emptyList<String>(), "limit" to 10),
        "folders.child" to mapOf("folder" to folder, "path" to path),
    )

    // Folders

    @Test fun aChosenFolderHasItsNameAndAnIdThatSaysNothing() {
        assertEquals("Notes", folder["name"])
        assertFalse(id.contains("Notes"))
        assertTrue(folder["displayPath"] == null || (folder["displayPath"] as String).contains("Notes"))
    }

    @Test fun aCancelledDialogIsAnAbort() {
        world.answerFolder(null)
        assertEquals("AbortError", refusal("folders.pick"))
    }

    @Test fun getAnswersTheFolderAndNullOnceItIsGone() {
        assertEquals(folder, call("folders.get", "folder" to id))
        disk.remove("Notes")
        assertNull(call("folders.get", "folder" to id))
    }

    @Test fun aFolderThatIsGoneIsNotFoundAndNothingMakesItAgain() {
        disk.remove("Notes")
        for ((method, args) in callsWithPath("pages")) assertEquals(method, "NotFoundError", world.port.call(method, args).name)
        assertEquals("NotFoundError", refusal("fs.list", "folder" to id, "path" to "", "stamps" to true))
        assertEquals("NotFoundError", refusal("fs.createDirectory", "folder" to id, "path" to ""))
        assertNull(call("folders.get", "folder" to id))
    }

    @Test fun aFolderWithAFileInItsPlaceIsGone() {
        disk.remove("Notes")
        disk.write("Notes", "a file now")
        for ((method, args) in callsWithPath("pages")) assertEquals(method, "NotFoundError", world.port.call(method, args).name)
        assertNull(call("folders.get", "folder" to id))
    }

    @Test fun anIdTheShellDidNotIssueIsRefused() {
        for (made in listOf("made-up", "", "../Notes", "/")) {
            assertNull(call("folders.get", "folder" to made))
            assertEquals("NotAllowedError", refusal("fs.list", "folder" to made, "path" to "", "stamps" to false))
            assertEquals("NotAllowedError", refusal("fs.write", "folder" to made, "path" to "A.md", "bytes" to "x".toByteArray()))
        }
    }

    @Test fun aForgottenFolderIsRefusedAndItsFilesUntouched() {
        call("folders.forget", "folder" to id)
        assertNull(call("folders.get", "folder" to id))
        assertEquals("NotAllowedError", refusal("fs.read", "folder" to id, "path" to "pages/A.md"))
        assertEquals("one", disk.read("Notes/pages/A.md"))
    }

    @Test fun relationKnowsOneFolderTwiceOneInsideAnotherAndTwoApart() {
        val again = pick("Notes")["id"]
        disk.makeDirectory("Notes/a/b")
        val inside = pick("Notes/a/b")["id"]
        disk.makeDirectory("Notes and more")
        val beside = pick("Notes and more")["id"]
        assertEquals(mapOf("same" to true, "path" to emptyList<String>()), call("folders.relation", "a" to id, "b" to again))
        assertEquals(mapOf("same" to false, "path" to listOf("a", "b")), call("folders.relation", "a" to id, "b" to inside))
        assertEquals(mapOf("same" to false, "path" to null), call("folders.relation", "a" to inside, "b" to id))
        assertEquals(mapOf("same" to false, "path" to null), call("folders.relation", "a" to id, "b" to beside))
        // A folder reached as a child and the same one chosen are one folder.
        val child = (call("folders.child", "folder" to id, "path" to "a") as Map<*, *>)["id"]
        assertEquals(mapOf("same" to false, "path" to listOf("b")), call("folders.relation", "a" to child, "b" to inside))
        val lower = (call("folders.child", "folder" to child, "path" to "b") as Map<*, *>)["id"]
        assertEquals(mapOf("same" to true, "path" to emptyList<String>()), call("folders.relation", "a" to inside, "b" to lower))
    }

    @Test fun childIsAFolderOfItsOwnConfinedToItself() {
        val child = call("folders.child", "folder" to id, "path" to "pages") as Map<*, *>
        assertEquals("pages", child["name"])
        assertEquals("one", readText("A.md", child["id"] as String))
        assertEquals("SecurityError", refusal("fs.read", "folder" to child["id"], "path" to "../pages/A.md"))
        assertEquals(mapOf("same" to false, "path" to listOf("pages")), call("folders.relation", "a" to id, "b" to child["id"]))
    }

    @Test fun aChildThatIsGoneIsNotFoundAndIsNotMadeAgain() {
        val child = (call("folders.child", "folder" to id, "path" to "pages") as Map<*, *>)["id"] as String
        disk.remove("Notes/pages")
        for ((method, args) in callsWithPath("a.md", child)) assertEquals(method, "NotFoundError", world.port.call(method, args).name)
        assertEquals(emptyList<String>(), disk.names("Notes"))
    }

    @Test fun childRefusesWhatIsNotADirectory() {
        assertEquals("TypeMismatchError", refusal("folders.child", "folder" to id, "path" to "pages/A.md"))
        assertEquals("NotFoundError", refusal("folders.child", "folder" to id, "path" to "nowhere"))
    }

    // Reading

    @Test fun listNamesFilesAndDirectoriesWithWholeStamps() {
        file("b.md", "two")
        val listed = list("", stamps = true).associateBy { it["name"] }
        assertEquals(setOf("b.md", "pages"), listed.keys)
        assertEquals("directory", listed["pages"]!!["kind"])
        assertEquals("file", listed["b.md"]!!["kind"])
        assertEquals(3L, listed["b.md"]!!["size"])
        assertTrue(listed["b.md"]!!["lastModified"] is Long)
        assertEquals(listOf(mapOf("name" to "A.md", "kind" to "file")), list("pages"))
    }

    @Test fun listStatAndReadAgreeOnAStamp() {
        val stamp = stampOf(list("pages", stamps = true).single())
        assertEquals(mapOf("kind" to "file") + stamp, call("fs.stat", "folder" to id, "path" to "pages/A.md"))
        assertEquals(stamp, stampOf(call("fs.read", "folder" to id, "path" to "pages/A.md")))
        assertEquals(stamp, stampOf((call("fs.readMany", "folder" to id, "paths" to listOf("pages/A.md")) as List<*>).single()))
    }

    @Test fun statAnswersADirectoryTheFolderItselfAndNullForNothing() {
        assertEquals(mapOf("kind" to "directory"), call("fs.stat", "folder" to id, "path" to "pages"))
        assertEquals(mapOf("kind" to "directory"), call("fs.stat", "folder" to id, "path" to ""))
        assertNull(call("fs.stat", "folder" to id, "path" to "pages/B.md"))
        assertNull(call("fs.stat", "folder" to id, "path" to "pages/A.md/under a file"))
    }

    @Test fun whatIsNotThereAndTheWrongKindHaveTheirNames() {
        assertEquals("NotFoundError", refusal("fs.read", "folder" to id, "path" to "pages/B.md"))
        assertEquals("NotFoundError", refusal("fs.list", "folder" to id, "path" to "nowhere", "stamps" to false))
        assertEquals("TypeMismatchError", refusal("fs.read", "folder" to id, "path" to "pages"))
        assertEquals("TypeMismatchError", refusal("fs.list", "folder" to id, "path" to "pages/A.md", "stamps" to false))
    }

    @Test fun readManyAnswersInOrderWithNullForNothing() {
        file("b.md", "two")
        val read = call("fs.readMany", "folder" to id, "paths" to listOf("b.md", "nowhere.md", "pages/A.md", "b.md", "pages")) as List<*>
        assertEquals(listOf("two", null, "one", "two", null), read.map { one -> one?.let { String((it as Map<*, *>)["bytes"] as ByteArray) } })
        assertEquals(emptyList<Any>(), call("fs.readMany", "folder" to id, "paths" to emptyList<String>()))
    }

    @Test fun bytesSurviveAsTheyAre() {
        val every = ByteArray(256) { it.toByte() }
        call("fs.write", "folder" to id, "path" to "every.bin", "bytes" to every)
        assertArrayEquals(every, (call("fs.read", "folder" to id, "path" to "every.bin") as Map<*, *>)["bytes"] as ByteArray)
        call("fs.write", "folder" to id, "path" to "empty.bin", "bytes" to ByteArray(0))
        assertEquals(0L, (call("fs.read", "folder" to id, "path" to "empty.bin") as Map<*, *>)["size"])
    }

    @Test fun aFileLargerThanAMessageIsReadAndWritten() {
        val large = Random(1).nextBytes(9 * 1024 * 1024 + 17)
        call("fs.write", "folder" to id, "path" to "large.bin", "bytes" to large)
        assertArrayEquals(large, (call("fs.read", "folder" to id, "path" to "large.bin") as Map<*, *>)["bytes"] as ByteArray)
        val both = call("fs.readMany", "folder" to id, "paths" to listOf("large.bin", "pages/A.md", "large.bin")) as List<*>
        assertArrayEquals(large, (both[2] as Map<*, *>)["bytes"] as ByteArray)
        assertEquals("one", String((both[1] as Map<*, *>)["bytes"] as ByteArray))
    }

    @Test fun walkAnswersFilesFromTheFolderSkipsNamesAndSaysWhenItStopped() {
        for (path in listOf("a/b/c.md", "a/skip/no.md", "skip/no.md", "d.md")) file(path, "x")
        val all = walk("", listOf("skip"), 100)
        assertEquals(listOf("a/b/c.md", "d.md", "pages/A.md"), (all["files"] as List<*>).map { it as String }.sorted())
        assertEquals(false, all["truncated"])
        assertEquals(mapOf("files" to listOf("a/b/c.md"), "truncated" to false), walk("a", listOf("skip"), 100))
        val some = walk("", emptyList(), 2)
        assertEquals(2, (some["files"] as List<*>).size)
        assertEquals(true, some["truncated"])
        assertEquals(false, walk("a", listOf("skip"), 1)["truncated"])
    }

    // Names

    @Test fun walkAnswersEachPathAsTheDiskSpellsIt() {
        file("Sub Folder/Mixed Case.MD", "x")
        assertEquals(listOf("Sub Folder/Mixed Case.MD", "pages/A.md"), (walk("", emptyList(), 10)["files"] as List<*>).map { it as String }.sorted())
    }

    @Test fun canonicalPathIsTheDisksSpelling() {
        assertEquals("pages/A.md", call("fs.canonicalPath", "folder" to id, "path" to "pages/A.md"))
        assertNull(call("fs.canonicalPath", "folder" to id, "path" to "pages/B.md"))
        assertEquals("", call("fs.canonicalPath", "folder" to id, "path" to ""))
        assertEquals(if (world.ignoresCase) "pages/A.md" else null, call("fs.canonicalPath", "folder" to id, "path" to "PAGES/a.MD"))
    }

    @Test fun aDecomposedNameIsListedAndReachedComposedAndNeverJoinedByASecondFile() {
        val composed = "Café.md"
        file(decomposed(composed), "before")
        assertEquals(listOf(composed, "pages").sorted(), listedNames(""))
        assertEquals(composed, call("fs.canonicalPath", "folder" to id, "path" to composed))
        assertEquals("before", readText(composed))
        assertNotNull((call("fs.readMany", "folder" to id, "paths" to listOf(composed)) as List<*>).single())
        write(composed, "after")
        val stored = if (world.keepsNameForm) decomposed(composed) else composed
        assertEquals(listOf(stored, "pages").sorted(), disk.names("Notes").sorted())
        assertEquals(listOf(composed, "pages/A.md").sorted(), (walk("", emptyList(), 10)["files"] as List<*>).map { it as String }.sorted())
        call("fs.remove", "folder" to id, "path" to composed)
        assertEquals(listOf("pages"), disk.names("Notes"))
    }

    @Test fun aDecomposedDirectoryIsWalkedThrough() {
        file("${decomposed("Été")}/note.md", "x")
        assertEquals("x", readText("Été/note.md"))
        assertEquals(listOf("note.md"), listedNames("Été"))
    }

    // Writing

    @Test fun writeAnswersTheStampTheNextListingGives() {
        for (content in listOf("a", "a much longer note", "")) {
            val stamp = write("pages/A.md", content)
            assertEquals(stampOf(list("pages", stamps = true).single()), stampOf(stamp))
            assertEquals(content.length.toLong(), stamp["size"])
        }
    }

    @Test fun writeNeedsTheDirectoryUnlessToldToCreateIt() {
        assertEquals("NotFoundError", refusedWrite("a/b/c.md", "x"))
        assertNull(disk.read("Notes/a/b/c.md"))
        write("a/b/c.md", "x", "createDirectories" to true)
        assertEquals("x", disk.read("Notes/a/b/c.md"))
    }

    @Test fun writeRefusesADirectoryAndOneThroughAFile() {
        assertEquals("TypeMismatchError", refusedWrite("pages", "x"))
        assertEquals("TypeMismatchError", refusedWrite("pages/A.md/c.md", "x", "createDirectories" to true))
        assertEquals("one", disk.read("Notes/pages/A.md"))
    }

    @Test fun aWriteWhoseStampHoldsGoesThrough() {
        val stamp = stampOf(call("fs.read", "folder" to id, "path" to "pages/A.md"))
        write("pages/A.md", "two", "ifStamp" to stamp)
        assertEquals("two", disk.read("Notes/pages/A.md"))
    }

    @Test fun aWriteWhoseStampDoesNotHoldChangesNothing() {
        val stamp = stampOf(call("fs.read", "folder" to id, "path" to "pages/A.md"))
        file("pages/A.md", "written elsewhere")
        assertEquals("NoModificationAllowedError", refusedWrite("pages/A.md", "two", "ifStamp" to stamp))
        assertEquals("written elsewhere", disk.read("Notes/pages/A.md"))
        disk.remove("Notes/pages/A.md")
        assertEquals("NoModificationAllowedError", refusedWrite("pages/A.md", "two", "ifStamp" to stamp))
        assertNull(disk.read("Notes/pages/A.md"))
    }

    @Test fun absentWritesANewFileAndRefusesOneThatIsThere() {
        write("pages/B.md", "new", "ifStamp" to "absent")
        assertEquals("NoModificationAllowedError", refusedWrite("pages/B.md", "again", "ifStamp" to "absent"))
        assertEquals("new", disk.read("Notes/pages/B.md"))
        write("new/deep/C.md", "c", "ifStamp" to "absent", "createDirectories" to true)
        assertEquals("c", disk.read("Notes/new/deep/C.md"))
    }

    @Test fun ofManyWritesAtOnceWithOneStampExactlyOneLands() {
        val stamp = stampOf(call("fs.read", "folder" to id, "path" to "pages/A.md"))
        val contents = List(8) { "writer ${"x".repeat(it + 1)}" }
        val answers = contents.map { world.port.send("fs.write", mapOf("folder" to id, "path" to "pages/A.md", "bytes" to it.toByteArray(), "ifStamp" to stamp)) }.map { it.get(60, TimeUnit.SECONDS) }
        val landed = contents.filterIndexed { index, _ -> answers[index].ok }
        assertEquals(1, landed.size)
        assertEquals(landed.single(), disk.read("Notes/pages/A.md"))
        assertTrue(answers.filter { !it.ok }.all { it.name == "NoModificationAllowedError" })
    }

    @Test fun ofManyNewFilesAtOnceExactlyOneLandsAndNoneIsRenamed() {
        val answers = List(8) { world.port.send("fs.write", mapOf("folder" to id, "path" to "pages/New.md", "bytes" to "writer $it".toByteArray(), "ifStamp" to "absent")) }.map { it.get(60, TimeUnit.SECONDS) }
        assertEquals(1, answers.count { it.ok })
        assertEquals(listOf("A.md", "New.md"), disk.names("Notes/pages").sorted())
    }

    @Test fun aReaderSeesTheOldBytesOrTheNewAndNothingIsLeftBeside() {
        val short = "s"
        val long = "l".repeat(200_000)
        write("pages/A.md", short)
        val seen = java.util.Collections.synchronizedSet(HashSet<String>())
        val reader = Thread {
            while (!Thread.interrupted()) seen.add(when (disk.read("Notes/pages/A.md")) { null -> "missing"; short, long -> "whole"; else -> "partial" })
        }
        if (world.replacesAtOnce) reader.start()
        repeat(10) { write("pages/A.md", if (it % 2 == 1) short else long) }
        if (world.replacesAtOnce) {
            reader.interrupt()
            reader.join()
            assertEquals(setOf("whole"), seen)
        }
        assertEquals(short, disk.read("Notes/pages/A.md"))
        assertEquals(listOf("A.md"), disk.names("Notes/pages"))
        assertEquals(listOf("A.md"), listedNames("pages"))
    }

    @Test fun createDirectoryMakesTheOnesAboveAndLeavesOneThatIsThere() {
        for (path in listOf("a/b/c", "a/b/c", "pages", "")) call("fs.createDirectory", "folder" to id, "path" to path)
        assertEquals(listOf("c"), disk.names("Notes/a/b"))
        assertEquals("one", disk.read("Notes/pages/A.md"))
        assertEquals("TypeMismatchError", refusal("fs.createDirectory", "folder" to id, "path" to "pages/A.md"))
    }

    @Test fun removeTakesAFileOrADirectoryAndNothingThereIsNoError() {
        file("a/b/c.md", "x")
        for (path in listOf("a", "pages/A.md", "pages/A.md", "nowhere/at all")) call("fs.remove", "folder" to id, "path" to path)
        assertEquals(listOf("pages"), disk.names("Notes"))
        assertEquals(emptyList<String>(), disk.names("Notes/pages"))
    }

    // Moving

    @Test fun movesAFileAndADirectoryWithEverythingInIt() {
        file("a/b/c.md", "x")
        call("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "a/A2.md")
        call("fs.move", "folder" to id, "from" to "a", "to" to "pages/a")
        assertEquals("one", disk.read("Notes/pages/a/A2.md"))
        assertEquals("x", disk.read("Notes/pages/a/b/c.md"))
        assertEquals(listOf("pages"), disk.names("Notes"))
    }

    @Test fun changesOnlyTheCaseOfAName() {
        call("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "pages/a.md")
        call("fs.move", "folder" to id, "from" to "pages", "to" to "Pages")
        assertEquals(listOf("Pages"), disk.names("Notes"))
        assertEquals(listOf("a.md"), disk.names("Notes/Pages"))
        assertEquals("one", disk.read("Notes/Pages/a.md"))
        assertEquals(listOf("a.md"), listedNames("Pages"))
    }

    @Test fun refusesANameThatIsTaken() {
        file("pages/B.md", "two")
        file("a/c.md", "x")
        assertEquals("InvalidModificationError", refusal("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "pages/B.md"))
        assertEquals("InvalidModificationError", refusal("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "a"))
        assertEquals("InvalidModificationError", refusal("fs.move", "folder" to id, "from" to "a", "to" to "pages"))
        assertEquals("one", disk.read("Notes/pages/A.md"))
        assertEquals("two", disk.read("Notes/pages/B.md"))
        assertEquals("x", disk.read("Notes/a/c.md"))
    }

    @Test fun refusesWhatIsNotThereAPlaceThatIsNotAndADirectoryIntoItself() {
        assertEquals("NotFoundError", refusal("fs.move", "folder" to id, "from" to "nowhere.md", "to" to "x.md"))
        assertEquals("NotFoundError", refusal("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "nowhere/A.md"))
        assertEquals("InvalidModificationError", refusal("fs.move", "folder" to id, "from" to "pages", "to" to "pages/inside"))
        assertEquals("one", disk.read("Notes/pages/A.md"))
    }

    // What a page must not reach

    private val hostilePaths = listOf(
        "..", "../outside.md", "pages/../../outside.md", "pages/..", "./pages", "pages/.", "/etc/hosts", "//server/share",
        "pages//a.md", "pages/", "a\\b.md", "..\\outside.md", "C:\\outside.md", "a\u0000.md", "a\nb.md", "a\u001f", "/",
    )

    @Test fun everyCallRefusesAPathThatLeadsOut() {
        for (path in hostilePaths) for ((method, args) in callsWithPath(path)) assertEquals("$method $path", "SecurityError", world.port.call(method, args).name)
        assertEquals("not the app’s", disk.read("outside.md"))
        assertEquals(listOf("pages"), disk.names("Notes"))
    }

    /** Property: no call with a hostile path is answered. */
    @Test fun noCallWithAHostilePathIsAnswered() {
        val parts = listOf("..", ".", "", "\\", "..\\", "\u0000", "/", "a\u0007b", "pages", "A.md", "ü")
        val random = Random(20261125)
        var refused = 0
        while (refused < 60) {
            val path = List(random.nextInt(1, 7)) { parts.random(random) }.joinToString("/")
            if (path.isEmpty() || checkedRelativePath(path) != null) continue
            refused++
            for ((method, args) in callsWithPath(path)) assertFalse("$method answered $path", world.port.call(method, args).ok)
        }
        assertEquals("not the app’s", disk.read("outside.md"))
        assertEquals(listOf("Notes", "outside.md"), disk.names("").sorted())
    }

    @Test fun theChosenFolderItselfCannotBeWrittenMovedOrRemoved() {
        assertEquals("SecurityError", refusal("fs.remove", "folder" to id, "path" to ""))
        assertEquals("SecurityError", refusal("fs.move", "folder" to id, "from" to "", "to" to "x"))
        assertEquals("SecurityError", refusal("fs.move", "folder" to id, "from" to "pages", "to" to ""))
        assertEquals("SecurityError", refusedWrite("", "x"))
        assertEquals("one", disk.read("Notes/pages/A.md"))
    }

    @Test fun argumentsOfTheWrongKindAreRefused() {
        val wrong = listOf<Pair<String, Any?>>(
            "fs.read" to null, "fs.read" to emptyMap<String, Any?>(), "fs.read" to mapOf("folder" to id), "fs.read" to mapOf("folder" to id, "path" to 7),
            "fs.read" to mapOf("folder" to id, "path" to listOf("pages", "A.md")), "fs.readMany" to mapOf("folder" to id, "paths" to "pages/A.md"),
            "fs.write" to mapOf("folder" to id, "path" to "pages/A.md"), "fs.write" to mapOf("folder" to id, "path" to "pages/A.md", "bytes" to "text"),
            "fs.write" to mapOf("folder" to id, "path" to "pages/A.md", "bytes" to "x".toByteArray(), "ifStamp" to "present"),
            "fs.list" to mapOf("folder" to mapOf("id" to id), "path" to "", "stamps" to true), "fs.read" to "text", "fs.read" to listOf(id),
        )
        for ((method, args) in wrong) assertFalse("$method $args", world.port.call(method, args).ok)
        assertEquals("one", disk.read("Notes/pages/A.md"))
    }

    @Test fun aMethodThatIsNotInTheTableIsRefused() {
        for (method in listOf("fs.exec", "toString", "__proto__", "constructor", "", "hello")) assertEquals("NotSupportedError", refusal(method))
    }

    @Test fun aLinkInsideTheFolderDoesNotLeadOut() {
        disk.makeDirectory("Elsewhere")
        disk.write("Elsewhere/secret.md", "secret")
        assumeTrue(disk.link("Notes/way out", "Elsewhere"))
        disk.link("Notes/out.md", "outside.md")
        for (path in listOf("way out/secret.md", "out.md")) {
            assertNotEquals("nothing", refusal("fs.read", "folder" to id, "path" to path))
            assertNotEquals("nothing", refusedWrite(path, "changed"))
        }
        assertNotEquals("nothing", refusedWrite("way out/new.md", "x", "createDirectories" to true))
        assertNotEquals("nothing", refusal("fs.move", "folder" to id, "from" to "pages/A.md", "to" to "way out/A.md"))
        assertNotEquals("nothing", refusal("folders.child", "folder" to id, "path" to "way out"))
        assertEquals(listOf("pages/A.md"), walk("", emptyList(), 10)["files"])
        assertEquals("not the app’s", disk.read("outside.md"))
        assertEquals(listOf("secret.md"), disk.names("Elsewhere"))
    }

    // Watching

    private fun reported(path: String) = world.port.events.any { (name, detail) ->
        val paths = detail["paths"] as List<*>?
        name == "fsChanged" && detail["folder"] == id && (paths == null || paths.any { it == path || path.startsWith("$it/") || it == "" })
    }

    private fun until(ms: Long, met: () -> Boolean): Boolean {
        val end = System.nanoTime() + ms * 1_000_000
        while (!met() && System.nanoTime() < end) Thread.sleep(20)
        return met()
    }

    @Test fun reportsWhatAnotherProgramDoesAndStopsWhenAsked() {
        if (!world.watches) {
            assertEquals("NotSupportedError", refusal("fs.watch", "folder" to id))
            return
        }
        val watch = call("fs.watch", "folder" to id)
        file("pages/A.md", "changed")
        assertTrue(until(10_000) { reported("pages/A.md") })
        world.port.events.clear()
        file("new/deep/B.md", "x")
        assertTrue(until(10_000) { reported("new/deep/B.md") })
        world.port.events.clear()
        disk.remove("Notes/pages/A.md")
        assertTrue(until(10_000) { reported("pages/A.md") })
        call("fs.unwatch", "watch" to watch)
        Thread.sleep(500)
        world.port.events.clear()
        file("pages/C.md", "x")
        assertFalse(until(700) { world.port.events.isNotEmpty() })
    }

    /** A directory renamed under two watches is still heard by both, under its new name. */
    @Test fun twoWatchesHearADirectoryAfterItIsRenamed() {
        assumeTrue(world.watches)
        file("pages/old/A.md", "x")
        call("fs.watch", "folder" to id)
        call("fs.watch", "folder" to id)
        assumeTrue(disk.rename("Notes/pages/old", "Notes/pages/new"))
        assertTrue(until(10_000) { reported("pages/new") })
        Thread.sleep(300)
        world.port.events.clear()
        file("pages/new/B.md", "x")
        assertTrue(until(10_000) { reported("pages/new/B.md") })
    }

    @Test fun twoWatchesOfOneFolderEndApart() {
        assumeTrue(world.watches)
        val first = call("fs.watch", "folder" to id)
        call("fs.watch", "folder" to id)
        call("fs.unwatch", "watch" to first)
        file("pages/A.md", "changed")
        assertTrue(until(10_000) { reported("pages/A.md") })
    }

    // One file

    @Test fun aFileReadsAPartWritesAndIsLetGo() {
        file("One.md", "hello")
        val opened = world.openFile("Notes/One.md")
        assumeTrue(opened != null)
        val file = opened!!["id"] as String
        assertEquals("One.md", opened["name"])
        assertEquals(5L, opened["size"])
        assertFalse(file.contains("One"))
        val read = call("files.read", "file" to file) as Map<*, *>
        assertEquals("hello", String(read["bytes"] as ByteArray))
        fun part(offset: Int, length: Int) = String((call("files.readPart", "file" to file, "offset" to offset, "length" to length) as Map<*, *>)["bytes"] as ByteArray)
        assertEquals("ell", part(1, 3))
        assertEquals("o", part(4, 100))
        assertEquals("", part(100, 1))
        assertEquals("", part(0, 0))
        // A part that is not one of the file: refused, never read from the end or before the start.
        for ((offset, length) in listOf<Pair<Number, Number>>(-1 to 2, 0 to -1, 1.5 to 2, 0 to 2.5, 9.007199254740994E15 to 1)) {
            assertEquals("OperationError", refusal("files.readPart", "file" to file, "offset" to offset, "length" to length))
        }
        val stamp = stampOf(call("files.write", "file" to file, "bytes" to "hello again".toByteArray(), "ifStamp" to stampOf(read)))
        assertEquals("hello again", disk.read("Notes/One.md"))
        assertEquals(stamp, stampOf(call("files.read", "file" to file)))
        disk.write("Notes/One.md", "written elsewhere, and longer")
        assertEquals("NoModificationAllowedError", refusal("files.write", "file" to file, "bytes" to "x".toByteArray(), "ifStamp" to stamp))
        assertEquals("written elsewhere, and longer", disk.read("Notes/One.md"))
        call("files.release", "file" to file)
        assertEquals("NotAllowedError", refusal("files.read", "file" to file))
        assertEquals("NotAllowedError", refusal("files.read", "file" to "made-up"))
        assertEquals("NotAllowedError", refusal("files.read", "file" to id))
    }

    // Saving a copy

    @Test fun nothingIsOnDiskUntilCommitAndThePartsArriveInOrder() {
        disk.makeDirectory("Saved")
        assumeTrue(world.answerSave("Saved/copy.txt"))
        val opened = call("save.open", "name" to "copy.txt", "type" to "text/plain") as Map<*, *>
        assertEquals("copy.txt", opened["name"])
        val save = opened["save"]
        call("save.write", "save" to save, "bytes" to "one ".toByteArray())
        call("save.write", "save" to save, "bytes" to "two".toByteArray())
        assertTrue(disk.read("Saved/copy.txt").isNullOrEmpty())
        call("save.commit", "save" to save)
        assertEquals("one two", disk.read("Saved/copy.txt"))
        assertEquals("NotFoundError", refusal("save.write", "save" to save, "bytes" to "three".toByteArray()))
    }

    @Test fun abortLeavesWhatWasThereAndACancelIsAnAbort() {
        disk.write("Saved/copy.txt", "before")
        assumeTrue(world.answerSave("Saved/copy.txt"))
        val save = (call("save.open", "name" to "copy.txt", "type" to "text/plain") as Map<*, *>)["save"]
        call("save.write", "save" to save, "bytes" to "after".toByteArray())
        call("save.abort", "save" to save)
        assertEquals("before", disk.read("Saved/copy.txt"))
        assertEquals(listOf("copy.txt"), disk.names("Saved"))
        world.answerSave(null)
        assertEquals("AbortError", refusal("save.open", "name" to "copy.txt", "type" to "text/plain"))
    }
}
