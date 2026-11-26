package com.etherpk.app.folders

import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

/** A folder the person chose: the tree the system granted, and the way down from it for a folder inside one. */
data class FolderGrant(val id: String, val tree: String, val path: List<String>, val name: String)

/** The chosen folders, kept between starts. An id is random and says nothing about where its folder is. */
class FolderRegistry(private val file: File, private val log: (String, Throwable) -> Unit = { _, _ -> }) {
    private val grants = LinkedHashMap<String, FolderGrant>()

    init {
        // A file that cannot be read is moved aside rather than written over: it may be put right by hand.
        // The app starts without its folders, and the page asks for each again.
        try {
            if (file.exists()) read(file.readText())
        } catch (error: org.json.JSONException) {
            log("The list of folders could not be read, and is kept beside it.", error)
            grants.clear()
            file.renameTo(File(file.path + ".unreadable"))
        } catch (error: java.io.IOException) {
            log("The list of folders could not be read, and is kept beside it.", error)
            grants.clear()
            file.renameTo(File(file.path + ".unreadable"))
        }
    }

    private fun read(text: String) {
        val all = JSONArray(text)
        for (index in 0 until all.length()) {
            val one = all.getJSONObject(index)
            val path = one.getJSONArray("path").let { parts -> List(parts.length()) { parts.getString(it) } }
            val grant = FolderGrant(one.getString("id"), one.getString("tree"), path, one.getString("name"))
            grants[grant.id] = grant
        }
    }

    @Synchronized fun get(id: String): FolderGrant? = grants[id]

    /** A folder chosen again keeps the id it has, so the app does not count it twice. */
    @Synchronized fun grant(tree: String, path: List<String>, name: String): FolderGrant {
        grants.values.firstOrNull { it.tree == tree && it.path == path }?.let { return it }
        val grant = FolderGrant(UUID.randomUUID().toString(), tree, path, name)
        grants[grant.id] = grant
        save()
        return grant
    }

    /** Forgets a folder, and answers its tree when no other folder is reached through it. */
    @Synchronized fun forget(id: String): String? {
        val grant = grants.remove(id) ?: return null
        save()
        return grant.tree.takeIf { tree -> grants.values.none { it.tree == tree } }
    }

    private fun save() {
        val all = JSONArray()
        grants.values.forEach { all.put(JSONObject().put("id", it.id).put("tree", it.tree).put("path", JSONArray(it.path)).put("name", it.name)) }
        replaceFile(file, all.toString().toByteArray())
    }
}

/** Puts [bytes] in [file] so that a stop part way leaves the old content or the new. */
fun replaceFile(file: File, bytes: ByteArray) {
    val partial = File(file.path + ".partial")
    FileOutputStream(partial).use {
        it.write(bytes)
        it.fd.sync()
    }
    if (!partial.renameTo(file)) throw java.io.IOException("${file.name} could not be replaced.")
}
