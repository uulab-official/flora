export function navigateBootstrapDocument(page: { goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown> }, bootstrapUrl: string): Promise<void>;
