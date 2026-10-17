package com.flora.ota

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.net.URI
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec

class FloraEngineTest {
  private lateinit var root: File
  private lateinit var config: FloraConfig
  private lateinit var privateKey: java.security.PrivateKey
  private val id2 = "11111111-1111-4111-8111-111111111111"
  private val id3 = "22222222-2222-4222-8222-222222222222"
  private val bundle = "globalThis.floraVersion='v2';".toByteArray()
  private val image = byteArrayOf(1, 2, 3, 4, 5)
  private lateinit var transport: FakeTransport
  private val filesystem = object : FloraFilesystem {
    override fun sealDirectory(file: File) { file.setReadable(false, false); file.setWritable(false, false); file.setExecutable(false, false); file.setReadable(true, true); file.setWritable(true, true); file.setExecutable(true, true) }
    override fun sealFile(file: File) { file.setReadable(false, false); file.setWritable(false, false); file.setExecutable(false, false); file.setReadable(true, true); file.setWritable(true, true) }
    override fun verifyFile(file: File) { requireFlora(!Files.isSymbolicLink(file.toPath()) && (Files.getAttribute(file.toPath(), "unix:nlink") as Number).toLong() == 1L, "STORED_UPDATE_INVALID") }
    override fun syncDirectory(file: File) { FileChannel.open(file.toPath(), StandardOpenOption.READ).use { it.force(true) } }
  }
  @Before fun setup() {
    root = Files.createTempDirectory("flora-android-engine-").toFile().canonicalFile
    val certificate = File(System.getProperty("flora.test.certificate")).readText()
    config = FloraConfig.parse(JSONObject().put("appId", "app_one").put("url", "https://example.test/updates/app_one")
      .put("channel", "production").put("runtimeVersion", "native-v1").put("certificate", certificate).put("keyId", "unit-test").toString().toByteArray())
    val pem = File(System.getProperty("flora.test.privateKey")).readText().replace(Regex("-----[^-]+-----"), "").replace(Regex("\\s"), "")
    privateKey = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(FloraBase64.decode(pem)))
    transport = FakeTransport()
    transport.assets[hex(sha256(bundle))] = bundle; transport.assets[hex(sha256(image))] = image
    transport.manifest = signed(manifest(id2))
  }
  @After fun cleanup() { root.deleteRecursively() }
  private fun asset(key: String, bytes: ByteArray, launch: Boolean) = JSONObject().put("key", key).put("hash", FloraBase64.url(sha256(bytes)))
    .put("contentType", if (launch) "application/javascript" else "image/png").put("url", "${config.origin}/updates/${config.appId}/assets/${hex(sha256(bytes))}")
    .apply { if (!launch) put("fileExtension", ".png") }
  private fun manifest(id: String): JSONObject = JSONObject().put("id", id).put("runtimeVersion", config.runtimeVersion)
    .put("launchAsset", asset("launch", bundle, true)).put("assets", JSONArray().put(asset("image", image, false)))
    .put("metadata", JSONObject().put("appid", config.appId).put("channel", config.channel))
    .put("extra", JSONObject().put("flora", JSONObject().put("appId", config.appId).put("platform", "android")))
  private fun signed(json: JSONObject): Pair<ByteArray, String> {
    val raw = json.toString().toByteArray(); val signer = Signature.getInstance("SHA256withRSA"); signer.initSign(privateKey); signer.update(raw)
    return raw to "sig=\"${FloraBase64.encode(signer.sign())}\", keyid=\"unit-test\", alg=\"rsa-v1_5-sha256\""
  }
  private fun engine(): FloraEngine = FloraEngine(config, FloraStore(root, config, filesystem), transport)
  private fun rejects(code: String, work: () -> Unit) { try { work(); fail("Expected $code") } catch (error: FloraFailure) { assertEquals(code, error.code) } }
  private fun download(engine: FloraEngine, id: String = id2) { assertEquals(id, engine.check()!!.id); assertEquals(id, engine.download()!!.id) }

  private fun assetManifest(count: Int): JSONObject = manifest(id2).put("assets", JSONArray().apply {
    repeat(count) { index ->
      val bytes = "flora-asset-$index".toByteArray()
      transport.assets[hex(sha256(bytes))] = bytes
      put(asset("asset_$index", bytes, false))
    }
  })

  @Test fun fortySixRealAppAssetsDownloadApplyRestartAndRemainHashVerified() {
    transport.manifest = signed(assetManifest(46))
    val running = engine()
    assertNull(running.bundleFile()); download(running); running.prepareReload(id2)
    assertEquals(46, running.assets().size); running.markLaunchSuccessful(id2)
    val restarted = engine()
    assertNotNull(restarted.bundleFile()); assertEquals(46, restarted.assets().size)
    val last = File(URI(restarted.assets()["asset_45"]!!))
    assertArrayEquals("flora-asset-45".toByteArray(), last.readBytes())
    last.writeText("tampered after activation")
    val damaged = engine()
    assertNull(damaged.bundleFile()); assertEquals("STORED_UPDATE_INVALID", damaged.rollback!!.reason)
  }

  @Test fun assetCountBoundaryAdmitsSixtyFourAndRejectsSixtyFive() {
    val accepted = signed(assetManifest(64))
    assertEquals(64, FloraManifest.verify(accepted.first, accepted.second, config).assets.size)
    val rejected = signed(assetManifest(65))
    rejects("UPDATE_INVALID") { FloraManifest.verify(rejected.first, rejected.second, config) }
  }

  @Test fun manyAssetManifestStillRejectsForeignAppBindingAndSignedHashTamper() {
    val foreign = assetManifest(46).put("metadata", JSONObject().put("appid", "app_two").put("channel", config.channel))
    val foreignSigned = signed(foreign)
    rejects("UPDATE_INCOMPATIBLE") { FloraManifest.verify(foreignSigned.first, foreignSigned.second, config) }
    transport.manifest = signed(assetManifest(46))
    val running = engine(); running.check()
    transport.assets[hex(sha256("flora-asset-45".toByteArray()))] = "download changed".toByteArray()
    rejects("ASSET_HASH_MISMATCH") { running.download() }
    assertNull(engine().bundleFile())
  }

  @Test fun signatureIsRequiredAndCoversExactBytes() {
    val (raw, signature) = transport.manifest!!
    rejects("SIGNATURE_INVALID") { FloraManifest.verify(raw, null, config) }
    rejects("SIGNATURE_INVALID") { FloraManifest.verify(raw + byteArrayOf(32), signature, config) }
    rejects("SIGNATURE_INVALID") { FloraManifest.verify(raw, signature.replace("unit-test", "other-key"), config) }
    rejects("SIGNATURE_INVALID") { FloraManifest.verify(raw, signature + ", alg=\"rsa-v1_5-sha256\"", config) }
    assertEquals(id2, FloraManifest.verify(raw, signature, config).id)
  }
  @Test fun signedManifestStillMustMatchAppRuntimeChannelPlatformAndAssetOrigin() {
    val mutations: List<(JSONObject) -> Unit> = listOf(
      { it.getJSONObject("metadata").put("appid", "app_two") },
      { it.put("runtimeVersion", "native-v2") },
      { it.getJSONObject("metadata").put("channel", "preview") },
      { it.getJSONObject("extra").getJSONObject("flora").put("platform", "ios") },
      { it.getJSONObject("extra").getJSONObject("flora").put("appId", "app_two") },
      { it.getJSONObject("launchAsset").put("url", "https://other.test/updates/app_one/assets/${hex(sha256(bundle))}") },
      { it.getJSONObject("launchAsset").put("url", "${config.origin}/updates/app_two/assets/${hex(sha256(bundle))}") },
    )
    mutations.forEach { change -> val json = manifest(id2); change(json); val (raw, signature) = signed(json); rejects("UPDATE_INCOMPATIBLE") { FloraManifest.verify(raw, signature, config) } }
  }
  @Test fun downloadDoesNotActivateAndReloadCommitsOnlyExactLaunch() {
    val engine = engine(); assertNull(engine.bundleFile()); download(engine)
    assertNull(engine.launchId()); assertNull(FloraStore(root, config, filesystem).state().pending)
    val path = engine.prepareReload(id2); assertEquals(String(bundle), File(path).readText())
    rejects("STALE_LAUNCH") { engine.markLaunchSuccessful(null) }
    rejects("STALE_LAUNCH") { engine.markLaunchSuccessful(id3) }
    engine.markLaunchSuccessful(id2)
    assertEquals(id2, FloraStore(root, config, filesystem).state().committed)
    val restarted = engine(); assertEquals(path, restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    assertTrue(restarted.assets()["image"]!!.startsWith("file:///"))
  }
  @Test fun completeDownloadedCandidateSurvivesColdBootWithoutActivationOrAssetRequests() {
    // A real app may complete its native download after the JS entry gate closes.
    // The next process must reuse all 57 verified files through a fresh SDK check.
    transport.manifest = signed(assetManifest(56))
    val productData = File(root, "product-data.json").apply { writeText("preserved") }
    val first = engine(); assertNull(first.bundleFile()); download(first)
    assertEquals(57, transport.assetRequests)
    assertNull(FloraStore(root, config, filesystem).state().pending)
    val restarted = engine(); assertNull(restarted.bundleFile()); assertNull(restarted.launchId())
    restarted.markLaunchSuccessful(null)
    rejects("UPDATE_NOT_DOWNLOADED") { restarted.prepareReload(id2) }
    rejects("UPDATE_NOT_CHECKED") { restarted.download() }
    transport.allowAssets = false
    download(restarted)
    assertEquals(57, transport.assetRequests)
    val selected = restarted.prepareReload(id2)
    assertArrayEquals(bundle, File(selected).readBytes()); assertEquals(selected, restarted.bundleFile())
    assertEquals(56, restarted.assets().size)
    rejects("STALE_LAUNCH") { restarted.markLaunchSuccessful(null) }
    restarted.markLaunchSuccessful(id2)
    assertEquals(id2, FloraStore(root, config, filesystem).state().committed)
    assertEquals(selected, engine().bundleFile()); assertEquals("preserved", productData.readText())
  }
  @Test fun cacheRetainsOnlyNewestCandidateAndConfirmedFallbackAcrossColdBoot() {
    val first = engine(); download(first); first.prepareReload(id2); first.markLaunchSuccessful(id2)
    transport.manifest = signed(manifest(id3)); download(first, id3)
    val newest = "33333333-3333-4333-8333-333333333333"
    transport.manifest = signed(manifest(newest)); download(first, newest)
    assertEquals(setOf(id2, newest), File(root, "updates").listFiles()!!.map { it.name }.toSet())
    val restarted = engine(); assertNotNull(restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    val requests = transport.assetRequests; transport.allowAssets = false; download(restarted, newest)
    assertEquals(requests, transport.assetRequests)
    restarted.prepareReload(newest); restarted.markLaunchSuccessful(newest)
    assertEquals(setOf(newest), File(root, "updates").listFiles()!!.map { it.name }.toSet())
  }
  @Test fun invalidCachedAssetIsDiscardedWithoutBlockingOrReplacingConfirmedLaunch() {
    val first = engine(); download(first); first.prepareReload(id2); first.markLaunchSuccessful(id2)
    transport.manifest = signed(manifest(id3)); download(first, id3)
    File(root, "updates/$id3/${hex(sha256(image))}.bin").writeText("tampered cached asset")
    val restarted = engine(); assertNotNull(restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    assertFalse(File(root, "updates/$id3").exists())
    val state = FloraStore(root, config, filesystem).state()
    assertEquals(id2, state.committed); assertNull(state.pending); assertTrue(state.blocked.isEmpty())
    val requests = transport.assetRequests; download(restarted, id3); assertEquals(requests + 2, transport.assetRequests)
  }
  @Test fun cachedManifestSignatureIsVerifiedBeforeRetention() {
    val first = engine(); download(first)
    val signature = File(root, "updates/$id2/signature.txt")
    signature.writeText(signature.readText().replace("unit-test", "other-key"))
    assertNull(engine().bundleFile()); assertFalse(File(root, "updates/$id2").exists())
    assertTrue(FloraStore(root, config, filesystem).state().blocked.isEmpty())
  }
  @Test fun cachedDirectorySymlinkIsRemovedWithoutFollowingOrExecutingItsTarget() {
    val first = engine(); download(first)
    val cached = File(root, "updates/$id2"); val target = File(root, "outside-updates")
    Files.move(cached.toPath(), target.toPath()); Files.createSymbolicLink(cached.toPath(), target.toPath())
    val restarted = engine(); assertNull(restarted.bundleFile()); assertNull(restarted.launchId())
    assertFalse(Files.exists(cached.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
    assertArrayEquals(bundle, File(target, hex(sha256(bundle)) + ".bin").readBytes())
  }
  @Test fun legacyStateWithoutCacheSlotPreservesConfirmedLaunchAndStoresANewCandidate() {
    val first = engine(); download(first); first.prepareReload(id2); first.markLaunchSuccessful(id2)
    val pointer = File(root, "state.json"); val legacy = JSONObject(pointer.readText()).apply { remove("cached") }
    pointer.writeText(legacy.toString())
    val restarted = engine(); assertNotNull(restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    transport.manifest = signed(manifest(id3)); download(restarted, id3)
    val next = engine(); assertNotNull(next.bundleFile()); assertEquals(id2, next.launchId())
    val requests = transport.assetRequests; transport.allowAssets = false; download(next, id3)
    assertEquals(requests, transport.assetRequests)
  }
  @Test fun malformedCacheReferenceDoesNotInvalidateConfirmedStateOrPreserveOrphanPackages() {
    val first = engine(); download(first); first.prepareReload(id2); first.markLaunchSuccessful(id2)
    transport.manifest = signed(manifest(id3)); download(first, id3)
    val pointer = File(root, "state.json"); val changed = JSONObject(pointer.readText()).put("cached", "../../untrusted")
    pointer.writeText(changed.toString())
    val restarted = engine(); assertNotNull(restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    assertFalse(File(root, "updates/$id3").exists()); assertTrue(FloraStore(root, config, filesystem).state().blocked.isEmpty())
  }
  @Test fun cancelledReloadRetainsCacheButRequiresFreshCheckAndDownloadBeforeAnotherActivation() {
    val first = engine(); download(first); first.prepareReload(id2); first.cancelReload(id2)
    assertNull(first.launchId()); assertNull(FloraStore(root, config, filesystem).state().pending)
    val restarted = engine(); assertNull(restarted.bundleFile())
    rejects("UPDATE_NOT_DOWNLOADED") { restarted.prepareReload(id2) }
    val requests = transport.assetRequests; transport.allowAssets = false; download(restarted)
    assertEquals(requests, transport.assetRequests)
    restarted.prepareReload(id2); restarted.markLaunchSuccessful(id2)
    assertEquals(id2, engine().launchId())
  }
  @Test fun coldBootRetainsOnlyRecordedVerifiedCandidateAndDeletesACompleteCrashOrphan() {
    val first = engine(); download(first)
    val orphan = signed(manifest(id3)); val store = FloraStore(root, config, filesystem)
    store.stage(FloraManifest.verify(orphan.first, orphan.second, config), System.nanoTime() + 30_000_000_000L) { asset ->
      transport.open(asset.url, mapOf("Accept" to asset.contentType), System.nanoTime() + 30_000_000_000L)
    }
    assertEquals(setOf(id2, id3), File(root, "updates").listFiles()!!.map { it.name }.toSet())
    val restarted = engine(); assertNull(restarted.bundleFile())
    assertEquals(setOf(id2), File(root, "updates").listFiles()!!.map { it.name }.toSet())
    val requests = transport.assetRequests; transport.allowAssets = false; download(restarted)
    assertEquals(requests, transport.assetRequests)
  }
  @Test fun unconfirmedLaunchRollsBackOnProcessRestartAndBlocksRetry() {
    val engine = engine(); download(engine); engine.prepareReload(id2)
    val restarted = engine(); assertNull(restarted.bundleFile()); assertNull(restarted.launchId())
    assertEquals(FloraRollback(id2, "UNCONFIRMED_LAUNCH"), restarted.rollback)
    assertNull(restarted.check()); assertTrue(FloraStore(root, config, filesystem).state().blocked.contains(id2))
    assertFalse(File(root, "updates/$id2").exists())
  }
  @Test fun laterUnconfirmedLaunchKeepsPreviouslyConfirmedBundle() {
    val engine = engine(); download(engine); engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    transport.manifest = signed(manifest(id3)); download(engine, id3); engine.prepareReload(id3)
    rejects("STALE_LAUNCH") { engine.markLaunchSuccessful(id2) }
    val restarted = engine(); assertNotNull(restarted.bundleFile()); assertEquals(id2, restarted.launchId())
    assertEquals(FloraRollback(id3, "UNCONFIRMED_LAUNCH"), restarted.rollback)
  }
  @Test fun tamperedDownloadNeverChangesLaunchState() {
    val engine = engine(); engine.check(); transport.assets[hex(sha256(bundle))] = "tampered".toByteArray()
    rejects("ASSET_HASH_MISMATCH") { engine.download() }
    assertNull(engine.launchId()); assertNull(FloraStore(root, config, filesystem).state().pending)
    assertEquals(0, File(root, "updates").listFiles()!!.size)
  }
  @Test fun storedTamperingIsCheckedBeforeRestart() {
    val engine = engine(); download(engine); val path = engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    File(path).writeText("corrupted bundle")
    val restarted = engine(); assertNull(restarted.bundleFile()); assertEquals(FloraRollback(id2, "STORED_UPDATE_INVALID"), restarted.rollback)
  }
  @Test fun hardLinkedStoredBundleIsRejected() {
    val engine = engine(); download(engine); val path = engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    Files.createLink(File(root, "bundle-hard-link").toPath(), File(path).toPath())
    assertNull(engine().bundleFile())
  }
  @Test fun storedManifestSignatureAndAncillaryAssetAreReverified() {
    val engine = engine(); download(engine); engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    val signature = File(root, "updates/$id2/signature.txt")
    signature.writeText(signature.readText().replace("unit-test", "other-key"))
    assertNull(engine().bundleFile())
  }
  @Test fun ancillaryAssetTamperingAlsoRollsBack() {
    val engine = engine(); download(engine); engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    File(root, "updates/$id2/${hex(sha256(image))}.bin").writeBytes(byteArrayOf(0))
    assertNull(engine().bundleFile())
  }
  @Test fun signedTotalAssetSizeCannotExceedQuotaEvenWhenDigestsAreRepeated() {
    val large = ByteArray(5 * 1024 * 1024) { 17 }
    transport.assets[hex(sha256(large))] = large
    val json = manifest(id2).put("assets", JSONArray().apply { repeat(13) { put(asset("large_$it", large, false)) } })
    transport.manifest = signed(json)
    val engine = engine(); engine.check(); rejects("ASSET_TOO_LARGE") { engine.download() }
    assertNull(engine.launchId()); assertEquals(0, File(root, "updates").listFiles()!!.size)
  }
  @Test fun malformedStateFailsClosedWithoutExecutingSavedBundle() {
    val engine = engine(); download(engine); engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    File(root, "state.json").writeText("not valid state")
    assertNull(engine().bundleFile())
  }
  @Test fun networkRedirectAndOversizeResponsesAreRejected() {
    val engine = engine(); transport.status = 302; rejects("NETWORK_FAILURE") { engine.check() }
    transport.status = 200; transport.reportedLength = FloraManifest.MAX_MANIFEST.toLong() + 1
    rejects("RESPONSE_TOO_LARGE") { engine.check() }
    transport.reportedLength = null; engine.check(); transport.assetLength = FloraManifest.MAX_FILE + 1
    rejects("ASSET_TOO_LARGE") { engine.download() }
  }
  @Test fun streamedAssetBoundIsEnforcedWithoutContentLength() {
    val engine = engine(); engine.check(); transport.infiniteAsset = true
    rejects("ASSET_TOO_LARGE") { engine.download() }; assertNull(engine.launchId())
  }
  @Test fun monotonicRequestDeadlineStopsSlowStreams() {
    rejects("NETWORK_TIMEOUT") { FloraStore.readBounded(ByteArrayInputStream(byteArrayOf(1)), 1024, System.nanoTime() - 1) }
  }
  @Test fun productionHttpsDeadlineCancelsTricklingHeaders() {
    tlsServer { socket ->
      val output = socket.outputStream
      for (byte in "HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n".toByteArray()) { output.write(byte.toInt()); output.flush(); Thread.sleep(50) }
    }.use { server ->
      val started = System.nanoTime()
      rejects("NETWORK_TIMEOUT") { FloraHTTPS().open(server.url, emptyMap(), started + 1_000_000_000L).use { fail("Headers should not finish") } }
      assertTrue("Overall deadline must interrupt headers", (System.nanoTime() - started) < 3_000_000_000L)
    }
  }
  @Test fun productionHttpsDeadlineCancelsTricklingBody() {
    tlsServer { socket ->
      val output = socket.outputStream; output.write("HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n".toByteArray()); output.flush()
      repeat(1024) { output.write(1); output.flush(); Thread.sleep(50) }
    }.use { server ->
      val started = System.nanoTime(); val deadline = started + 1_000_000_000L
      var rejected = false
      try { FloraHTTPS().open(server.url, emptyMap(), deadline).use { FloraStore.readBounded(it.body, 2048, deadline) } }
      catch (error: Exception) { rejected = true }
      assertTrue(rejected); assertTrue("Overall deadline must interrupt body", (System.nanoTime() - started) < 3_000_000_000L)
    }
  }
  @Test fun appCacheCannotAcceptAnotherAppsSignedPackage() {
    val engine = engine(); download(engine); engine.prepareReload(id2); engine.markLaunchSuccessful(id2)
    val other = FloraConfig.parse(JSONObject().put("appId", "app_two").put("url", "https://example.test/updates/app_two")
      .put("channel", config.channel).put("runtimeVersion", config.runtimeVersion).put("certificate", config.certificate).put("keyId", config.keyId).toString().toByteArray())
    val wrongScope = FloraEngine(other, FloraStore(root, other, filesystem), transport)
    assertNull(wrongScope.bundleFile())
  }
  @Test fun onlyHttpsAndValidStaticDestinationsAreAccepted() {
    val base = JSONObject().put("appId", config.appId).put("channel", config.channel).put("runtimeVersion", config.runtimeVersion).put("certificate", config.certificate).put("keyId", config.keyId)
    listOf("http://example.test/updates/app_one", "https://user@example.test/updates/app_one", "https://example.test/updates/app_two", "https://example.test/updates/app_one?x=y", "https://example.test/updates/app_one#fragment").forEach { url -> rejects("CONFIGURATION_INVALID") { FloraConfig.parse(base.put("url", url).toString().toByteArray()) } }
  }
  private inner class FakeTransport : FloraTransport {
    var manifest: Pair<ByteArray, String>? = null
    val assets = mutableMapOf<String, ByteArray>()
    var status = 200; var reportedLength: Long? = null; var assetLength: Long? = null; var infiniteAsset = false
    var assetRequests = 0; var allowAssets = true
    override fun open(url: URI, headers: Map<String, String>, deadline: Long): FloraResponse {
      val isManifest = url == config.url
      if (!isManifest) { assetRequests++; requireFlora(allowAssets, "NETWORK_FAILURE") }
      if (isManifest) { assertEquals("android", headers["expo-platform"]); assertEquals(config.runtimeVersion, headers["expo-runtime-version"]); assertNotNull(headers["expo-expect-signature"]) }
      val raw = if (isManifest) manifest!!.first else assets[url.path.substringAfterLast('/')]!!
      return object : FloraResponse {
        override val status = if (isManifest) this@FakeTransport.status else 200
        override val headers = if (isManifest) mapOf("content-type" to "application/expo+json", "expo-protocol-version" to "1", "expo-signature" to manifest!!.second) else emptyMap()
        override val contentLength = if (isManifest) reportedLength else assetLength
        override val contentEncoding: String? = null
        override val body: InputStream = if (!isManifest && infiniteAsset) object : InputStream() { override fun read() = 0; override fun read(bytes: ByteArray, offset: Int, count: Int): Int { java.util.Arrays.fill(bytes, offset, offset + count, 0.toByte()); return count } } else ByteArrayInputStream(raw)
        override fun close() { body.close() }
      }
    }
  }
  private fun tlsServer(reply: (javax.net.ssl.SSLSocket) -> Unit): TestTLSServer {
    val certificate = java.security.cert.CertificateFactory.getInstance("X.509").generateCertificate(File(System.getProperty("flora.test.certificate")).inputStream())
    val keys = java.security.KeyStore.getInstance("PKCS12").apply { load(null, null); setKeyEntry("test", privateKey, "test".toCharArray(), arrayOf(certificate)) }
    val manager = javax.net.ssl.KeyManagerFactory.getInstance(javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, "test".toCharArray()) }
    val ssl = javax.net.ssl.SSLContext.getInstance("TLS").apply { init(manager.keyManagers, null, null) }
    val server = ssl.serverSocketFactory.createServerSocket(0, 1, java.net.InetAddress.getByName("localhost")) as javax.net.ssl.SSLServerSocket
    val worker = Thread {
      try {
        (server.accept() as javax.net.ssl.SSLSocket).use { socket ->
          socket.soTimeout = 3000
          val input = socket.inputStream; val request = StringBuilder()
          while (!request.endsWith("\r\n\r\n")) { val byte = input.read(); if (byte < 0) break; request.append(byte.toChar()); if (request.length > 16384) break }
          reply(socket)
        }
      } catch (_: Exception) {}
    }.apply { isDaemon = true; start() }
    return TestTLSServer(server, worker)
  }
  private class TestTLSServer(val server: javax.net.ssl.SSLServerSocket, val worker: Thread) : java.io.Closeable {
    val url: URI = URI("https://localhost:${server.localPort}/test")
    override fun close() { server.close(); worker.interrupt(); worker.join(1000) }
  }
}
