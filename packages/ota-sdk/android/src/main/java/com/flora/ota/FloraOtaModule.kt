package com.flora.ota

import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.WritableMap

public class FloraOtaModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "FloraOta"
  private fun configuration(engine: FloraEngine): WritableMap = Arguments.createMap().apply {
    putBoolean("enabled", true); putString("appId", engine.config.appId); putString("url", engine.config.url.toString())
    putString("channel", engine.config.channel); putString("runtimeVersion", engine.config.runtimeVersion); putString("platform", "android")
  }
  private fun launchInfo(engine: FloraEngine): WritableMap {
    val id = engine.launchId()
    return Arguments.createMap().apply {
      putString("appId", engine.config.appId); putString("runtimeVersion", engine.config.runtimeVersion)
      putString("source", if (id == null) "embedded" else "update"); if (id == null) putNull("updateId") else putString("updateId", id)
      putMap("assets", Arguments.createMap().apply { engine.assets().forEach { (key, uri) -> putString(key, uri) } })
      engine.rollback?.let { value -> putMap("rollback", Arguments.createMap().apply { putString("updateId", value.updateId); putString("reason", value.reason) }) }
    }
  }
  override fun getConstants(): Map<String, Any> = try {
    val engine = FloraOTAController.get(reactApplicationContext)
    mapOf("initialConfiguration" to configuration(engine).toHashMap(), "initialLaunchInfo" to launchInfo(engine).toHashMap())
  } catch (_: Exception) { emptyMap() }
  private fun execute(promise: Promise, work: (FloraEngine) -> Any?) {
    FloraOTAController.executor.execute {
      try { promise.resolve(work(FloraOTAController.get(reactApplicationContext))) }
      catch (error: Exception) { val code = (error as? FloraFailure)?.code ?: "NATIVE_FAILURE"; promise.reject(code, code) }
    }
  }
  private fun identity(engine: FloraEngine, manifest: FloraManifest): WritableMap = Arguments.createMap().apply {
    putString("id", manifest.id); putString("appId", engine.config.appId); putString("channel", engine.config.channel)
    putString("runtimeVersion", engine.config.runtimeVersion); putString("platform", "android")
  }
  @ReactMethod public fun getNativeConfiguration(promise: Promise) = execute(promise) { engine -> configuration(engine) }
  @ReactMethod public fun check(promise: Promise) = execute(promise) { engine ->
    val manifest = engine.check()
    Arguments.createMap().apply { putBoolean("available", manifest != null); if (manifest != null) putMap("update", identity(engine, manifest)) }
  }
  @ReactMethod public fun download(promise: Promise) = execute(promise) { engine ->
    val manifest = engine.download()
    Arguments.createMap().apply { putBoolean("downloaded", manifest != null); if (manifest != null) putMap("update", identity(engine, manifest)) }
  }
  @ReactMethod public fun getLaunchInfo(promise: Promise) = execute(promise) { engine -> launchInfo(engine) }
  @ReactMethod public fun markLaunchSuccessful(expectedUpdateId: String?, promise: Promise) = execute(promise) { engine ->
    engine.markLaunchSuccessful(expectedUpdateId); null
  }
  @ReactMethod public fun reload(expectedUpdateId: String, promise: Promise) {
    FloraOTAController.executor.execute {
      try {
        val engine = FloraOTAController.get(reactApplicationContext)
        val host = (reactApplicationContext.applicationContext as? ReactApplication)?.reactHost
        // Only Flora's delegate or the registered Expo release handler reads the
        // verified file again during reload. RN's default release host cannot.
        requireFlora(FloraReactHost.owns(host), "HOST_UNSUPPORTED")
        engine.prepareReload(expectedUpdateId)
        UiThreadUtil.runOnUiThread {
          try { host!!.reload("Flora OTA $expectedUpdateId"); promise.resolve(null) }
          catch (error: Exception) {
            FloraOTAController.executor.execute { try { engine.cancelReload(expectedUpdateId) } catch (_: Exception) {} }
            promise.reject("RELOAD_FAILED", "RELOAD_FAILED")
          }
        }
      } catch (error: Exception) { val code = (error as? FloraFailure)?.code ?: "NATIVE_FAILURE"; promise.reject(code, code) }
    }
  }
}
