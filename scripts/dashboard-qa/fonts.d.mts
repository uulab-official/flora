export interface PlatformFontUsage { familyName: string; postScriptName: string; glyphCount: number; isCustomFont: boolean }
export function fontConfiguration(root: string): string;
export function verifyKoreanFontUsage(fonts: readonly PlatformFontUsage[], sampleText: string): { sampleText: string; koreanCodePoints: number; fonts: PlatformFontUsage[] };
