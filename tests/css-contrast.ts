import assert from "node:assert/strict";

/** Read exact selector declarations in these static stylesheets, not a browser cascade. */
export function contrastStyles(css: string) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selector: match[1]!.trim(), declarations: match[2]! }));
  const declarations = new Map<string, Record<string, string>>();
  for (const rule of rules) {
    const values = declarations.get(rule.selector) ?? {};
    for (const declaration of rule.declarations.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon !== -1) values[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
    }
    declarations.set(rule.selector, values);
  }
  function value(selector: string, property: string): string {
    const declaration = declarations.get(selector)?.[property];
    assert.ok(declaration, `Missing ${selector} ${property}`);
    return declaration.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
      const resolved = declarations.get(":root")?.[token];
      assert.ok(resolved && !resolved.includes("var("), `Missing or nested token ${token}`);
      return resolved;
    });
  }
  function color(selector: string, property = "color"): string {
    const declaration = value(selector, property);
    const colors = declaration.match(/#[\da-f]{6}\b|#[\da-f]{3}\b|\bwhite\b/gi);
    assert.equal(colors?.length, 1, `Expected one opaque color in ${selector} ${property}: ${declaration}`);
    return colors![0] === "white" ? "#ffffff" : colors![0]!;
  }
  return { rules, value, color };
}

export function contrastRatio(foreground: string, background: string): number {
  function luminance(hex: string) {
    assert.match(hex, /^#(?:[\da-f]{3}|[\da-f]{6})$/i);
    const value = hex.length === 4 ? "#" + [...hex.slice(1)].map(char => char + char).join("") : hex;
    return [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const channel = parseInt(value.slice(1 + index * 2, 3 + index * 2), 16) / 255;
      return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    }, 0);
  }
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

export function assertContrast(foreground: string, background: string, minimum = 4.5, label = "text") {
  const ratio = contrastRatio(foreground, background);
  assert.ok(ratio >= minimum, `${label}: ${foreground} on ${background} = ${ratio.toFixed(4)}:1 (minimum ${minimum}:1)`);
}
