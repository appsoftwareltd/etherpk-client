package com.etherpk.app.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.etherpk.app.folders.replaceFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** The refresh token in a private file, encrypted by a key that never leaves the Android Keystore. */
class KeystoreTokenStore(private val file: File, private val issuer: String, private val log: (String, Throwable) -> Unit) : TokenStore {
    private fun key(): SecretKey {
        val store = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (store.getKey(ALIAS, null) as SecretKey?)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    override fun load(): String? {
        if (!file.exists()) return null
        return try {
            val sealed = file.readBytes()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
            val kept = JSONObject(String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8))
            kept.getString("refreshToken").takeIf { kept.getString("issuer") == issuer }
        } catch (error: Exception) {
            // Another device's copy, or a key that is gone. The person signs in again.
            log("The kept sign-in could not be opened.", error)
            null
        }
    }

    override fun save(refreshToken: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        check(cipher.iv.size == IV_BYTES)
        val text = JSONObject().put("issuer", issuer).put("refreshToken", refreshToken).toString()
        replaceFile(file, cipher.iv + cipher.doFinal(text.toByteArray()))
    }

    override fun clear() { file.delete() }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val ALIAS = "etherpk-sign-in"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
        const val IV_BYTES = 12
    }
}
