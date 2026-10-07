/** A token fragment on the existing page is only same-document navigation. */
export async function navigateBootstrapDocument(page, bootstrapUrl) {
  // Leave the stopped unauthorized client before loading the bootstrap module.
  // about:blank is an internal document; it makes no external network request.
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await page.goto(bootstrapUrl, { waitUntil: "domcontentloaded" });
}
