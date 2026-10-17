package com.flora.ota

import android.content.Context
import com.facebook.react.ReactHost
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactNativeHostHandler

/** Expo 57 keeps its own factory, modules, delegates and lifecycle listeners. */
public class FloraExpoPackage : Package {
  override fun createReactNativeHostHandlers(context: Context): List<ReactNativeHostHandler> = listOf(
    object : ReactNativeHostHandler {
      private var release = false

      override fun onWillCreateReactInstance(useDeveloperSupport: Boolean) { release = !useDeveloperSupport }

      override fun getJSBundleFile(useDeveloperSupport: Boolean): String? =
        if (useDeveloperSupport) null else FloraOTAController.bundleFile(context)

      override fun onDidCreateReactHost(context: Context, reactNativeHost: ReactHost) {
        if (release) FloraReactHost.registerExpoHost(reactNativeHost)
      }

      override fun onReactInstanceException(useDeveloperSupport: Boolean, exception: Exception) {
        // Preserve an unconfirmed launch for next-process rollback. Do not hide
        // release JS exceptions through Expo's otherwise empty handler default.
        if (!useDeveloperSupport) throw exception
      }
    }
  )
}
