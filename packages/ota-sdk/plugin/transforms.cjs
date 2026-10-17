'use strict';

const { X509Certificate } = require('node:crypto');

function invalid() { throw new Error('FLORA_PLUGIN_CONFIGURATION_INVALID'); }

/** Accept only public immutable native settings; never credentials or file paths. */
function nativeConfiguration(options) {
  const keys = ['appId', 'url', 'channel', 'runtimeVersion', 'certificate', 'keyId', 'disableExpoUpdates'];
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !keys.includes(key)) || keys.some(key => !(key in options))
    || options.disableExpoUpdates !== true) invalid();
  const { appId, url, channel, runtimeVersion, certificate, keyId } = options;
  if (typeof appId !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(appId)
    || typeof channel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(channel)
    || typeof runtimeVersion !== 'string' || runtimeVersion.length < 1 || Buffer.byteLength(runtimeVersion, 'utf8') > 128 || /[\u0000-\u001f\u007f]/.test(runtimeVersion)
    || typeof keyId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)
    || typeof url !== 'string' || url.length > 2048
    || typeof certificate !== 'string' || Buffer.byteLength(certificate, 'utf8') > 16384) invalid();
  try {
    const address = new URL(url);
    if (address.protocol !== 'https:' || !address.hostname || address.username || address.password || address.hash
      || address.pathname !== `/updates/${appId}` || address.search && address.search !== `?channel=${channel}`
      || url !== `${address.origin}/updates/${appId}${address.search}`) invalid();
    const pem = certificate.replace(/\r\n/g, '\n').trim() + '\n';
    if (!/^-----BEGIN CERTIFICATE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END CERTIFICATE-----\n$/.test(pem)) invalid();
    const publicKey = new X509Certificate(pem).publicKey;
    const bits = publicKey.asymmetricKeyDetails?.modulusLength;
    if (publicKey.asymmetricKeyType !== 'rsa' || !bits || bits < 2048 || bits > 8192) invalid();
    return { appId, url, channel, runtimeVersion, certificate: pem, keyId };
  } catch { invalid(); }
}

function applyInfoPlist(plist, native) {
  return { ...plist, FloraOTAAppId: native.appId, FloraOTAUpdateURL: native.url,
    FloraOTAChannel: native.channel, FloraOTARuntimeVersion: native.runtimeVersion,
    FloraOTACertificate: native.certificate, FloraOTAKeyId: native.keyId };
}

function disableAndroidUpdates(manifest) {
  const application = manifest.manifest?.application?.[0];
  if (!application) throw new Error('FLORA_PLUGIN_ANDROID_APPLICATION_MISSING');
  const key = 'expo.modules.updates.ENABLED';
  application['meta-data'] = (application['meta-data'] ?? []).filter(item => item.$?.['android:name'] !== key);
  application['meta-data'].push({ $: { 'android:name': key, 'android:value': 'false' } });
  return manifest;
}

function addImport(contents, line) {
  if (contents.split(/\r?\n/).includes(line)) return contents;
  const imports = [...contents.matchAll(/^.*\bimport\s+[^\r\n]+$/gm)];
  const last = imports.at(-1);
  if (!last) throw new Error('FLORA_PLUGIN_NATIVE_IMPORTS_UNSUPPORTED');
  const end = last.index + last[0].length;
  return contents.slice(0, end) + '\n' + line + contents.slice(end);
}

function applyAppDelegate(contents) {
  if (!/class\s+AppDelegate\s*:\s*ExpoAppDelegate\b/.test(contents)
    || !/override\s+func\s+bundleURL\(\)\s*->\s*URL\?/.test(contents)) throw new Error('FLORA_PLUGIN_IOS_HOST_UNSUPPORTED');
  const selector = 'FloraOTAController.bundleURL(embedded: floraEmbeddedBundle)';
  if (contents.includes(selector)) return addImport(contents, 'import FloraOta');
  const embedded = /return\s+Bundle\.main\.url\(forResource:\s*"main",\s*withExtension:\s*"jsbundle"\)/g;
  if ([...contents.matchAll(embedded)].length !== 1) throw new Error('FLORA_PLUGIN_IOS_BUNDLE_SELECTOR_UNSUPPORTED');
  const output = contents.replace(embedded,
    'guard let floraEmbeddedBundle = Bundle.main.url(forResource: "main", withExtension: "jsbundle") else { return nil }\n    return ' + selector);
  return addImport(output, 'import FloraOta');
}

function applyMainApplication(contents) {
  if (!contents.includes('ExpoReactHostFactory.getDefaultReactHost(')) throw new Error('FLORA_PLUGIN_ANDROID_HOST_UNSUPPORTED');
  const packageRegistration = 'add(FloraOtaPackage())';
  if (contents.includes(packageRegistration)) return addImport(contents, 'import com.flora.ota.FloraOtaPackage');
  const packages = /PackageList\(this\)\.packages\.apply\s*\{/g;
  if ([...contents.matchAll(packages)].length !== 1) throw new Error('FLORA_PLUGIN_ANDROID_PACKAGE_LIST_UNSUPPORTED');
  const output = contents.replace(packages, match => match + '\n          // @flora/ota: native bridge; Expo retains its host and lifecycle.\n          ' + packageRegistration);
  return addImport(output, 'import com.flora.ota.FloraOtaPackage');
}

module.exports = { nativeConfiguration, applyInfoPlist, disableAndroidUpdates, applyAppDelegate, applyMainApplication };
