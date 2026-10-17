@file:OptIn(com.facebook.react.common.annotations.UnstableReactNativeAPI::class)

package com.flora.ota

import android.content.Context
import com.facebook.react.ReactHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactPackageTurboModuleManagerDelegate
import com.facebook.react.bridge.JSBundleLoader
import com.facebook.react.defaults.DefaultComponentsRegistry
import com.facebook.react.defaults.DefaultTurboModuleManagerDelegate
import com.facebook.react.fabric.ComponentFactory
import com.facebook.react.runtime.BindingsInstaller
import com.facebook.react.runtime.JSRuntimeFactory
import com.facebook.react.runtime.ReactHostDelegate
import com.facebook.react.runtime.ReactHostImpl
import com.facebook.react.runtime.hermes.HermesInstance
import java.lang.ref.WeakReference

/**
 * A production ReactHost whose delegate reads Flora's verified bundle on every reload.
 * RN's default release DevSupportManager ignores setBundleSource, so a dynamic delegate
 * is required. Development support and packager network access remain disabled.
 */
public object FloraReactHost {
  private var host: ReactHostImpl? = null
  private var expoHost: WeakReference<ReactHost>? = null

  @JvmStatic @Synchronized public fun create(
    context: Context,
    packages: List<ReactPackage>,
    embeddedBundleAssetPath: String = "index.android.bundle",
  ): ReactHost {
    host?.let { return it }
    requireFlora(embeddedBundleAssetPath.matches(Regex("[A-Za-z0-9._/-]{1,256}")) && !embeddedBundleAssetPath.contains("..") && !embeddedBundleAssetPath.startsWith('/'), "CONFIGURATION_INVALID")
    val application = context.applicationContext
    val delegate = object : ReactHostDelegate {
      override val jsMainModulePath = "index"
      override val bindingsInstaller: BindingsInstaller? = null
      override val reactPackages = packages
      override val jsRuntimeFactory: JSRuntimeFactory = HermesInstance()
      override val turboModuleManagerDelegateBuilder: ReactPackageTurboModuleManagerDelegate.Builder = DefaultTurboModuleManagerDelegate.Builder()
      override val jsBundleLoader: JSBundleLoader
        get() = FloraOTAController.bundleFile(application)?.let { JSBundleLoader.createFileLoader(it) }
          ?: JSBundleLoader.createAssetLoader(application, "assets://$embeddedBundleAssetPath", true)
      override fun handleInstanceException(error: Exception) { throw error }
    }
    val components = ComponentFactory()
    DefaultComponentsRegistry.register(components)
    return ReactHostImpl(application, delegate, components, false, false).also { host = it }
  }

  /** Called only by the optional Expo release handler whose selector is dynamic. */
  @Synchronized internal fun registerExpoHost(candidate: ReactHost) {
    requireFlora(candidate is ReactHostImpl, "HOST_UNSUPPORTED")
    expoHost = WeakReference(candidate)
  }

  @Synchronized internal fun owns(candidate: ReactHost?): Boolean = candidate != null && (candidate === host || candidate === expoHost?.get())
}
