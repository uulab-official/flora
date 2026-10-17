package com.flora.ota

import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.interfaces.RSAPublicKey

internal class FloraFailure(val code: String) : Exception(code)
internal fun requireFlora(condition: Boolean, code: String = "UPDATE_INVALID") {
  if (!condition) throw FloraFailure(code)
}
internal fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
internal fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
internal fun utf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
  .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
  .decode(ByteBuffer.wrap(bytes)).toString()

/** A portable codec keeps the Android 24 minimum without depending on java.util.Base64 (API 26). */
internal object FloraBase64 {
  private const val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  fun encode(bytes: ByteArray): String = buildString {
    var at = 0
    while (at < bytes.size) {
      val a = bytes[at++].toInt() and 255
      val b = if (at < bytes.size) bytes[at++].toInt() and 255 else -1
      val c = if (at < bytes.size) bytes[at++].toInt() and 255 else -1
      append(alphabet[a ushr 2]); append(alphabet[((a and 3) shl 4) or (if (b < 0) 0 else b ushr 4)])
      append(if (b < 0) '=' else alphabet[((b and 15) shl 2) or (if (c < 0) 0 else c ushr 6)])
      append(if (c < 0) '=' else alphabet[c and 63])
    }
  }
  fun decode(value: String): ByteArray {
    requireFlora(value.length <= 4096 && value.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")), "SIGNATURE_INVALID")
    val output = java.io.ByteArrayOutputStream()
    var bits = 0; var count = 0
    for (char in value) {
      if (char == '=') break
      bits = (bits shl 6) or alphabet.indexOf(char); count += 6
      if (count >= 8) { count -= 8; output.write((bits ushr count) and 255) }
    }
    val bytes = output.toByteArray()
    requireFlora(encode(bytes) == value, "SIGNATURE_INVALID")
    return bytes
  }
  fun hash(value: String): ByteArray {
    requireFlora(value.matches(Regex("[A-Za-z0-9_-]{43}")))
    val bytes = decode(value.replace('-', '+').replace('_', '/') + "=")
    requireFlora(bytes.size == 32)
    return bytes
  }
  fun url(bytes: ByteArray): String = encode(bytes).trimEnd('=').replace('+', '-').replace('/', '_')
}

internal data class FloraConfig(
  val appId: String, val url: URI, val channel: String, val runtimeVersion: String,
  val certificate: String, val keyId: String, val publicKey: RSAPublicKey,
) {
  val scope: String = hex(sha256("$appId\n$url\n$channel\n$runtimeVersion\n$certificate\n$keyId".toByteArray()))
  val origin: String = "https://${url.rawAuthority}"
  companion object {
    fun parse(bytes: ByteArray): FloraConfig {
      try {
        requireFlora(bytes.size in 1..131072, "CONFIGURATION_INVALID")
        val json = JSONObject(utf8(bytes))
        val app = json.getString("appId"); val channel = json.getString("channel")
        val runtime = json.getString("runtimeVersion"); val keyId = json.getString("keyId")
        val certificate = json.getString("certificate"); val rawUrl = json.getString("url")
        requireFlora(app.matches(Regex("[a-z][a-z0-9_-]{2,95}")) && channel.matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")), "CONFIGURATION_INVALID")
        requireFlora(runtime.length in 1..128 && !runtime.any { it.code <= 31 || it.code == 127 }, "CONFIGURATION_INVALID")
        requireFlora(keyId.matches(Regex("[A-Za-z0-9._-]{1,128}")) && certificate.length in 1..65536 && rawUrl.length <= 2048, "CONFIGURATION_INVALID")
        val url = URI(rawUrl)
        requireFlora(url.scheme == "https" && url.host != null && url.rawUserInfo == null && url.rawFragment == null && url.rawPath == "/updates/$app", "CONFIGURATION_INVALID")
        requireFlora(url.rawQuery == null || url.rawQuery == "channel=$channel", "CONFIGURATION_INVALID")
        val parsed = CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(certificate.toByteArray(Charsets.US_ASCII)))
        val key = parsed.publicKey as? RSAPublicKey ?: throw FloraFailure("CONFIGURATION_INVALID")
        requireFlora(key.modulus.bitLength() >= 2048 && key.modulus.bitLength() <= 8192, "CONFIGURATION_INVALID")
        return FloraConfig(app, url, channel, runtime, certificate, keyId, key)
      } catch (error: Exception) { throw FloraFailure("CONFIGURATION_INVALID") }
    }
  }
}

internal data class FloraAsset(val key: String, val hash: String, val digest: String, val url: URI, val contentType: String)
internal data class FloraManifest(val id: String, val launch: FloraAsset, val assets: List<FloraAsset>, val raw: ByteArray, val signature: String) {
  val files: List<FloraAsset> get() = listOf(launch) + assets
  companion object {
    const val MAX_MANIFEST = 262144
    const val MAX_FILE = 16777216L
    const val MAX_TOTAL = 67108864L
    const val MAX_ASSETS = 64
    fun verify(raw: ByteArray, header: String?, config: FloraConfig): FloraManifest {
      try {
        requireFlora(raw.size in 1..MAX_MANIFEST)
        requireFlora(header != null && header.length <= 2048, "SIGNATURE_INVALID")
        val signature = header!!
        val entries = signature.split(',').map { it.trim() }
        requireFlora(entries.size == 3 && entries.toSet().size == 3, "SIGNATURE_INVALID")
        val pairs = entries.map {
          val match = Regex("(sig|keyid|alg)=\"([A-Za-z0-9+/=._-]+)\"").matchEntire(it) ?: throw FloraFailure("SIGNATURE_INVALID")
          match.groupValues[1] to match.groupValues[2]
        }
        requireFlora(pairs.map { it.first }.toSet().size == 3, "SIGNATURE_INVALID")
        val values = pairs.toMap()
        requireFlora(values["keyid"] == config.keyId && values["alg"] == "rsa-v1_5-sha256", "SIGNATURE_INVALID")
        val signedBytes = FloraBase64.decode(values["sig"] ?: "")
        requireFlora(signedBytes.size == (config.publicKey.modulus.bitLength() + 7) / 8, "SIGNATURE_INVALID")
        val verifier = Signature.getInstance("SHA256withRSA")
        verifier.initVerify(config.publicKey); verifier.update(raw)
        requireFlora(verifier.verify(signedBytes), "SIGNATURE_INVALID")
        val json = JSONObject(utf8(raw))
        val id = json.getString("id")
        requireFlora(id.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")))
        requireFlora(json.getString("runtimeVersion") == config.runtimeVersion, "UPDATE_INCOMPATIBLE")
        val metadata = json.getJSONObject("metadata")
        requireFlora(metadata.getString("appid") == config.appId && metadata.getString("channel") == config.channel, "UPDATE_INCOMPATIBLE")
        val flora = json.getJSONObject("extra").getJSONObject("flora")
        requireFlora(flora.getString("appId") == config.appId && flora.getString("platform") == "android", "UPDATE_INCOMPATIBLE")
        fun asset(value: JSONObject, launch: Boolean): FloraAsset {
          val hash = value.getString("hash"); val digest = hex(FloraBase64.hash(hash))
          val key = value.getString("key"); val contentType = value.getString("contentType")
          requireFlora(key.length in 1..128 && key.matches(Regex("[A-Za-z0-9_-]+")))
          requireFlora(contentType.matches(Regex("(?:application/(?:javascript|octet-stream|json|wasm|x-font-ttf|vnd\\.ms-fontobject)|text/javascript|image/(?:png|jpeg|gif|webp|avif)|font/(?:ttf|otf|woff|woff2)|audio/(?:mpeg|mp4|wav|ogg)|video/mp4)")))
          if (launch) requireFlora(contentType in listOf("application/javascript", "text/javascript", "application/octet-stream"))
          else requireFlora(value.getString("fileExtension").matches(Regex("\\.[A-Za-z0-9]{1,15}")))
          val url = URI(value.getString("url"))
          requireFlora(url.toString() == "${config.origin}/updates/${config.appId}/assets/$digest", "UPDATE_INCOMPATIBLE")
          return FloraAsset(key, hash, digest, url, contentType)
        }
        val launch = asset(json.getJSONObject("launchAsset"), true)
        val array = json.getJSONArray("assets")
        requireFlora(array.length() <= MAX_ASSETS)
        val assets = (0 until array.length()).map { asset(array.getJSONObject(it), false) }
        requireFlora((listOf(launch) + assets).map { it.key }.toSet().size == assets.size + 1)
        return FloraManifest(id, launch, assets, raw, signature)
      } catch (error: FloraFailure) { throw error }
      catch (error: Exception) { throw FloraFailure("UPDATE_INVALID") }
    }
  }
}
