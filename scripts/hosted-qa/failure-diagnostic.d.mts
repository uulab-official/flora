export function browserFailureDiagnostic(error: unknown): {
  name: string; operation: string | null; selectors: string[];
  frames: Array<{ file: string; line: number; column: number }>;
};
