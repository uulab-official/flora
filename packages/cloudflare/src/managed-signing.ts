/** Self-signed public trust anchors for Flora's native signature verification.
 * Private keys are created and retained inside the owner Durable Object only.
 * These certificates are not TLS certificates and grant no HTTPS identity. */
const algorithm = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00]);
const utf8 = new TextEncoder();
function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function der(tag: number, bytes: Uint8Array): Uint8Array {
  const size: number[] = []; let length = bytes.length;
  do { size.unshift(length & 255); length >>>= 8; } while (length);
  return concatenate(Uint8Array.from([tag, ...(bytes.length < 128 ? [bytes.length] : [128 | size.length, ...size])]), bytes);
}
const sequence = (...parts: Uint8Array[]) => der(0x30, concatenate(...parts));
function pem(label: string, bytes: Uint8Array): string {
  const encoded = btoa(String.fromCharCode(...bytes));
  return `-----BEGIN ${label}-----\n${encoded.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}
function date(value: number): Uint8Array {
  const time = new Date(value), year = time.getUTCFullYear();
  const encoded = time.toISOString().replace(/[-:]/g, "").replace("T", "").replace(/\.\d{3}Z$/, "Z");
  // RFC 5280 uses UTCTime through 2049, then GeneralizedTime.
  return der(year >= 1950 && year <= 2049 ? 0x17 : 0x18, utf8.encode(year >= 1950 && year <= 2049 ? encoded.slice(2) : encoded));
}
export interface ManagedSigningKey { appId: string; keyId: string; privateKey: string; certificate: string; createdAt: number }
export type PublicSigningKey = Omit<ManagedSigningKey, "privateKey">;
export function publicSigningKey(key: ManagedSigningKey): PublicSigningKey {
  return { appId: key.appId, keyId: key.keyId, certificate: key.certificate, createdAt: key.createdAt };
}
export async function createManagedSigningKey(appId: string, now: number): Promise<ManagedSigningKey> {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: Uint8Array.from([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("SIGNING_UNAVAILABLE");
  const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey), privateBytes = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(publicBytes instanceof ArrayBuffer) || !(privateBytes instanceof ArrayBuffer)) throw new Error("SIGNING_UNAVAILABLE");
  const spki = new Uint8Array(publicBytes);
  const privateKey = pem("PRIVATE KEY", new Uint8Array(privateBytes));
  const serial = crypto.getRandomValues(new Uint8Array(16)); serial[0] = (serial[0]! & 0x7f) | 1;
  const name = sequence(der(0x31, sequence(Uint8Array.from([0x06, 0x03, 0x55, 0x04, 0x03]), der(0x0c, utf8.encode(("Flora OTA " + appId).slice(0, 64))))));
  const expiry = new Date(now); expiry.setUTCFullYear(expiry.getUTCFullYear() + 10);
  const constraints = sequence(Uint8Array.from([0x06, 0x03, 0x55, 0x1d, 0x13]), Uint8Array.from([0x01, 0x01, 0xff]), der(0x04, sequence()));
  const usage = sequence(Uint8Array.from([0x06, 0x03, 0x55, 0x1d, 0x0f]), Uint8Array.from([0x01, 0x01, 0xff]), der(0x04, Uint8Array.from([0x03, 0x02, 0x07, 0x80])));
  const tbs = sequence(der(0xa0, Uint8Array.from([0x02, 0x01, 0x02])), der(0x02, serial), algorithm, name,
    sequence(date(now - 300_000), date(expiry.getTime())), name, spki, der(0xa3, sequence(constraints, usage)));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new Uint8Array(tbs).buffer));
  return { appId, keyId: "flora_" + crypto.randomUUID(), privateKey, certificate: pem("CERTIFICATE", sequence(tbs, algorithm, der(0x03, concatenate(Uint8Array.of(0), signature)))), createdAt: now };
}
