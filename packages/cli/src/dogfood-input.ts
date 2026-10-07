import fs from "node:fs/promises";
import { DomainError, ensure } from "@app-ops/core";

/** Independent of the two legacy workflow limits; read at most one sentinel byte. */
export async function readDogfoodInputFile(path: string): Promise<Uint8Array> {
  try {
    const file = await fs.open(path, "r");
    try {
      ensure((await file.stat()).isFile());
      const limit = 2 * 1024 * 1024, buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, Math.min(64 * 1024, buffer.length - length), null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      ensure(length <= limit, "INPUT_TOO_LARGE");
      return buffer.subarray(0, length);
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("INVALID_INPUT");
  }
}
