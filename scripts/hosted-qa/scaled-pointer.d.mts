export function scaledPointerPoint(evidence: unknown): {
  x: number; y: number; clientX: number; clientY: number; scale: number;
};
/** CI-only pointer check with a shared 15 second action deadline. */
export function clickScaledPointer(page: unknown, selector: string): Promise<{
  x: number; y: number; clientX: number; clientY: number; scale: number;
  trustedPointerDown: true; trustedPointerUp: true; trustedClick: true;
}>;
