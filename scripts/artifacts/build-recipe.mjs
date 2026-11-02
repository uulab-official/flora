import { isAbsolute, relative, resolve } from 'node:path';
import { isRecord } from './build-lifecycle.mjs';
export function snapshotLocalRecipe(value) {
  const keys = ['appId', 'repository', 'runnerId', 'platform', 'cwd', 'executable', 'args', 'artifactPath', 'format', 'timeoutMs', 'gitExecutable', 'outputLimitBytes'];
  if (!isRecord(value) || Object.keys(value).some(k => !keys.includes(k)) || !Array.isArray(value.args) || value.args.length > 64
      || value.args.some(a => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) throw new Error('BUILD_RECIPE_INVALID');
  const recipe = { ...value, args: [...value.args], timeoutMs: value.timeoutMs ?? 600000, gitExecutable: value.gitExecutable ?? '/usr/bin/git', outputLimitBytes: value.outputLimitBytes ?? 256 * 1024 };
  for (const name of ['cwd', 'executable', 'artifactPath', 'gitExecutable'])
    if (typeof recipe[name] !== 'string' || !isAbsolute(recipe[name]) || recipe[name].includes('\0')) throw new Error('BUILD_RECIPE_INVALID');
  const child = relative(resolve(recipe.cwd), resolve(recipe.artifactPath));
  if (!child || child === '..' || child.startsWith('../') || isAbsolute(child) || !['apk', 'aab', 'ipa'].includes(recipe.format)
      || !recipe.artifactPath.endsWith('.' + recipe.format) || !Number.isSafeInteger(recipe.timeoutMs) || recipe.timeoutMs < 100 || recipe.timeoutMs > 3600000 || !Number.isSafeInteger(recipe.outputLimitBytes) || recipe.outputLimitBytes < 1024 || recipe.outputLimitBytes > 64 * 1024 * 1024)
    throw new Error('BUILD_RECIPE_INVALID');
  recipe.args = Object.freeze(recipe.args);
  return Object.freeze(recipe);
}
