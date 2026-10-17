import { Image, NativeModules, PixelRatio } from "react-native";
import { createFloraNativeEngine as createBridgeEngine } from "../dist/native-adapter.js";
import { createFloraAssetResolver, FloraAssetError } from "../dist/asset-resolver.js";
export { FloraNativeError } from "../dist/native-adapter.js";
export { FloraAssetError } from "../dist/asset-resolver.js";
/** Requires FloraOta to be linked into the installed iOS/Android binary. */
export function createFloraNativeEngine(options) {
  return createBridgeEngine(NativeModules.FloraOta, options);
}

/** Install before importing the app's router/components. The native constants
 * contain the already verified launch; no asynchronous AppRegistry race. */
export function installFloraAssetResolver({ expoAsset } = {}) {
  const bridge = NativeModules.FloraOta;
  const resolver = createFloraAssetResolver(bridge?.initialConfiguration, bridge?.initialLaunchInfo, () => PixelRatio.get());
  if (!resolver) return Object.freeze({ source: "embedded", updateId: null, assetCount: 0 });
  if (typeof Image.resolveAssetSource?.setCustomSourceTransformer !== "function") throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID");
  Image.resolveAssetSource.setCustomSourceTransformer(value => resolver.transform(value));
  if (expoAsset !== undefined) {
    if (typeof expoAsset.fromModule !== "function" || typeof expoAsset.fromMetadata !== "function") throw new FloraAssetError("NATIVE_ASSET_CONFIGURATION_INVALID");
    const fromModule = expoAsset.fromModule, fromMetadata = expoAsset.fromMetadata;
    function applyLocal(asset, uri) {
      // Only the URI returned by the immutable native-map resolver is assigned.
      asset.uri = uri; asset.localUri = uri; asset.downloaded = true; return asset;
    }
    expoAsset.fromModule = function (value) {
      if (typeof value !== "number") return fromModule.call(this, value);
      const source = Image.resolveAssetSource(value);
      if (!source || !Object.values(resolver.launch.assets).includes(source.uri)) throw new FloraAssetError("ASSET_NOT_IN_MANIFEST");
      return applyLocal(fromModule.call(this, value), source.uri);
    };
    expoAsset.fromMetadata = function (metadata) {
      const uri = resolver.resolveMetadata(metadata);
      return applyLocal(fromMetadata.call(this, metadata), uri);
    };
  }
  return Object.freeze({ source: "update", updateId: resolver.launch.updateId, assetCount: Object.keys(resolver.launch.assets).length });
}
