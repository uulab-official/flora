import type { DatabaseSync } from "node:sqlite";
import type { DogfoodStore } from "@app-ops/dogfood";
import { createSqliteAutomationStore } from "./dbautomation.js";
import * as operations from "./operations.js";
import * as applications from "./applications.js";
import * as inventory from "./inventory.js";
import * as verification from "./verifications.js";

/** Promise port over synchronous atomic local transactions; not a remote adapter. */
export function createSqliteDogfoodStore(db: DatabaseSync): DogfoodStore {
  return {
    automation: createSqliteAutomationStore(db),
    operations: {
      getGitHubConnection: async appId => operations.getGitHubConnection(db, appId),
      saveGitHubConnection: async (appId, input, now) => operations.saveGitHubConnection(db, appId, input, now),
      saveGitHubDetection: async input => operations.saveGitHubDetection(db, input),
      listGitHubDetections: async appId => operations.listGitHubDetections(db, appId),
      getGitHubDetection: async (appId, id) => operations.getGitHubDetection(db, appId, id),
      saveOTAAsset: async (asset, bytes) => operations.saveOTAAsset(db, asset, bytes),
      listOTAAssets: async appId => operations.listOTAAssets(db, appId),
      getOTAAsset: async (appId, id) => operations.getOTAAsset(db, appId, id),
      getPublishedOTAAsset: async (appId, id) => operations.getPublishedOTAAsset(db, appId, id),
      saveOTADeployment: async input => operations.saveOTADeployment(db, input),
      saveOTARollback: async input => operations.saveOTARollback(db, input),
      getOTADeployment: async (appId, id) => operations.getOTADeployment(db, appId, id),
      getOTADeploymentForRequest: async (appId, key) => operations.getOTADeploymentForRequest(db, appId, key),
      listOTADeployments: async appId => operations.listOTADeployments(db, appId),
      getLatestOTADeployment: async (appId, selection) => operations.getLatestOTADeployment(db, appId, selection),
    },
    applications: {
      registerApplication: async (input, now) => applications.registerApplication(db, input, now),
      listApplications: async () => applications.listApplications(db),
      getApplication: async id => applications.getApplication(db, id),
      getApplicationForSnapshot: async id => applications.getApplicationForSnapshot(db, id),
      updateApplicationSettings: async (id, input, now) => applications.updateApplicationSettings(db, id, input, now),
    },
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
