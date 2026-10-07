import type { DatabaseSync } from "node:sqlite";
import type { DogfoodStore } from "@app-ops/dogfood";
import * as inventory from "./inventory.js";
import * as verification from "./verifications.js";

/** Promise port over synchronous atomic local transactions; not a remote adapter. */
export function createSqliteDogfoodStore(db: DatabaseSync): DogfoodStore {
  return {
    saveInventory: async snapshot => inventory.saveInventory(db, snapshot),
    listInventory: async () => inventory.listInventory(db),
    getInventory: async id => inventory.getInventory(db, id),
    saveHeadObservation: async observation => inventory.saveHeadObservation(db, observation),
    getHeadObservation: async snapshot => inventory.getHeadObservation(db, snapshot),
    persistBaseline: async input => verification.persistBaseline(db, input),
    listVerifications: async id => verification.listVerifications(db, id),
    getVerification: async id => verification.getVerification(db, id),
    createVerification: async input => verification.createVerification(db, input),
    beginVerification: async input => verification.beginVerification(db, input),
    finishVerification: async (fence, completion, now) => verification.finishVerification(db, fence, completion, now),
    blockVerification: async (id, code, now) => verification.blockVerification(db, id, code, now),
    requestCancellation: async (id, now) => verification.requestCancellation(db, id, now),
    finishCancellation: async (id, confirmed, now) => verification.finishCancellation(db, id, confirmed, now),
    expireVerification: async (fence, now) => verification.expireVerification(db, fence, now),
    finishTimeout: async (id, confirmed, now) => verification.finishTimeout(db, id, confirmed, now),
  };
}
