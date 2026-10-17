import Foundation
import CryptoKit
import Security

var checks = 0
func demand(_ condition: Bool, _ message: String) { checks += 1; if !condition { fatalError(message) } }
func expectCode(_ code: String, _ work: () throws -> Void) { do { try work(); fatalError("expected \(code)") } catch let error as FloraOTAError { demand(error.code == code, "wrong code \(error.code), expected \(code)") } catch { fatalError("unsanitized error: \(error)") } }
let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
let cert = try String(contentsOf: fixture.appendingPathComponent("certificate.pem"), encoding: .utf8)
let base: [String: Any] = ["FloraOTAAppId":"app_one", "FloraOTAUpdateURL":"https://updates.example/updates/app_one", "FloraOTAChannel":"production", "FloraOTARuntimeVersion":"native-v1", "FloraOTACertificate":cert, "FloraOTAKeyId":"fixture"]
let configuration = try FloraOTAConfiguration(dictionary: base)
demand(configuration.appId == "app_one", "binary configuration")
var bad = base; bad["FloraOTAUpdateURL"] = "http://updates.example/updates/app_one"
expectCode("CONFIGURATION_INVALID") { _ = try FloraOTAConfiguration(dictionary: bad) }
bad = base; bad["FloraOTAChannel"] = "production\n"
expectCode("CONFIGURATION_INVALID") { _ = try FloraOTAConfiguration(dictionary: bad) }
bad = base; bad["FloraOTAAppId"] = "app_two"
expectCode("CONFIGURATION_INVALID") { _ = try FloraOTAConfiguration(dictionary: bad) }
let body = try Data(contentsOf: fixture.appendingPathComponent("manifest.json"))
let signature = try Data(contentsOf: fixture.appendingPathComponent("signature.bin")).base64EncodedString()
let headers = ["expo-signature":"sig=\"\(signature)\", keyid=\"fixture\", alg=\"rsa-v1_5-sha256\""]
let manifest = try FloraOTAManifest(data: body, headers: headers, configuration: configuration)
demand(manifest.id == "00000000-0000-4000-8000-000000000001", "verified UUID")
expectCode("SIGNATURE_INVALID") { _ = try FloraOTAManifest(data: body + Data([32]), headers: headers, configuration: configuration) }
expectCode("SIGNATURE_INVALID") { _ = try FloraOTAManifest(data: body, headers: [:], configuration: configuration) }
for malformed in ["sig=\"", "sig=\"\"", "=\"", "sig=\"bad\", sig=\"bad\", keyid=\"fixture\", alg=\"rsa-v1_5-sha256\""] { expectCode("SIGNATURE_INVALID") { _ = try FloraOTAManifest(data: body, headers: ["expo-signature":malformed], configuration: configuration) } }
var two = base; two["FloraOTAAppId"] = "app_two"; two["FloraOTAUpdateURL"] = "https://updates.example/updates/app_two"
expectCode("UPDATE_INCOMPATIBLE") { _ = try FloraOTAManifest(data: body, headers: headers, configuration: FloraOTAConfiguration(dictionary: two)) }
final class FixtureTransport: FloraOTATransport {
  var manifestBody: Data = body; var manifestHeaders = headers; var asset = Data("globalThis.floraVersion = 2;".utf8); var assets: [String: Data] = [:]
  func fetch(_ url: URL, headers: [String: String], maximumBytes: Int, destination: URL?) throws -> FloraOTAHTTPResponse {
    let result = url.path.contains("/assets/") ? (assets[url.lastPathComponent] ?? asset) : manifestBody
    demand(result.count <= maximumBytes, "bounded transport")
    if let target = destination { try result.write(to: target); return FloraOTAHTTPResponse(status: 200, headers: [:], body: Data()) }
    return FloraOTAHTTPResponse(status: 200, headers: manifestHeaders, body: result)
  }
}
let root = fixture.appendingPathComponent("storage", isDirectory: true)
try? FileManager.default.removeItem(at: root)
let transport = FixtureTransport()
let embedded = fixture.appendingPathComponent("embedded.js"); try Data("embedded".utf8).write(to: embedded)
let first = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try first.launch(embedded: embedded) == embedded, "first embedded launch")
demand(try first.check()["available"] as? Bool == true, "verified check")
demand(try first.download()["downloaded"] as? Bool == true, "hash-verified download")
let stagedRestart = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try stagedRestart.launch(embedded: embedded) == embedded, "staging alone does not load executable")
demand(try stagedRestart.check()["available"] as? Bool == true, "staged update can be checked after process restart")
demand(try stagedRestart.download()["downloaded"] as? Bool == true, "staged update can be reused after process restart")
let selected = try first.activateDownloaded(expectedUpdateId: manifest.id)
demand(selected.isFileURL && selected != embedded, "native executable selected")
expectCode("LAUNCH_ID_MISMATCH") { try first.markLaunchSuccessful(expectedUpdateId: nil) }
let next = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try next.launch(embedded: embedded) == embedded, "unconfirmed startup rollback")
demand(try next.check()["available"] as? Bool == false, "bad ID blocked")
try FileManager.default.removeItem(at: root)
let healthy = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
_ = try healthy.launch(embedded: embedded); _ = try healthy.check(); _ = try healthy.download(); _ = try healthy.activateDownloaded(expectedUpdateId: manifest.id)
try healthy.markLaunchSuccessful(expectedUpdateId: manifest.id)
let restart = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
let loaded = try restart.launch(embedded: embedded)
demand(loaded != embedded, "confirmed update durable across restart")
try Data("tampered".utf8).write(to: loaded)
let tampered = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try tampered.launch(embedded: embedded) == embedded, "tampered persisted executable fallback")
try FileManager.default.removeItem(at: root)
let corrupted = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
_ = try corrupted.launch(embedded: embedded); _ = try corrupted.check(); transport.asset = Data("different".utf8)
expectCode("ASSET_HASH_MISMATCH") { _ = try corrupted.download() }
let intact = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try intact.launch(embedded: embedded) == embedded, "failed download has no executable pointer")
// A signed but incompatible manifest must still fail after RSA verification.
func signFixture(_ object: [String: Any]) throws -> (Data, [String: String]) {
  let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  let json = fixture.appendingPathComponent("variant.json"), signature = fixture.appendingPathComponent("variant.sig")
  try data.write(to: json)
  let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl"); process.arguments = ["dgst", "-sha256", "-sign", fixture.appendingPathComponent("key.pem").path, "-out", signature.path, json.path]
  try process.run(); process.waitUntilExit(); demand(process.terminationStatus == 0, "fixture signature")
  let encoded = try Data(contentsOf: signature).base64EncodedString()
  return (data, ["expo-signature":"sig=\"\(encoded)\", keyid=\"fixture\", alg=\"rsa-v1_5-sha256\""])
}
let original = try JSONSerialization.jsonObject(with: body) as! [String: Any]
var wrongPlatform = original; wrongPlatform["extra"] = ["flora":["appId":"app_one", "platform":"android"]]
let platformBytes = try signFixture(wrongPlatform)
expectCode("UPDATE_INCOMPATIBLE") { _ = try FloraOTAManifest(data: platformBytes.0, headers: platformBytes.1, configuration: configuration) }
var wrongRuntime = original; wrongRuntime["runtimeVersion"] = "native-other"
let runtimeBytes = try signFixture(wrongRuntime)
expectCode("UPDATE_INCOMPATIBLE") { _ = try FloraOTAManifest(data: runtimeBytes.0, headers: runtimeBytes.1, configuration: configuration) }
var foreignURL = original; var launch = original["launchAsset"] as! [String: Any]
launch["url"] = (launch["url"] as! String).replacingOccurrences(of: "updates.example", with: "elsewhere.example"); foreignURL["launchAsset"] = launch
let foreignBytes = try signFixture(foreignURL)
expectCode("ASSET_URL_INVALID") { _ = try FloraOTAManifest(data: foreignBytes.0, headers: foreignBytes.1, configuration: configuration) }
var wrongChannel = original; wrongChannel["metadata"] = ["channel":"other", "appid":"app_one"]
let channelBytes = try signFixture(wrongChannel)
expectCode("UPDATE_INCOMPATIBLE") { _ = try FloraOTAManifest(data: channelBytes.0, headers: channelBytes.1, configuration: configuration) }
try? FileManager.default.removeItem(at: root)
transport.asset = Data("globalThis.floraVersion = 2;".utf8); transport.manifestBody = body; transport.manifestHeaders = headers
let previousGood = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
_ = try previousGood.launch(embedded: embedded); _ = try previousGood.check(); _ = try previousGood.download(); _ = try previousGood.activateDownloaded(expectedUpdateId: manifest.id); try previousGood.markLaunchSuccessful(expectedUpdateId: manifest.id)
var v3 = original; v3["id"] = "00000000-0000-4000-8000-000000000003"
let v3Signed = try signFixture(v3); transport.manifestBody = v3Signed.0; transport.manifestHeaders = v3Signed.1
_ = try previousGood.check(); _ = try previousGood.download(); _ = try previousGood.activateDownloaded(expectedUpdateId: "00000000-0000-4000-8000-000000000003")
expectCode("LAUNCH_ID_MISMATCH") { try previousGood.markLaunchSuccessful(expectedUpdateId: manifest.id) }
expectCode("LAUNCH_UNCONFIRMED") {
  var next = original; next["id"] = "00000000-0000-4000-8000-000000000004"; let signed = try signFixture(next)
  transport.manifestBody = signed.0; transport.manifestHeaders = signed.1
  _ = try previousGood.check(); _ = try previousGood.download(); _ = try previousGood.activateDownloaded(expectedUpdateId: "00000000-0000-4000-8000-000000000004")
}
let recovered = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
let recoveredURL = try recovered.launch(embedded: embedded)
demand(recoveredURL.lastPathComponent == selected.lastPathComponent && recoveredURL.deletingLastPathComponent().lastPathComponent == manifest.id, "rollback preserves previous confirmed executable")
let launchInfo = try recovered.getLaunchInfo(); demand(launchInfo["updateId"] as? String == manifest.id, "previous good launch ID")
demand((launchInfo["rollback"] as? [String: String])?["reason"] == "UNCONFIRMED_LAUNCH", "explicit rollback reason")
let appTwoEngine = try FloraOTAEngine(configuration: FloraOTAConfiguration(dictionary: two), storageRoot: root, transport: transport)
demand(try appTwoEngine.launch(embedded: embedded) == embedded, "another app cannot load app one's files")
let linked = fixture.appendingPathComponent("linked", isDirectory: true)
try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: root)
expectCode("STORAGE_INVALID") { _ = try FloraOTAEngine(configuration: configuration, storageRoot: linked, transport: transport) }
try FileManager.default.removeItem(at: root)
let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=")!
let pngHash = Data(SHA256.hash(data: png)), pngHex = pngHash.map { String(format: "%02x", $0) }.joined(), pngBase64 = pngHash.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
var withImage = original; withImage["assets"] = [["hash":pngBase64, "key":"flower", "fileExtension":".png", "contentType":"image/png", "url":"https://updates.example/updates/app_one/assets/" + pngHex]]
let imageSigned = try signFixture(withImage); transport.manifestBody = imageSigned.0; transport.manifestHeaders = imageSigned.1; transport.assets[pngHex] = png
let withAssets = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
_ = try withAssets.launch(embedded: embedded); _ = try withAssets.check(); _ = try withAssets.download(); _ = try withAssets.activateDownloaded(expectedUpdateId: manifest.id)
let assetInfo = try withAssets.getLaunchInfo(); let localImage = (assetInfo["assets"] as! [String: String])["flower"]!
let localImageBytes = try Data(contentsOf: URL(string: localImage)!)
demand(URL(string: localImage)!.isFileURL && localImageBytes == png, "ancillary assets are verified local files")
try withAssets.markLaunchSuccessful(expectedUpdateId: manifest.id)
try Data("bad image".utf8).write(to: URL(string: localImage)!)
let damagedAsset = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try damagedAsset.launch(embedded: embedded) == embedded, "tampered ancillary asset prevents executable load")

// Promise's real export contains 46 unique assets. Preserve every asset and
// retain the native hash, identity and bounded count checks at the new boundary.
func assetManifest(_ count: Int) -> [String: Any] {
  var value = original
  value["assets"] = (0..<count).map { index -> [String: Any] in
    let bytes = Data("flora-asset-\(index)".utf8), digest = Data(SHA256.hash(data: bytes))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    let hash = digest.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    transport.assets[hex] = bytes
    return ["hash":hash, "key":"asset_\(index)", "fileExtension":".png", "contentType":"image/png", "url":"https://updates.example/updates/app_one/assets/" + hex]
  }
  return value
}
let manyAssets = assetManifest(46), manySigned = try signFixture(manyAssets)
try? FileManager.default.removeItem(at: root)
transport.manifestBody = manySigned.0; transport.manifestHeaders = manySigned.1
let manyRunning = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
_ = try manyRunning.launch(embedded: embedded); _ = try manyRunning.check(); _ = try manyRunning.download(); _ = try manyRunning.activateDownloaded(expectedUpdateId: manifest.id)
let manyInfo = try manyRunning.getLaunchInfo(), manyURIs = manyInfo["assets"] as! [String: String]
demand(manyURIs.count == 46, "all 46 real-app assets available after activation")
let lastAsset = URL(string: manyURIs["asset_45"]!)!
demand(try Data(contentsOf: lastAsset) == Data("flora-asset-45".utf8), "last asset has verified bytes")
try manyRunning.markLaunchSuccessful(expectedUpdateId: manifest.id)
let manyRestarted = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try manyRestarted.launch(embedded: embedded) != embedded, "46 assets remain durable across restart")
demand((try manyRestarted.getLaunchInfo()["assets"] as! [String: String]).count == 46, "restart exposes every verified asset")
try Data("persisted asset changed".utf8).write(to: lastAsset)
let manyDamaged = try FloraOTAEngine(configuration: configuration, storageRoot: root, transport: transport)
demand(try manyDamaged.launch(embedded: embedded) == embedded, "last asset tamper blocks executable after restart")
let sixtyFourSigned = try signFixture(assetManifest(64))
demand(try FloraOTAManifest(data: sixtyFourSigned.0, headers: sixtyFourSigned.1, configuration: configuration).assets.count == 64, "64 asset manifest accepted")
let sixtyFiveSigned = try signFixture(assetManifest(65))
expectCode("MANIFEST_INVALID") { _ = try FloraOTAManifest(data: sixtyFiveSigned.0, headers: sixtyFiveSigned.1, configuration: configuration) }
var manyForeign = manyAssets; manyForeign["metadata"] = ["channel":"production", "appid":"app_two"]
let manyForeignSigned = try signFixture(manyForeign)
expectCode("UPDATE_INCOMPATIBLE") { _ = try FloraOTAManifest(data: manyForeignSigned.0, headers: manyForeignSigned.1, configuration: configuration) }
print("Native security/storage checks: \(checks)")
print("Flora iOS native engine: configuration, RSA, identity, exact bytes, download hash, durable restart, launch fencing, rollback and persisted tamper checks passed")
