import { generateKeyPairSync } from "node:crypto";

/** Synthetic GitHub transport; callers still use the production JWT/resolver. */
export function githubOTAFixture(origin: () => string, apps: Map<string, string>) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = { appId: "12345", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  let requests = 0;
  async function respond(request: Request): Promise<Response> {
    requests++;
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com" || !request.headers.get("Authorization")?.startsWith("Bearer ")) return Response.json({ error: "fixture boundary" }, { status: 403 });
    if (url.pathname === "/app/installations/42/access_tokens" && request.method === "POST") return Response.json({ token: "synthetic_installation_token" }, { status: 201 });
    const match = /^\/repos\/synthetic\/(expo-one|rn-two)\/(commits|contents)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return Response.json({}, { status: 404 });
    const repository = match[1]!, sha = (repository === "expo-one" ? "a" : "b").repeat(40);
    if (match[2] === "commits") return Response.json({ sha });
    if (url.searchParams.get("ref") !== sha) return Response.json({}, { status: 409 });
    if (!match[3]) return Response.json([{ name: "package.json", type: "file" }, { name: "app.json", type: "file" }]);
    const packages = repository === "expo-one" ? { expo: "~54.0.0", "react-native": "0.81.0", "expo-updates": "~29.0.0" } : { "react-native": "0.81.0", "expo-updates": "~29.0.0" };
    const data = match[3] === "package.json" ? { name: repository, dependencies: packages } : match[3] === "app.json" ? { expo: { name: repository, runtimeVersion: "runtime-1", platforms: ["ios", "android"], updates: { enabled: true, url: origin() + "/updates/" + apps.get(repository) } } } : null;
    if (!data) return Response.json({}, { status: 404 });
    const bytes = Buffer.from(JSON.stringify(data));
    return Response.json({ type: "file", encoding: "base64", size: bytes.length, content: bytes.toString("base64") });
  }
  const fetchFixture: typeof fetch = (input, init) => respond(input instanceof Request ? new Request(input, init) : new Request(input, init));
  return { credentials, respond, fetch: fetchFixture, requests: () => requests };
}
