package com.flora.ota

import java.io.Closeable
import java.io.InputStream
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request

internal interface FloraResponse : Closeable {
  val status: Int
  val headers: Map<String, String>
  val contentLength: Long?
  val contentEncoding: String?
  val body: InputStream
}
internal fun interface FloraTransport { fun open(url: URI, headers: Map<String, String>, deadline: Long): FloraResponse }
internal class FloraHTTPS : FloraTransport {
  private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
    .retryOnConnectionFailure(false).connectTimeout(15, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build()
  override fun open(url: URI, headers: Map<String, String>, deadline: Long): FloraResponse {
    requireFlora(url.scheme == "https" && url.rawUserInfo == null && url.rawFragment == null, "NETWORK_FAILURE")
    FloraStore.checkDeadline(deadline)
    val request = Request.Builder().url(url.toString()).get().header("Accept-Encoding", "identity")
    headers.forEach { (name, value) -> request.header(name, value) }
    val call = client.newCall(request.build())
    // OkHttp's call timeout covers DNS, connect/TLS, headers and the entire streamed body.
    call.timeout().deadlineNanoTime(deadline)
    try {
      val response = call.execute()
      val status = response.code
      val responseHeaders = response.headers.toMultimap().entries.associate { it.key.lowercase() to it.value.joinToString(",") }
      val length = responseHeaders["content-length"]?.toLongOrNull()
      val stream = response.body?.byteStream() ?: java.io.ByteArrayInputStream(ByteArray(0))
      return object : FloraResponse {
        override val status = status
        override val headers = responseHeaders
        override val contentLength = length
        override val contentEncoding = responseHeaders["content-encoding"]
        override val body = stream
        override fun close() { response.close() }
      }
    } catch (error: Exception) { call.cancel(); throw FloraFailure(if (System.nanoTime() >= deadline) "NETWORK_TIMEOUT" else "NETWORK_FAILURE") }
  }
}

internal data class FloraRollback(val updateId: String, val reason: String)
/** The controller survives JS reloads. Only a new Android process starts a new boot attempt. */
internal class FloraEngine(val config: FloraConfig, private val store: FloraStore, private val transport: FloraTransport) {
  private var selected = false
  private var launch: String? = null
  private var checked: FloraManifest? = null
  private var downloaded: String? = null
  var rollback: FloraRollback? = null; private set

  @Synchronized fun bundleFile(): String? {
    if (selected) return launch?.let { store.bundle(it) }
    selected = true
    var state = try { store.state() } catch (error: Exception) { store.recoverCorruptState(); FloraState() }
    if (state.pending != null && state.launching) {
      rollback = FloraRollback(state.pending, "UNCONFIRMED_LAUNCH")
      state = state.copy(pending = null, launching = false, blocked = (state.blocked + state.pending).takeLast(128))
      store.save(state)
    }
    var candidate = state.pending ?: state.committed
    if (candidate != null) {
      try { store.verified(candidate) }
      catch (error: Exception) {
        rollback = FloraRollback(candidate, "STORED_UPDATE_INVALID")
        state = state.copy(committed = if (state.committed == candidate) null else state.committed, pending = null, launching = false, blocked = (state.blocked + candidate).takeLast(128))
        store.save(state); candidate = state.committed
        if (candidate != null) {
          try { store.verified(candidate) }
          catch (error: Exception) { state = state.copy(committed = null, blocked = (state.blocked + candidate).takeLast(128)); store.save(state); candidate = null }
        }
      }
    }
    if (candidate != null && state.pending == candidate) { state = state.copy(launching = true); store.save(state) }
    launch = candidate
    // Retain at most one fully verified download when the JS entry gate closed
    // before activation. It cannot become executable without check/download/reload.
    state.cached?.let { cached ->
      val valid = cached !in state.blocked && cached != state.committed && cached != state.pending &&
        try { store.verified(cached); true } catch (_: Exception) { false }
      if (!valid) { state = state.copy(cached = null); store.save(state) }
    }
    store.clean(setOfNotNull(state.committed, state.pending, state.cached))
    return candidate?.let { store.bundle(it) }
  }
  @Synchronized fun launchId(): String? { bundleFile(); return launch }
  @Synchronized fun assets(): Map<String, String> { bundleFile(); return launch?.let { store.assets(it) } ?: emptyMap() }
  @Synchronized fun check(): FloraManifest? {
    checked = null; downloaded = null; bundleFile()
    val deadline = System.nanoTime() + 30_000_000_000L
    val headers = mapOf("Accept" to "application/expo+json", "expo-protocol-version" to "1", "expo-platform" to "android", "expo-runtime-version" to config.runtimeVersion, "expo-channel-name" to config.channel, "expo-expect-signature" to "sig, keyid=\"${config.keyId}\", alg=\"rsa-v1_5-sha256\"")
    transport.open(config.url, headers, deadline).use { response ->
      FloraStore.checkDeadline(deadline)
      if (response.status == 204) return null
      requireFlora(response.status == 200, "NETWORK_FAILURE")
      requireFlora(response.headers["expo-protocol-version"] == "1" && response.headers["content-type"]?.substringBefore(';')?.trim() == "application/expo+json", "UPDATE_INVALID")
      requireFlora(response.contentEncoding == null || response.contentEncoding == "identity", "NETWORK_FAILURE")
      requireFlora(response.contentLength == null || response.contentLength in 1..FloraManifest.MAX_MANIFEST.toLong(), "RESPONSE_TOO_LARGE")
      val manifest = FloraManifest.verify(FloraStore.readBounded(response.body, FloraManifest.MAX_MANIFEST, deadline), response.headers["expo-signature"], config)
      if (manifest.id == launch || manifest.id in store.state().blocked) return null
      checked = manifest; return manifest
    }
  }
  @Synchronized fun download(): FloraManifest? {
    downloaded = null
    val manifest = checked ?: throw FloraFailure("UPDATE_NOT_CHECKED")
    var state = store.state()
    requireFlora(manifest.id !in state.blocked, "UPDATE_BLOCKED")
    if (state.cached != null && state.cached != manifest.id) { state = state.copy(cached = null); store.save(state) }
    store.clean(setOfNotNull(state.committed, state.pending, manifest.id))
    try {
      val deadline = System.nanoTime() + 180_000_000_000L
      store.stage(manifest, deadline) { asset -> transport.open(asset.url, mapOf("Accept" to asset.contentType), deadline) }
      store.save(store.state().copy(cached = manifest.id))
      downloaded = manifest.id; return manifest
    } catch (error: Exception) { checked = null; throw error }
  }
  @Synchronized fun prepareReload(expected: String): String {
    requireFlora(downloaded == expected, "UPDATE_NOT_DOWNLOADED")
    val state = store.state()
    requireFlora(state.pending == null && expected !in state.blocked, "UPDATE_BLOCKED")
    val bundle = store.bundle(expected)
    store.save(state.copy(pending = expected, launching = true, cached = null))
    launch = expected; selected = true; checked = null; downloaded = null
    return bundle
  }
  @Synchronized fun cancelReload(expected: String) {
    val state = store.state()
    if (state.pending == expected) { store.save(state.copy(pending = null, launching = false, cached = expected)); launch = state.committed }
  }
  @Synchronized fun markLaunchSuccessful(expected: String?) {
    bundleFile()
    requireFlora(expected == launch, "STALE_LAUNCH")
    val state = store.state()
    if (state.pending != null) {
      requireFlora(state.pending == expected && state.launching, "STALE_LAUNCH")
      store.verified(expected!!)
      store.save(state.copy(committed = expected, pending = null, launching = false, cached = null))
      store.clean(setOf(expected))
    }
  }
}
