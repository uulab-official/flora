package com.flora.ota

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.UUID

internal interface FloraFilesystem {
  fun sealDirectory(file: File)
  fun sealFile(file: File)
  fun verifyFile(file: File)
  fun syncDirectory(file: File)
}

internal data class FloraState(
  val committed: String? = null,
  val pending: String? = null,
  val launching: Boolean = false,
  val blocked: List<String> = emptyList(),
  // A complete package awaiting a NEW server check/download, never a launch pointer.
  val cached: String? = null,
)

/** All names are generated from a validated UUID or digest; manifest keys never become paths. */
internal class FloraStore(private val root: File, val config: FloraConfig, private val filesystem: FloraFilesystem) {
  init { directory(root); directory(File(root, "updates")) }
  private fun directory(file: File) {
    requireFlora((file.isDirectory || file.mkdirs()) && file.canonicalPath == file.absolutePath, "STORAGE_FAILURE")
    filesystem.sealDirectory(file)
  }
  private fun uuid(id: String) = id.matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}"))
  private fun updateDirectory(id: String): File { requireFlora(uuid(id)); return File(File(root, "updates"), id) }
  private fun limitedFile(file: File, limit: Int): ByteArray {
    requireFlora(file.isFile && file.canonicalPath == file.absolutePath && file.length() in 1..limit.toLong(), "STORED_UPDATE_INVALID")
    filesystem.verifyFile(file)
    FileInputStream(file).use { input -> return readBounded(input, limit) }
  }
  private fun writeFile(file: File, bytes: ByteArray) {
    requireFlora(!file.exists(), "STORAGE_FAILURE")
    FileOutputStream(file).use { output -> filesystem.sealFile(file); output.write(bytes); output.fd.sync() }
  }
  fun state(): FloraState {
    val file = File(root, "state.json")
    if (!file.exists()) return FloraState()
    try {
      val json = JSONObject(utf8(limitedFile(file, 32768)))
      requireFlora(json.getInt("version") == 1 && json.getString("scope") == config.scope, "STORED_UPDATE_INVALID")
      fun id(key: String): String? = if (json.isNull(key)) null else json.getString(key).also { requireFlora(uuid(it), "STORED_UPDATE_INVALID") }
      val array = json.getJSONArray("blocked")
      requireFlora(array.length() <= 128, "STORED_UPDATE_INVALID")
      val blocked = (0 until array.length()).map { array.getString(it).also { value -> requireFlora(uuid(value), "STORED_UPDATE_INVALID") } }
      val pending = id("pending"); val launching = json.getBoolean("launching")
      requireFlora(!launching || pending != null, "STORED_UPDATE_INVALID")
      // Older v1 states have no cache slot. Invalid optional cache metadata must
      // not discard valid committed/pending/blocked rollout state.
      val cached = json.optString("cached", "").takeIf { uuid(it) }
      return FloraState(id("committed"), pending, launching, blocked.distinct(), cached)
    } catch (error: Exception) { throw FloraFailure("STORED_UPDATE_INVALID") }
  }
  fun save(state: FloraState) {
    val json = JSONObject().put("version", 1).put("scope", config.scope)
      .put("committed", state.committed ?: JSONObject.NULL).put("pending", state.pending ?: JSONObject.NULL)
      .put("launching", state.launching).put("blocked", JSONArray(state.blocked.distinct().takeLast(128)))
      .put("cached", state.cached ?: JSONObject.NULL)
    val temporary = File(root, ".state-${UUID.randomUUID()}")
    try {
      writeFile(temporary, json.toString().toByteArray())
      requireFlora(temporary.renameTo(File(root, "state.json")), "STORAGE_FAILURE")
      filesystem.syncDirectory(root)
    } finally { temporary.delete() }
  }
  fun recoverCorruptState() { save(FloraState()) }
  fun verified(id: String): FloraManifest {
    try {
      val directory = updateDirectory(id)
      requireFlora(directory.isDirectory && directory.canonicalPath == directory.absolutePath, "STORED_UPDATE_INVALID")
      val manifest = FloraManifest.verify(limitedFile(File(directory, "manifest.json"), FloraManifest.MAX_MANIFEST), utf8(limitedFile(File(directory, "signature.txt"), 2048)), config)
      requireFlora(manifest.id == id, "STORED_UPDATE_INVALID")
      var total = 0L
      for (asset in manifest.files) {
        val file = File(directory, asset.digest + ".bin")
        requireFlora(file.isFile && file.canonicalPath == file.absolutePath && file.length() in 1..FloraManifest.MAX_FILE, "STORED_UPDATE_INVALID")
        filesystem.verifyFile(file)
        total += file.length(); requireFlora(total <= FloraManifest.MAX_TOTAL, "STORED_UPDATE_INVALID")
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
          val buffer = ByteArray(32768); var count = 0L
          while (true) { val read = input.read(buffer); if (read < 0) break; count += read; requireFlora(count <= FloraManifest.MAX_FILE, "STORED_UPDATE_INVALID"); digest.update(buffer, 0, read) }
          requireFlora(count > 0 && hex(digest.digest()) == asset.digest, "STORED_UPDATE_INVALID")
        }
      }
      return manifest
    } catch (error: Exception) { throw FloraFailure("STORED_UPDATE_INVALID") }
  }
  fun bundle(id: String): String { val manifest = verified(id); return File(updateDirectory(id), manifest.launch.digest + ".bin").absolutePath }
  fun assets(id: String): Map<String, String> = verified(id).assets.associate { it.key to ("file://" + File(updateDirectory(id), it.digest + ".bin").toURI().rawPath) }
  fun stage(manifest: FloraManifest, deadline: Long, open: (FloraAsset) -> FloraResponse) {
    val target = updateDirectory(manifest.id)
    if (target.exists()) {
      val stored = verified(manifest.id)
      requireFlora(MessageDigest.isEqual(stored.raw, manifest.raw), "UPDATE_INVALID")
      return
    }
    val temporary = File(File(root, "updates"), ".stage-${UUID.randomUUID()}" )
    directory(temporary)
    try {
      var total = 0L
      for (asset in manifest.files) {
        checkDeadline(deadline)
        val outputFile = File(temporary, asset.digest + ".bin")
        if (outputFile.exists()) { total += outputFile.length(); requireFlora(total <= FloraManifest.MAX_TOTAL, "ASSET_TOO_LARGE"); continue }
        open(asset).use { response ->
          checkDeadline(deadline)
          requireFlora(response.status == 200, "NETWORK_FAILURE")
          requireFlora(response.contentEncoding == null || response.contentEncoding == "identity", "NETWORK_FAILURE")
          requireFlora(response.contentLength == null || response.contentLength in 1..FloraManifest.MAX_FILE, "ASSET_TOO_LARGE")
          val digest = MessageDigest.getInstance("SHA-256")
          FileOutputStream(outputFile).use { output ->
            filesystem.sealFile(outputFile)
            val buffer = ByteArray(32768); var count = 0L
            while (true) {
              checkDeadline(deadline)
              val read = response.body.read(buffer); if (read < 0) break
              count += read; total += read
              requireFlora(count <= FloraManifest.MAX_FILE && total <= FloraManifest.MAX_TOTAL, "ASSET_TOO_LARGE")
              digest.update(buffer, 0, read); output.write(buffer, 0, read)
            }
            requireFlora(count > 0 && hex(digest.digest()) == asset.digest, "ASSET_HASH_MISMATCH")
            output.fd.sync()
          }
        }
      }
      writeFile(File(temporary, "manifest.json"), manifest.raw)
      writeFile(File(temporary, "signature.txt"), manifest.signature.toByteArray())
      filesystem.syncDirectory(temporary)
      requireFlora(temporary.renameTo(target), "STORAGE_FAILURE")
      filesystem.syncDirectory(File(root, "updates"))
      verified(manifest.id)
    } finally { remove(temporary) }
  }
  /** Keep only launch pointers and the current staged candidate, bounding disk growth across updates. */
  fun clean(keep: Set<String>) {
    File(root, "updates").listFiles()?.forEach { if (it.name !in keep) remove(it) }
    filesystem.syncDirectory(File(root, "updates"))
  }
  private fun remove(file: File) {
    if (!file.exists()) return
    if (file.isDirectory && file.canonicalPath == file.absolutePath) file.listFiles()?.forEach { remove(it) }
    requireFlora(file.delete(), "STORAGE_FAILURE")
  }
  companion object {
    fun checkDeadline(deadline: Long) { requireFlora(System.nanoTime() <= deadline, "NETWORK_TIMEOUT") }
    fun readBounded(input: InputStream, limit: Int, deadline: Long = Long.MAX_VALUE): ByteArray {
      val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(16384)
      while (true) { checkDeadline(deadline); val read = input.read(buffer); if (read < 0) break; requireFlora(output.size() + read <= limit, "RESPONSE_TOO_LARGE"); output.write(buffer, 0, read) }
      return output.toByteArray()
    }
  }
}
