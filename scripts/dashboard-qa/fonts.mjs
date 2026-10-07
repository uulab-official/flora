import assert from "node:assert/strict";

export function fontConfiguration(root) {
  assert.ok(typeof root === "string" && root.startsWith("/") && !/[\r\n\0]/.test(root));
  const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>
  <include ignore_missing="no">/etc/fonts/fonts.conf</include>
  <dir>${xml(root)}/package/usr/share/fonts/opentype/noto</dir>
  <cachedir>${xml(root)}/cache</cachedir>
  <alias><family>Noto Sans KR</family><prefer><family>Noto Sans CJK KR</family></prefer></alias>
</fontconfig>\n`;
}

/** CDP reports fonts actually used to draw the heading, not CSS availability. */
export function verifyKoreanFontUsage(fonts, sampleText) {
  assert.ok(typeof sampleText === "string" && sampleText.length <= 128);
  const koreanCodePoints = [...sampleText].filter(character => /[\uac00-\ud7a3]/u.test(character)).length;
  assert.ok(koreanCodePoints > 0, "KOREAN_SAMPLE_REQUIRED");
  assert.ok(Array.isArray(fonts) && fonts.length > 0 && fonts.length <= 8, "KOREAN_FONT_NOT_RENDERED");
  const usage = fonts.map(font => {
    assert.ok(typeof font.familyName === "string" && font.familyName.length <= 100);
    assert.ok(typeof font.postScriptName === "string" && font.postScriptName.length <= 100);
    assert.ok(Number.isSafeInteger(font.glyphCount) && font.glyphCount >= 0 && font.glyphCount <= 4096 && typeof font.isCustomFont === "boolean");
    return { familyName: font.familyName, postScriptName: font.postScriptName, glyphCount: font.glyphCount, isCustomFont: font.isCustomFont };
  });
  assert.ok(usage.some(font => font.familyName === "Noto Sans CJK KR" && !font.isCustomFont && font.glyphCount >= koreanCodePoints), "KOREAN_FONT_NOT_RENDERED");
  return { sampleText, koreanCodePoints, fonts: usage };
}
