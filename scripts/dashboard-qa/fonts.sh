#!/usr/bin/env bash
set -euo pipefail
# Download-only from the runner's authenticated Ubuntu package indexes. Extract
# data without installing a package or executing its maintainer scripts.
font_root="${RUNNER_TEMP:?}/flora-dashboard-qa-fonts"
mkdir -p "$font_root/download" "$font_root/cache"
(
  cd "$font_root/download"
  apt-get download 'fonts-noto-cjk=1:20220127+repack1-1'
  packages=(fonts-noto-cjk_*.deb)
  test "${#packages[@]}" = 1
  test -f "${packages[0]}"
  test "$(dpkg-deb -f "${packages[0]}" Package)" = fonts-noto-cjk
  test "$(dpkg-deb -f "${packages[0]}" Version)" = '1:20220127+repack1-1'
  dpkg-deb --extract "${packages[0]}" "$font_root/package"
)
node --input-type=module - "$font_root" <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fontConfiguration } from './scripts/dashboard-qa/fonts.mjs';
const root = process.argv[2];
const license = await readFile(root + '/package/usr/share/doc/fonts-noto-cjk/copyright', 'utf8');
assert.ok(/OFL-1\.1|SIL OPEN FONT LICENSE/.test(license));
await writeFile(root + '/fonts.conf', fontConfiguration(root));
JS
export FONTCONFIG_FILE="$font_root/fonts.conf"
export XDG_CACHE_HOME="$font_root/cache"
fc-cache -f "$font_root/package/usr/share/fonts/opentype/noto"
matched_family="$(fc-match -f '%{family}' 'Noto Sans KR:lang=ko:charset=ac00')"
matched_file="$(fc-match -f '%{file}' 'Noto Sans KR:lang=ko:charset=ac00')"
[[ "$matched_family" == *'Noto Sans CJK KR'* ]]
[[ "$matched_file" == "$font_root/package/"* ]]
printf 'FLORA_QA_FONT_PREREQUISITE: pinned Ubuntu Noto Korean face available locally\n'
