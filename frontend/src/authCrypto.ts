/** 浏览器 RSA-OAEP SHA-256；局域网 HTTP 无 crypto.subtle 时走纯 JS 实现。 */
import { rsaOaepEncrypt } from "./rsaOaepFallback";

function pemToBuf(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN PUBLIC KEY-----/g, "").replace(/-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function bytesToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function loginPayload(password: string, challengeId: string): Uint8Array {
  const nonceBytes = crypto.getRandomValues(new Uint8Array(8));
  let nonce = "";
  for (const b of nonceBytes) nonce += b.toString(16).padStart(2, "0");
  const payload = JSON.stringify({
    p: password,
    n: nonce,
    c: challengeId,
    t: Math.floor(Date.now() / 1000),
  });
  return new TextEncoder().encode(payload);
}

async function encryptWithSubtle(pem: string, data: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("no subtle");
  const key = await subtle.importKey(
    "spki",
    pemToBuf(pem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  // WebCrypto requires ArrayBuffer-backed bytes; the caller's typed array may
  // be backed by SharedArrayBuffer under newer TypeScript DOM declarations.
  const plain = new Uint8Array(data.byteLength);
  plain.set(data);
  const cipher = await subtle.encrypt({ name: "RSA-OAEP" }, key, plain);
  return bytesToB64(cipher);
}

export async function encryptLoginPassword(pem: string, password: string, challengeId: string): Promise<string> {
  const data = loginPayload(password, challengeId);
  if (globalThis.crypto?.subtle) {
    try {
      return await encryptWithSubtle(pem, data);
    } catch {
      // 非安全上下文、或实现不完整时改走纯 JS
    }
  }
  return bytesToB64(rsaOaepEncrypt(pem, data));
}
