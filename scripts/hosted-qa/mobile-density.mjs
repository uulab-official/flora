import assert from "node:assert/strict";

/** Observed viewport-relative CSS-pixel boxes; this helper never scrolls or lays out the page. */
export function measureMobileAppDensity(evidence) {
  const invalid = "INVALID_MOBILE_DENSITY_EVIDENCE";
  const bounded = value => Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  const box = value => value && [value.x, value.y, value.width, value.height].every(bounded) && value.width >= 0 && value.height >= 0;
  assert.ok(evidence && evidence.viewport?.width === 390 && evidence.viewport?.height === 844, invalid);
  assert.ok(evidence.scale === 1 && evidence.scrollY === 0, invalid);
  const { viewport, navigation, rows } = evidence;
  assert.ok(box(navigation) && navigation.x === 0 && navigation.width === viewport.width && navigation.height > 0 && navigation.y >= 0 && navigation.y < viewport.height, invalid);
  const topNavigation = navigation.y === 0;
  assert.ok(topNavigation ? navigation.height < viewport.height : Math.abs(navigation.y + navigation.height - viewport.height) < 0.01, invalid);
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 100 && rows.every(box), invalid);
  const visibleTop = topNavigation ? navigation.height : 0;
  const visibleBottom = topNavigation ? viewport.height : Math.min(viewport.height, navigation.y);
  const completeVisibleRows = rows.filter(row => row.width > 0 && row.height > 0 && row.x >= 0 && row.y >= visibleTop && row.x + row.width <= viewport.width && row.y + row.height <= visibleBottom).length;
  assert.ok(completeVisibleRows >= 4, `MOBILE_APP_DENSITY_REQUIRED: ${completeVisibleRows} complete rows`);
  return { viewport, scale: evidence.scale, scrollY: evidence.scrollY, firstRowY: rows[0].y,
    navigationTop: navigation.y, visibleTop, visibleBottom, completeVisibleRows, minimumCompleteRows: 4 };
}
