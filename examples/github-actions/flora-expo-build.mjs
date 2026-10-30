#!/usr/bin/env node
// Copy into a PRIVATE Expo app as scripts/flora-expo-build.mjs.
// No EAS account, network API keys, or access to Flora's production database.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export function parseTarget(platform, profile) {
  if (!['android', 'ios'].includes(platform) || !['preview', 'production'].includes(profile))
    throw new Error('FLORA_TARGET_INVALID');
  return { platform, profile };
}
export function iosScheme(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/.test(value))
    throw new Error('FLORA_IOS_SCHEME_INVALID');
  return value;
}
export function listArtifacts(root, extension) {
  if (!existsSync(root)) return [];
  const found = [];
  const walk = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const full = join(directory, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.isFile() && extname(item.name).toLowerCase() === extension) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}
function execute(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd, stdio: 'inherit', shell: false, env: { ...process.env, CI: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('FLORA_COMMAND_FAILED: ' + command + ' (' + result.status + ')');
}
function stage(root, files) {
  if (!files.length || files.length > 10) throw new Error('FLORA_ARTIFACT_COUNT_INVALID');
  const destination = join(root, 'dist', 'flora');
  mkdirSync(destination, { recursive: true });
  for (const file of files) {
    const name = basename(file);
    const target = join(destination, name);
    if (existsSync(target)) throw new Error('FLORA_ARTIFACT_ALREADY_EXISTS: ' + name);
    copyFileSync(file, target);
  }
}
function prebuild(root, platform) {
  if (existsSync(join(root, platform))) return;
  execute('npx', ['--no-install', 'expo', 'prebuild', '--platform', platform, '--no-install'], root);
}
export function selectedAndroidTask(profile) {
  // No implicit production signing. Private apps must implement their own
  // reviewed signing script to produce a store-uploadable production AAB.
  if (profile === 'production') throw new Error('FLORA_ANDROID_PRODUCTION_SIGNING_REQUIRED');
  if (profile !== 'preview') throw new Error('FLORA_TARGET_INVALID');
  return 'assembleDebug';
}
function androidBuild(root, profile) {
  const task = selectedAndroidTask(profile);
  prebuild(root, 'android');
  const gradle = join(root, 'android', 'gradlew');
  if (!existsSync(gradle)) throw new Error('FLORA_GRADLE_WRAPPER_MISSING');
  chmodSync(gradle, statSync(gradle).mode | 0o100);
  execute(gradle, [task, '--no-daemon'], join(root, 'android'));
  const output = join(root, 'android', 'app', 'build', 'outputs', 'apk');
  const files = listArtifacts(output, '.apk').filter(file => /(^|[/\\])debug([/\\]|$)/i.test(file));
  stage(root, files);
}
function iosBuild(root) {
  prebuild(root, 'ios');
  const ios = join(root, 'ios');
  if (!existsSync(join(ios, 'Podfile'))) throw new Error('FLORA_IOS_PODFILE_MISSING');
  execute('pod', ['install'], ios);
  const workspaces = readdirSync(ios).filter(item => item.endsWith('.xcworkspace'));
  if (workspaces.length !== 1) throw new Error('FLORA_IOS_WORKSPACE_AMBIGUOUS');
  const workspace = join(ios, workspaces[0]);
  const scheme = iosScheme(process.env.FLORA_IOS_SCHEME || basename(workspaces[0], '.xcworkspace'));
  const options = process.env.FLORA_IOS_EXPORT_OPTIONS_PLIST;
  if (!options || !existsSync(options)) throw new Error('FLORA_IOS_EXPORT_OPTIONS_REQUIRED');
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'flora-ios-archive-'));
  const archive = join(scratch, 'App.xcarchive');
  execute('xcodebuild', [
    '-workspace', workspace, '-scheme', scheme, '-configuration', 'Release',
    '-sdk', 'iphoneos', '-archivePath', archive, 'archive'
  ], root);
  const destination = join(root, 'dist', 'flora');
  mkdirSync(destination, { recursive: true });
  execute('xcodebuild', [
    '-exportArchive', '-archivePath', archive, '-exportPath', destination,
    '-exportOptionsPlist', resolve(options)
  ], root);
  if (!listArtifacts(destination, '.ipa').length) throw new Error('FLORA_IOS_IPA_MISSING');
}
export function main(args = process.argv.slice(2)) {
  const { platform, profile } = parseTarget(args[0], process.env.FLORA_PROFILE || 'preview');
  const root = process.cwd();
  if (platform === 'android') androidBuild(root, profile);
  else iosBuild(root);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
