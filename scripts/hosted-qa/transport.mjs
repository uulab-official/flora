export const SYNTHETIC_ORIGIN = "https://flora.example.test";

/** Test-only HTTPS route bridge. No server, DNS lookup, TLS bypass or cookie jar. */
export async function bridgeRequest(request, dispatch) {
  const url = new URL(request.url());
  if (url.origin !== SYNTHETIC_ORIGIN || url.username || url.password || url.hash) throw new Error("SYNTHETIC_ORIGIN_REQUIRED");
  const bytes = request.postDataBuffer();
  const response = await dispatch(request.url(), {
    method: request.method(), headers: await request.allHeaders(), redirect: "manual",
    ...(bytes === null ? {} : { body: bytes }),
  });
  const headers = Object.fromEntries(response.headers);
  // Playwright splits newline-separated Set-Cookie values into distinct protocol
  // headers. Never comma-join cookies (Expires contains commas), parse them into
  // addCookies(), or weaken the production attributes to make a test pass.
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies.join("\n");
  else delete headers["set-cookie"];
  return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
}
