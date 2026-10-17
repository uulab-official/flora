'use strict';

const { mkdir, readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { nativeConfiguration, applyInfoPlist, disableAndroidUpdates, applyAppDelegate, applyMainApplication } = require('./transforms.cjs');

/** Explicit opt-in to Flora's own engine. Config-plugin tooling is supplied by
 * the consuming Expo app, and is never a dependency of the core SDK. */
function withFloraOTA(config, options) {
  const native = nativeConfiguration(options);
  const { withInfoPlist, withExpoPlist, withAppDelegate, withMainApplication, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
  config.updates = { ...config.updates, enabled: false };
  config = withInfoPlist(config, mod => { mod.modResults = applyInfoPlist(mod.modResults, native); return mod; });
  config = withExpoPlist(config, mod => { mod.modResults.EXUpdatesEnabled = false; return mod; });
  config = withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') throw new Error('FLORA_PLUGIN_IOS_LANGUAGE_UNSUPPORTED');
    mod.modResults.contents = applyAppDelegate(mod.modResults.contents); return mod;
  });
  config = withMainApplication(config, mod => {
    if (mod.modResults.language !== 'kt') throw new Error('FLORA_PLUGIN_ANDROID_LANGUAGE_UNSUPPORTED');
    mod.modResults.contents = applyMainApplication(mod.modResults.contents); return mod;
  });
  config = withAndroidManifest(config, mod => { mod.modResults = disableAndroidUpdates(mod.modResults); return mod; });
  return withDangerousMod(config, ['android', async mod => {
    const directory = join(mod.modRequest.platformProjectRoot, 'app/src/main/assets');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'flora_ota_config.json');
    const contents = JSON.stringify(native, null, 2) + '\n';
    let previous;
    try { previous = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== contents) {
      const temporary = path + `.flora-${process.pid}.tmp`;
      await writeFile(temporary, contents, { mode: 0o644 });
      await rename(temporary, path);
    }
    return mod;
  }]);
}

module.exports = withFloraOTA;
