package com.trustid.device.vault

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * eSFS on-disk format for Media Locker: chunked AES-256-GCM `.tidvault`.
 *
 * Layout (big-endian):
 *   magic "TIDV1" (5) | version u8 | chunkSize u32 | chunkCount u32 |
 *   wrappedCekLen u16 | wrappedCek (iv12||ct) |
 *   repeating: chunkIndex u32 | iv(12) | cipherLen u32 | ciphertext+tag
 *
 * Raw bytes are unreadable to gallery apps; content is app-private and pitch-black
 * without biometric unlock of the Keystore wrapping key.
 */
object TidVaultFormat {
  const val MAGIC = "TIDV1"
  const val VERSION: Byte = 1
  const val DEFAULT_CHUNK = 256 * 1024
  const val GCM_IV = 12
  const val GCM_TAG_BITS = 128
  const val EXT = "tidvault"

  fun encryptChunked(
    plain: ByteArray,
    wrappingCipher: Cipher,
    chunkSize: Int = DEFAULT_CHUNK,
  ): ByteArray {
    val cekBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val cek = SecretKeySpec(cekBytes, "AES")
    val wrapped = wrappingCipher.doFinal(cekBytes)
    val wrapIv = wrappingCipher.iv
    val wrappedEnvelope = ByteArray(wrapIv.size + wrapped.size).also {
      System.arraycopy(wrapIv, 0, it, 0, wrapIv.size)
      System.arraycopy(wrapped, 0, it, wrapIv.size, wrapped.size)
    }
    cekBytes.fill(0)

    val chunkCount = maxOf(1, (plain.size + chunkSize - 1) / chunkSize)
    val out = ByteArrayOutputStream()
    out.write(MAGIC.toByteArray(Charsets.US_ASCII))
    out.write(byteArrayOf(VERSION))
    out.write(u32(chunkSize))
    out.write(u32(chunkCount))
    out.write(u16(wrappedEnvelope.size))
    out.write(wrappedEnvelope)

    for (i in 0 until chunkCount) {
      val start = i * chunkSize
      val end = minOf(plain.size, start + chunkSize)
      val slice = plain.copyOfRange(start, end)
      val chunkCipher = Cipher.getInstance("AES/GCM/NoPadding")
      chunkCipher.init(Cipher.ENCRYPT_MODE, cek)
      val iv = chunkCipher.iv
      val ct = chunkCipher.doFinal(slice)
      slice.fill(0)
      out.write(u32(i))
      out.write(iv)
      out.write(u32(ct.size))
      out.write(ct)
    }
    return out.toByteArray()
  }

  fun decryptChunked(blob: ByteArray, unwrapCipher: Cipher): ByteArray {
    require(blob.size > 20) { "Corrupt tidvault" }
    val magic = blob.copyOfRange(0, 5).toString(Charsets.US_ASCII)
    require(magic == MAGIC) { "Not a tidvault file" }
    var offset = 5
    val version = blob[offset++]
    require(version == VERSION) { "Unsupported tidvault version" }
    /* chunkSize */ u32(blob, offset); offset += 4
    val chunkCount = u32(blob, offset); offset += 4
    val wrapLen = u16(blob, offset); offset += 2
    val wrapped = blob.copyOfRange(offset, offset + wrapLen); offset += wrapLen
    require(wrapped.size >= GCM_IV + 16) { "Corrupt wrapped CEK" }

    val cekBytes = unwrapCipher.doFinal(wrapped, GCM_IV, wrapped.size - GCM_IV)
    val cek = SecretKeySpec(cekBytes, "AES")
    cekBytes.fill(0)

    val parts = ArrayList<ByteArray>(chunkCount)
    for (n in 0 until chunkCount) {
      val index = u32(blob, offset); offset += 4
      val iv = blob.copyOfRange(offset, offset + GCM_IV); offset += GCM_IV
      val ctLen = u32(blob, offset); offset += 4
      val ct = blob.copyOfRange(offset, offset + ctLen); offset += ctLen
      val chunkCipher = Cipher.getInstance("AES/GCM/NoPadding")
      chunkCipher.init(Cipher.DECRYPT_MODE, cek, GCMParameterSpec(GCM_TAG_BITS, iv))
      parts.add(chunkCipher.doFinal(ct))
      require(index == n) { "Chunk order corrupt" }
    }

    val total = parts.sumOf { it.size }
    val plain = ByteArray(total)
    var p = 0
    for (part in parts) {
      System.arraycopy(part, 0, plain, p, part.size)
      p += part.size
      part.fill(0)
    }
    return plain
  }

  /** Extract wrap-IV from a tidvault blob for Keystore CryptoObject init. */
  fun peekWrapIv(blob: ByteArray): ByteArray {
    require(blob.size > 20 && blob.copyOfRange(0, 5).toString(Charsets.US_ASCII) == MAGIC)
    var offset = 5 + 1 + 4 + 4
    val wrapLen = u16(blob, offset); offset += 2
    require(wrapLen >= GCM_IV + 16)
    return blob.copyOfRange(offset, offset + GCM_IV)
  }

  private fun u32(v: Int): ByteArray =
    ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(v).array()

  private fun u16(v: Int): ByteArray =
    ByteBuffer.allocate(2).order(ByteOrder.BIG_ENDIAN).putShort(v.toShort()).array()

  private fun u32(buf: ByteArray, offset: Int): Int =
    ByteBuffer.wrap(buf, offset, 4).order(ByteOrder.BIG_ENDIAN).int

  private fun u16(buf: ByteArray, offset: Int): Int =
    ByteBuffer.wrap(buf, offset, 2).order(ByteOrder.BIG_ENDIAN).short.toInt() and 0xffff
}
