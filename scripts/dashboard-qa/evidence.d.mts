export const LIMITS: Readonly<{ files: number; fileBytes: number; totalBytes: number; logBytes: number; chunkChars: number; lineBytes: number }>;
export interface EvidenceFile { name: string; bytes: Uint8Array }
export function encodeEvidence(files: readonly EvidenceFile[], commit: string): string[];
export function decodeEvidence(log: string, expectedCommit: string): { commit: string; files: { name: string; bytes: Buffer }[] };
