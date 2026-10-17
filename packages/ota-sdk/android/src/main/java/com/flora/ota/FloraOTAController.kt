package com.flora.ota

import android.content.Context
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.concurrent.Executors

/** Call bundleFile while constructing the standard React Native 0.86 ReactHost. */
public object FloraOTAController {
  private var controller: FloraEngine? = null
  internal val executor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "FloraOTA").apply { isDaemon = true } }

  @JvmStatic public fun bundleFile(context: Context): String? = try { get(context).bundleFile() } catch (error: Exception) { null }

  @Synchronized internal fun get(context: Context): FloraEngine {
    controller?.let { return it }
    val application = context.applicationContext
    val bytes = application.assets.open("flora_ota_config.json").use { FloraStore.readBounded(it, 131072) }
    val config = FloraConfig.parse(bytes)
    val base = File(application.noBackupFilesDir.canonicalFile, "flora-ota")
    requireFlora(base.isDirectory || base.mkdir(), "STORAGE_FAILURE")
    requireFlora(base.canonicalPath == base.absolutePath, "STORAGE_FAILURE")
    Os.chmod(base.absolutePath, 448) // 0700
    val filesystem = object : FloraFilesystem {
      override fun sealDirectory(file: File) { Os.chmod(file.absolutePath, 448) }
      override fun sealFile(file: File) { Os.chmod(file.absolutePath, 384) } // 0600
      override fun verifyFile(file: File) {
        val stat = Os.lstat(file.absolutePath)
        requireFlora(OsConstants.S_ISREG(stat.st_mode) && stat.st_nlink == 1L && stat.st_uid == android.os.Process.myUid(), "STORED_UPDATE_INVALID")
        requireFlora((stat.st_mode and 63) == 0, "STORED_UPDATE_INVALID") // No group/other permissions.
      }
      override fun syncDirectory(file: File) {
        val descriptor = Os.open(file.absolutePath, OsConstants.O_RDONLY, 0)
        try { requireFlora(OsConstants.S_ISDIR(Os.fstat(descriptor).st_mode), "STORAGE_FAILURE"); Os.fsync(descriptor) } finally { Os.close(descriptor) }
      }
    }
    val scope = File(base, config.scope)
    val store = FloraStore(scope, config, filesystem)
    scope.setLastModified(System.currentTimeMillis())
    // Retain one former native runtime for binary rollback; remove only our generated cache namespaces.
    val retired = base.listFiles()?.filter { it.name != config.scope && it.name.matches(Regex("[a-f0-9]{64}")) }
      ?.sortedByDescending { it.lastModified() } ?: emptyList()
    retired.drop(1).forEach { deleteOwnedCache(it) }
    filesystem.syncDirectory(base)
    val engine = FloraEngine(config, store, FloraHTTPS())
    controller = engine; return engine
  }

  private fun deleteOwnedCache(file: File) {
    if (file.isDirectory && file.canonicalPath == file.absolutePath) file.listFiles()?.forEach { deleteOwnedCache(it) }
    requireFlora(file.delete(), "STORAGE_FAILURE")
  }
}
