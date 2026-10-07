import assert from "node:assert/strict";

/** Read actual rendered surfaces; no source is executed and no layout is changed. */
export async function verifySurfaceDepth(page) {
  const read = () => {
    const visible = node => node.getClientRects().length > 0;
    const selectors = [".card", ".auth-card", ".empty-card", ".summary-strip", ".detail-panel", ".app-table-shell", ".mobile-nav", ".primary", "#auth-submit", ".pagination .icon-button"];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(visible).map(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const disabled = node.matches(":disabled") || !!node.closest(".import-action,.actions")?.querySelector("input:disabled");
      return { selector, disabled, shadow: style.boxShadow, transition: style.transitionDuration,
        bounds: [rect.x, rect.y, rect.width, rect.height] };
    }));
  };
  // Reduce animations while reading, then restore the context's normal preference.
  // This makes the test stable even when a pointer currently hovers a button.
  let surfaces;
  const interactionChecks = [];
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    surfaces = await page.evaluate(read);
    for (const surface of surfaces) {
      const flat = surface.disabled || (surface.selector === ".app-table-shell" && page.viewportSize().width <= 760);
      if ((surface.shadow === "none") !== flat) console.error("FLORA_QA_SURFACE_VALUES " + JSON.stringify({ selector: surface.selector, disabled: surface.disabled, shadow: surface.shadow, transition: surface.transition, flat }));
      assert.equal(surface.shadow === "none", flat, `SURFACE_ELEVATION: ${surface.selector}`);
      assert.ok(surface.transition.split(",").every(value => parseFloat(value) === 0), `REDUCED_MOTION: ${surface.selector}`);
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
      const { root } = await cdp.send("DOM.getDocument");
      for (const selector of [".primary", "#auth-submit", "button.primary:disabled", ".pagination .icon-button:disabled", ".app-open"]) {
        const target = page.locator(selector).first();
        if (!await target.count() || !await target.isVisible()) continue;
        const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
        const readState = node => ({ shadow: getComputedStyle(node).boxShadow, outline: getComputedStyle(node).outlineStyle,
          outlineWidth: parseFloat(getComputedStyle(node).outlineWidth), outlineOffset: parseFloat(getComputedStyle(node).outlineOffset),
          button: node.tagName === "BUTTON", hovered: node.matches(":hover"), disabled: node.matches(":disabled") || !!node.closest(".import-action,.actions")?.querySelector("input:disabled") });
        const resting = await target.evaluate(readState);
        try {
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
          const hovered = await target.evaluate(readState);
          if (resting.disabled) assert.equal(hovered.shadow, "none", `DISABLED_HOVER_ELEVATION: ${selector}`);
          else if (!resting.hovered && (selector === ".primary" || selector === "#auth-submit")) assert.notEqual(hovered.shadow, resting.shadow, `PRIMARY_HOVER_ELEVATION: ${selector}`);
          if (resting.button) {
            await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus", "focus-visible"] });
            const focused = await target.evaluate(readState);
            assert.equal(focused.outline, "solid", `VISIBLE_KEYBOARD_FOCUS: ${selector}`);
            assert.ok(focused.outlineWidth >= 3, `VISIBLE_KEYBOARD_FOCUS: ${selector}`);
            if (selector === ".app-open") assert.ok(focused.outlineOffset <= -3, "TABLE_FOCUS_MUST_NOT_BE_CLIPPED");
          }
          interactionChecks.push({ selector, disabled: resting.disabled, hover: true, focus: resting.button });
        } finally {
          await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        }
      }
    } finally { await cdp.detach(); }
  } catch (error) {
    const diagnostic = /^(SURFACE_ELEVATION|REDUCED_MOTION|DISABLED_HOVER_ELEVATION|PRIMARY_HOVER_ELEVATION|VISIBLE_KEYBOARD_FOCUS|TABLE_FOCUS_MUST_NOT_BE_CLIPPED)(?:: ([.#a-zA-Z0-9 :_-]+))?/.exec(error?.message ?? "");
    if (diagnostic) console.error("FLORA_QA_SURFACE_FAILURE " + diagnostic[0]);
    throw error;
  } finally {
    await page.emulateMedia({ reducedMotion: null });
  }
  const normal = await page.evaluate(read);
  assert.deepEqual(normal.map(value => value.bounds), surfaces.map(value => value.bounds), "ELEVATION_MUST_NOT_CHANGE_LAYOUT");
  return { reducedMotionVerified: true, layoutStable: true, interactionChecks, surfaces };
}
