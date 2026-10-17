import type { AutomationJob, AutomationLease, OTAAsset } from "@app-ops/dogfood";
/** Internal verified provider receipt. HTTP callers never supply this proof. */
export interface ExternalAssetProof { objectKey:string; size:number; digest:string; version:string; etag:string }
export interface ExternalOTAAssets { put(asset:OTAAsset,bytes:Uint8Array):Promise<ExternalAssetProof>; get(asset:OTAAsset,proof:ExternalAssetProof):Promise<Uint8Array> }
export interface ExternalAssetUploadContext {
 job:Pick<AutomationJob,"id"|"appId"|"commitSha"|"platform">;
 lease:Pick<AutomationLease,"jobId"|"appId"|"attemptId">;
 reference:string|null;
}
