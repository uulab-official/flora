import assert from "node:assert/strict";

export function scaledPointerPoint(evidence) {
  const invalid = "INVALID_SCALED_POINTER_GEOMETRY";
  const finite = value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  const box = evidence?.box, visual = evidence?.visual;
  assert.ok(box && visual && [box.x, box.y, box.width, box.height, visual.offsetLeft, visual.offsetTop,
    visual.width, visual.height, visual.scale].every(finite), invalid);
  assert.ok(box.width > 0 && box.height > 0 && visual.width > 0 && visual.height > 0
    && visual.offsetLeft >= 0 && visual.offsetTop >= 0 && Math.abs(visual.scale - 2) < 0.01, invalid);
  const left = Math.max(box.x, visual.offsetLeft), right = Math.min(box.x + box.width, visual.offsetLeft + visual.width);
  const top = Math.max(box.y, visual.offsetTop), bottom = Math.min(box.y + box.height, visual.offsetTop + visual.height);
  assert.ok(right - left > 1 && bottom - top > 1, "SCALED_POINTER_OUTSIDE_VIEWPORT");
  const clientX = (left + right) / 2, clientY = (top + bottom) / 2;
  // Both coordinate spaces use CSS pixels. Do not multiply or divide by scale.
  return { x: clientX - visual.offsetLeft, y: clientY - visual.offsetTop, clientX, clientY, scale: visual.scale };
}

export async function clickScaledPointer(page, selector) {
  // Preserve the capture runner's original 15 second pointer-action budget.
  const deadline = Date.now() + 15_000;
  const timeoutError = Object.assign(new Error("SCALED_POINTER_ACTION_TIMEOUT"), { name: "TimeoutError" });
  let timer, expired = false, actionFailure;
  const remaining = () => {
    const value = deadline - Date.now();
    if (expired || value <= 0) throw timeoutError;
    return value;
  };
  const work = (async () => {
    let element, probe;
    try {
      const control = page.locator(selector);
      await control.waitFor({ state: "visible", timeout: remaining() });
      await control.scrollIntoViewIfNeeded({ timeout: remaining() });
      element = await control.elementHandle({ timeout: remaining() });
      assert.ok(element, "SCALED_POINTER_TARGET_REQUIRED");
      for (const state of ["visible", "enabled", "stable"]) await element.waitForElementState(state, { timeout: remaining() });
      remaining();
      const evidence = await element.evaluate(node => {
        const box = node.getBoundingClientRect(), visual = window.visualViewport;
        return { box: { x: box.x, y: box.y, width: box.width, height: box.height }, visual: visual && {
          offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop, width: visual.width, height: visual.height, scale: visual.scale } };
      });
      remaining();
      const point = scaledPointerPoint(evidence);
      probe = await element.evaluateHandle((node, { point, evidence }) => {
        if (!node.isConnected) throw new Error("SCALED_POINTER_TARGET_REQUIRED");
        if (node.matches(":disabled") || node.closest('[aria-disabled="true"]')) throw new Error("SCALED_POINTER_DISABLED");
        const box = node.getBoundingClientRect(), visual = window.visualViewport;
        if (!visual || ["x", "y", "width", "height"].some(key => Math.abs(box[key] - evidence.box[key]) > 0.01)
          || ["offsetLeft", "offsetTop", "width", "height", "scale"].some(key => Math.abs(visual[key] - evidence.visual[key]) > 0.01)) {
          throw new Error("SCALED_POINTER_MOVED");
        }
        if (!node.contains(document.elementFromPoint(point.clientX, point.clientY))) throw new Error("SCALED_POINTER_HIT_REQUIRED");
        const counts = { pointerdown: 0, pointerup: 0, click: 0 }; let invalid = false;
        const listener = event => {
          counts[event.type]++;
          if (!event.isTrusted || !node.contains(event.target) || Math.abs(event.clientX - point.clientX) > 1
            || Math.abs(event.clientY - point.clientY) > 1) invalid = true;
        };
        for (const type of Object.keys(counts)) window.addEventListener(type, listener, { capture: true, passive: true });
        return { stop() {
          for (const type of Object.keys(counts)) window.removeEventListener(type, listener, true);
          return { ...counts, invalid };
        } };
      }, { point, evidence });
      remaining();
      // Playwright's mouse sends trusted CDP input in visual-viewport CSS
      // coordinates. DOM hit checking above deliberately uses layout coordinates.
      await page.mouse.click(point.x, point.y);
      remaining();
      const events = await probe.evaluate(value => value.stop());
      assert.ok(events.pointerdown === 1 && events.pointerup === 1 && events.click === 1 && !events.invalid,
        "SCALED_POINTER_TRUSTED_EVENTS_REQUIRED");
      return { ...point, trustedPointerDown: true, trustedPointerUp: true, trustedClick: true };
    } catch (error) {
      actionFailure = error; throw error;
    } finally {
      // This cleanup shares the outer deadline; a stalled handle cannot prevent
      // the caller from restoring scale. No continuation can dispatch a late click.
      await probe?.evaluate(value => value.stop()).catch(() => {});
      await probe?.dispose().catch(() => {}); await element?.dispose().catch(() => {});
    }
  })();
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(actionFailure ?? timeoutError); }, 15_000);
    })]);
  } finally { expired = true; clearTimeout(timer); }
}
