/** Validates observed viewport-relative CSS-pixel boxes from the canonical mobile capture. */
export function measureMobileAppDensity(evidence: unknown): {
  viewport: { width: number; height: number };
  scale: number;
  scrollY: number;
  firstRowY: number;
  navigationTop: number;
  visibleBottom: number;
  completeVisibleRows: number;
  minimumCompleteRows: number;
};
