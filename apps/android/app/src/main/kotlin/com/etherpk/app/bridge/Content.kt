package com.etherpk.app.bridge

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

/** Bytes crossing the bridge, which may be too many to hold in memory. */
interface Content {
    val size: Long
    fun open(): InputStream
    /** Lets go of what is behind the bytes. They cannot be read after. */
    fun release() {}
}

class BytesContent(private val bytes: ByteArray, private val offset: Int = 0, length: Int = bytes.size - offset) : Content {
    private val length = length
    override val size get() = length.toLong()
    override fun open(): InputStream = ByteArrayInputStream(bytes, offset, length)
}

/** Bytes the page sent in parts, gathered in a private file that goes with them. */
class UploadContent(private val file: File) : Content {
    override val size = file.length()
    override fun open(): InputStream = file.inputStream()
    override fun release() { file.delete() }
}

/** A stream opened already, so what is read is the file its stamp was read from. Read once. */
class OpenContent(private val stream: InputStream, override val size: Long) : Content {
    override fun open(): InputStream = stream
    override fun release() = stream.close()
}

fun Content.bytes(): ByteArray = open().use { it.readBytes() }
