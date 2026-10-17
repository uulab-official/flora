import Foundation
import Security
import CryptoKit
import Darwin

/// Error codes are stable and intentionally omit URLs, response bodies and credentials.
public struct FloraOTAError: Error { public let code: String; public init(_ code: String) { self.code = code } }
private func require(_ value: Bool, _ code: String) throws { if !value { throw FloraOTAError(code) } }
private func matches(_ value: String, _ pattern: String) -> Bool { guard let range = value.range(of: pattern, options: .regularExpression) else { return false }; return range.lowerBound == value.startIndex && range.upperBound == value.endIndex }
private func hashHex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func base64URL(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
private func sameOrigin(_ one: URL, _ two: URL) -> Bool { one.scheme == "https" && two.scheme == "https" && one.host?.lowercased() == two.host?.lowercased() && (one.port ?? 443) == (two.port ?? 443) }
private let uuidPattern = "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"

public struct FloraOTAConfiguration {
  public let appId: String, url: URL, channel: String, runtimeVersion: String, keyId: String
  fileprivate let publicKey: SecKey
  fileprivate let identity: String
  public init(dictionary: [String: Any]) throws {
    guard let app = dictionary["FloraOTAAppId"] as? String,
      let address = dictionary["FloraOTAUpdateURL"] as? String,
      let target = URL(string: address), let parts = URLComponents(url: target, resolvingAgainstBaseURL: false),
      let channel = dictionary["FloraOTAChannel"] as? String,
      let runtime = dictionary["FloraOTARuntimeVersion"] as? String,
      let certificate = dictionary["FloraOTACertificate"] as? String,
      let keyId = dictionary["FloraOTAKeyId"] as? String else { throw FloraOTAError("CONFIGURATION_INVALID") }
    try require(matches(app, "^[a-z][a-z0-9_-]{2,95}$") && matches(channel, "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") && matches(keyId, "^[A-Za-z0-9._-]{1,128}$"), "CONFIGURATION_INVALID")
    try require(runtime.utf8.count > 0 && runtime.utf8.count <= 128 && !runtime.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }), "CONFIGURATION_INVALID")
    try require(address.utf8.count <= 2048 && target.scheme == "https" && target.host != nil && parts.user == nil && parts.password == nil && parts.fragment == nil && parts.percentEncodedPath == "/updates/" + app, "CONFIGURATION_INVALID")
    let queries = parts.queryItems ?? []
    try require(queries.isEmpty || (queries.count == 1 && queries[0].name == "channel" && queries[0].value == channel), "CONFIGURATION_INVALID")
    try require(certificate.utf8.count <= 16384 && certificate.hasPrefix("-----BEGIN CERTIFICATE-----") && certificate.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("-----END CERTIFICATE-----"), "CONFIGURATION_INVALID")
    let content = certificate.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").components(separatedBy: .whitespacesAndNewlines).joined()
    guard let bytes = Data(base64Encoded: content), let cert = SecCertificateCreateWithData(nil, bytes as CFData), let key = SecCertificateCopyKey(cert), let attributes = SecKeyCopyAttributes(key) as? [String: Any], attributes[kSecAttrKeyType as String] as? String == kSecAttrKeyTypeRSA as String, let size = attributes[kSecAttrKeySizeInBits as String] as? Int, size >= 2048 && size <= 8192, SecKeyIsAlgorithmSupported(key, .verify, .rsaSignatureMessagePKCS1v15SHA256) else { throw FloraOTAError("CONFIGURATION_INVALID") }
    self.appId = app; self.url = target; self.channel = channel; self.runtimeVersion = runtime; self.keyId = keyId; self.publicKey = key
    self.identity = hashHex(Data((runtime + "\u{0}" + channel + "\u{0}" + address + "\u{0}" + keyId).utf8) + bytes)
  }
  public var bridgeValue: [String: Any] { ["enabled": true, "appId": appId, "url": url.absoluteString, "channel": channel, "runtimeVersion": runtimeVersion, "platform": "ios"] }
}

public struct FloraOTAAsset {
  public let key: String, hash: String, digest: String, fileExtension: String, url: URL
  fileprivate init(_ input: Any, configuration: FloraOTAConfiguration, launch: Bool) throws {
    guard let object = input as? [String: Any], let key = object["key"] as? String, let hash = object["hash"] as? String, let rawURL = object["url"] as? String, let url = URL(string: rawURL), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), let contentType = object["contentType"] as? String else { throw FloraOTAError("MANIFEST_INVALID") }
    let ext = launch ? ".jsbundle" : (object["fileExtension"] as? String ?? "")
    try require(matches(key, "^[A-Za-z0-9_-]{1,128}$") && matches(hash, "^[A-Za-z0-9_-]{43}$") && matches(ext, "^\\.[A-Za-z0-9]{1,15}$"), "MANIFEST_INVALID")
    let decoded = Data(base64Encoded: hash.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + "=")
    try require(decoded?.count == 32 && decoded.map(base64URL) == hash, "MANIFEST_INVALID")
    try require(contentType.utf8.count <= 128 && (!launch || ["application/javascript", "text/javascript", "application/octet-stream"].contains(contentType)), "MANIFEST_INVALID")
    try require(rawURL.utf8.count <= 2048 && sameOrigin(configuration.url, url) && parts.user == nil && parts.password == nil && parts.query == nil && parts.fragment == nil, "ASSET_URL_INVALID")
    let prefix = "/updates/" + configuration.appId + "/assets/"
    let path = parts.percentEncodedPath
    try require(path.hasPrefix(prefix) && matches(String(path.dropFirst(prefix.count)), "^[a-f0-9]{64}$"), "ASSET_URL_INVALID")
    let digest = String(path.dropFirst(prefix.count))
    try require(decoded!.map { String(format: "%02x", $0) }.joined() == digest, "MANIFEST_INVALID")
    self.key = key; self.hash = hash; self.digest = digest; self.fileExtension = ext; self.url = url
  }
  fileprivate var fileName: String { digest + fileExtension }
}

public struct FloraOTAManifest {
  public let id: String, launchAsset: FloraOTAAsset, assets: [FloraOTAAsset]
  fileprivate let raw: Data, signature: String
  public init(data: Data, headers: [String: String], configuration: FloraOTAConfiguration) throws {
    try require(!data.isEmpty && data.count <= 256 * 1024, "MANIFEST_INVALID")
    guard let signature = headers.first(where: { $0.key.lowercased() == "expo-signature" })?.value, signature.utf8.count <= 2048 else { throw FloraOTAError("SIGNATURE_INVALID") }
    let fields = signature.split(separator: ",", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    var values: [String: String] = [:]
    for field in fields {
      guard let split = field.firstIndex(of: "="), field.distance(from: field.index(after: split), to: field.endIndex) >= 2, field[field.index(after: split)...].hasPrefix("\""), field.hasSuffix("\"") else { throw FloraOTAError("SIGNATURE_INVALID") }
      let key = String(field[..<split]), value = String(field[field.index(split, offsetBy: 2)..<field.index(before: field.endIndex)])
      try require(values[key] == nil && ["sig", "keyid", "alg"].contains(key), "SIGNATURE_INVALID"); values[key] = value
    }
    guard values.count == 3, values["keyid"] == configuration.keyId, values["alg"] == "rsa-v1_5-sha256", let encoded = values["sig"], let bytes = Data(base64Encoded: encoded), bytes.count >= 256 && bytes.count <= 1024 else { throw FloraOTAError("SIGNATURE_INVALID") }
    var error: Unmanaged<CFError>?
    let verified = SecKeyVerifySignature(configuration.publicKey, .rsaSignatureMessagePKCS1v15SHA256, data as CFData, bytes as CFData, &error)
    _ = error?.takeRetainedValue()
    try require(verified, "SIGNATURE_INVALID")
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let id = object["id"] as? String, let runtime = object["runtimeVersion"] as? String, let metadata = object["metadata"] as? [String: Any], let extra = object["extra"] as? [String: Any], let flora = extra["flora"] as? [String: Any], let list = object["assets"] as? [Any] else { throw FloraOTAError("MANIFEST_INVALID") }
    try require(matches(id, uuidPattern), "MANIFEST_INVALID")
    try require(runtime == configuration.runtimeVersion && metadata["appid"] as? String == configuration.appId && metadata["channel"] as? String == configuration.channel && flora["appId"] as? String == configuration.appId && flora["platform"] as? String == "ios", "UPDATE_INCOMPATIBLE")
    try require(list.count <= 64, "MANIFEST_INVALID")
    let launch = try FloraOTAAsset(object["launchAsset"] as Any, configuration: configuration, launch: true)
    let assets = try list.map { try FloraOTAAsset($0, configuration: configuration, launch: false) }
    try require(Set(([launch] + assets).map { $0.key }).count == assets.count + 1 && Set(([launch] + assets).map { $0.fileName }).count == assets.count + 1, "MANIFEST_INVALID")
    self.id = id; self.launchAsset = launch; self.assets = assets; self.raw = data; self.signature = signature
  }
  fileprivate func identity(_ config: FloraOTAConfiguration) -> [String: Any] { ["id": id, "appId": config.appId, "channel": config.channel, "runtimeVersion": config.runtimeVersion, "platform": "ios"] }
}

public struct FloraOTAHTTPResponse { public let status: Int; public let headers: [String: String]; public let body: Data; public init(status: Int, headers: [String: String], body: Data) { self.status = status; self.headers = headers; self.body = body } }
public protocol FloraOTATransport { func fetch(_ url: URL, headers: [String: String], maximumBytes: Int, destination: URL?) throws -> FloraOTAHTTPResponse }

private struct FloraOTAState: Codable {
  var schemaVersion = 1
  var activeId: String?; var previousId: String?; var pendingId: String?
  var launchedId: String?; var launchPending = false; var blockedIds: [String] = []
}

/// All executable selection and confirmation happen here, without React Native or JS dependencies.
public final class FloraOTAEngine {
  public let configuration: FloraOTAConfiguration
  private let transport: FloraOTATransport, root: URL, gate = NSLock()
  private var state: FloraOTAState, checked: FloraOTAManifest?, launchedURL: URL?, embeddedURL: URL?, rollback: [String: String]?
  private let manager = FileManager.default
  public init(configuration: FloraOTAConfiguration, storageRoot: URL, transport: FloraOTATransport = FloraOTAURLSessionTransport()) throws {
    self.configuration = configuration; self.transport = transport
    self.root = storageRoot.appendingPathComponent(configuration.appId, isDirectory: true).appendingPathComponent(configuration.identity, isDirectory: true)
    self.state = FloraOTAState()
    do {
      try manager.createDirectory(at: storageRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try assertDirectory(storageRoot)
      let appRoot = storageRoot.appendingPathComponent(configuration.appId, isDirectory: true)
      if !manager.fileExists(atPath: appRoot.path) { try manager.createDirectory(at: appRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }; try assertDirectory(appRoot)
      if !manager.fileExists(atPath: root.path) { try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }; try assertDirectory(root)
      // One installed binary owns this app's engine. Retired native runtime/trust
      // namespaces are unusable and must not accumulate across binary upgrades.
      let namespaces = try manager.contentsOfDirectory(at: appRoot, includingPropertiesForKeys: nil)
      try require(namespaces.count <= 64, "STORAGE_INVALID")
      for old in namespaces where old.lastPathComponent != configuration.identity && matches(old.lastPathComponent, "^[a-f0-9]{64}$") { try manager.removeItem(at: old) }
      let pointer = root.appendingPathComponent("state.json")
      if manager.fileExists(atPath: pointer.path) {
        let data = try readRegular(pointer, maximum: 16384)
        let state = try JSONDecoder().decode(FloraOTAState.self, from: data)
        try require(state.schemaVersion == 1 && state.blockedIds.count <= 32 && ([state.activeId, state.previousId, state.pendingId, state.launchedId].compactMap { $0 } + state.blockedIds).allSatisfy { matches($0, uuidPattern) }, "STORAGE_INVALID")
        self.state = state
      }
      var mutable = root; var resources = URLResourceValues(); resources.isExcludedFromBackup = true; try? mutable.setResourceValues(resources)
    } catch { throw FloraOTAError("STORAGE_INVALID") }
  }
  private func exclusive<T>(_ work: () throws -> T) throws -> T { try require(gate.try(), "BUSY"); defer { gate.unlock() }; do { return try work() } catch let error as FloraOTAError { throw error } catch { throw FloraOTAError("STORAGE_FAILURE") } }
  private func assertDirectory(_ url: URL) throws { let attr = try manager.attributesOfItem(atPath: url.path); try require(attr[.type] as? FileAttributeType == .typeDirectory, "STORAGE_INVALID") }
  private func readRegular(_ url: URL, maximum: Int) throws -> Data {
    let attr = try manager.attributesOfItem(atPath: url.path)
    let size = (attr[.size] as? NSNumber)?.intValue ?? Int.max
    try require(attr[.type] as? FileAttributeType == .typeRegular && size <= maximum, "STORAGE_INVALID")
    let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW)
    try require(descriptor >= 0, "STORAGE_INVALID")
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
    let data = try handle.read(upToCount: maximum + 1) ?? Data()
    try require(data.count <= maximum && data.count == size, "STORAGE_INVALID")
    return data
  }
  private func syncDirectory(_ url: URL) throws {
    let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    try require(descriptor >= 0, "STORAGE_FAILURE"); defer { close(descriptor) }
    try require(fsync(descriptor) == 0, "STORAGE_FAILURE")
  }
  private func durableWrite(_ data: Data, _ url: URL) throws {
    try data.write(to: url, options: .atomic)
    try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let handle = try FileHandle(forWritingTo: url); try handle.synchronize(); try handle.close()
    try syncDirectory(url.deletingLastPathComponent())
  }
  private func persist() throws {
    let pointer = root.appendingPathComponent("state.json")
    let previous = try? readRegular(pointer, maximum: 16384)
    do { try durableWrite(JSONEncoder().encode(state), pointer) }
    catch {
      // Directory-sync rejection must not leave this process believing a new
      // pointer committed. Restore the prior atomic value before rejecting.
      if let previous = previous { state = (try? JSONDecoder().decode(FloraOTAState.self, from: previous)) ?? FloraOTAState(); try? durableWrite(previous, pointer) }
      else { state = FloraOTAState(); try? manager.removeItem(at: pointer); try? syncDirectory(root) }
      throw error
    }
  }
  private func directory(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
  private func verifyAsset(_ asset: FloraOTAAsset, in directory: URL) throws -> Int {
    let file = directory.appendingPathComponent(asset.fileName)
    let attr = try manager.attributesOfItem(atPath: file.path)
    let size = (attr[.size] as? NSNumber)?.intValue ?? 0
    try require(attr[.type] as? FileAttributeType == .typeRegular && size > 0 && size <= 16 * 1024 * 1024, "ASSET_INVALID")
    let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW)
    try require(descriptor >= 0, "ASSET_INVALID")
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? handle.close() }
    var hash = SHA256(); var read = 0
    while let bytes = try handle.read(upToCount: 64 * 1024), !bytes.isEmpty { read += bytes.count; try require(read <= size && read <= 16 * 1024 * 1024, "ASSET_INVALID"); hash.update(data: bytes) }
    try require(read == size && base64URL(Data(hash.finalize())) == asset.hash, "ASSET_HASH_MISMATCH")
    return size
  }
  private func installed(_ id: String) throws -> FloraOTAManifest {
    try require(matches(id, uuidPattern), "STORAGE_INVALID")
    let folder = directory(id); try assertDirectory(folder)
    let data = try readRegular(folder.appendingPathComponent("manifest.json"), maximum: 256 * 1024)
    guard let signature = String(data: try readRegular(folder.appendingPathComponent("signature.txt"), maximum: 2048), encoding: .utf8) else { throw FloraOTAError("STORAGE_INVALID") }
    let manifest = try FloraOTAManifest(data: data, headers: ["expo-signature": signature], configuration: configuration)
    try require(manifest.id == id, "STORAGE_INVALID")
    var total = 0; for asset in [manifest.launchAsset] + manifest.assets { total += try verifyAsset(asset, in: folder); try require(total <= 64 * 1024 * 1024, "ASSET_LIMIT") }
    return manifest
  }
  private func block(_ id: String) { state.blockedIds.removeAll { $0 == id }; state.blockedIds.append(id); if state.blockedIds.count > 32 { state.blockedIds.removeFirst(state.blockedIds.count - 32) } }
  private func cleanup() throws {
    let retained = Set([state.activeId, state.previousId, state.pendingId].compactMap { $0 })
    let children = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    try require(children.count <= 128, "STORAGE_INVALID")
    for url in children {
      let name = url.lastPathComponent
      if (matches(name, uuidPattern) && !retained.contains(name)) || name.hasPrefix("staging-") { try manager.removeItem(at: url) }
    }
    try syncDirectory(root)
  }
  public func check() throws -> [String: Any] { try exclusive {
    checked = nil
    let response = try transport.fetch(configuration.url, headers: ["Accept":"application/expo+json", "expo-protocol-version":"1", "expo-platform":"ios", "expo-runtime-version":configuration.runtimeVersion, "expo-channel-name":configuration.channel, "expo-expect-signature":"sig, keyid=\"\(configuration.keyId)\", alg=\"rsa-v1_5-sha256\""], maximumBytes: 256 * 1024, destination: nil)
    if response.status == 204 { return ["available":false] }
    try require(response.status == 200, "NETWORK_ERROR")
    let manifest = try FloraOTAManifest(data: response.body, headers: response.headers, configuration: configuration)
    if manifest.id == state.activeId || state.blockedIds.contains(manifest.id) { return ["available":false] }
    checked = manifest; return ["available":true, "update":manifest.identity(configuration)]
  } }
  public func download() throws -> [String: Any] { try exclusive {
    guard let manifest = checked else { throw FloraOTAError("UPDATE_NOT_CHECKED") }
    checked = nil
    try cleanup()
    let cached = directory(manifest.id)
    if manager.fileExists(atPath: cached.path) {
      let verified = try installed(manifest.id)
      try require(verified.raw == manifest.raw, "MANIFEST_INVALID")
      let previous = state; state.pendingId = manifest.id
      do { try persist() } catch { state = previous; throw error }
      try cleanup()
      return ["downloaded":true, "update":manifest.identity(configuration)]
    }
    let stage = root.appendingPathComponent("staging-" + UUID().uuidString.lowercased(), isDirectory: true)
    try manager.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? manager.removeItem(at: stage) }
    var total = 0; let deadline = Date().addingTimeInterval(300)
    for asset in [manifest.launchAsset] + manifest.assets {
      try require(Date() < deadline, "NETWORK_TIMEOUT")
      let file = stage.appendingPathComponent(asset.fileName)
      let response = try transport.fetch(asset.url, headers: ["Accept":"application/octet-stream"], maximumBytes: min(16 * 1024 * 1024, 64 * 1024 * 1024 - total), destination: file)
      try require(response.status == 200, "NETWORK_ERROR")
      try require(Date() < deadline, "NETWORK_TIMEOUT")
      total += try verifyAsset(asset, in: stage); try require(total <= 64 * 1024 * 1024, "ASSET_LIMIT")
      let handle = try FileHandle(forWritingTo: file); try handle.synchronize(); try handle.close()
    }
    try durableWrite(manifest.raw, stage.appendingPathComponent("manifest.json")); try durableWrite(Data(manifest.signature.utf8), stage.appendingPathComponent("signature.txt"))
    let target = directory(manifest.id)
    if manager.fileExists(atPath: target.path) { _ = try installed(manifest.id) } else { try syncDirectory(stage); try manager.moveItem(at: stage, to: target); try syncDirectory(root) }
    let previous = state; state.pendingId = manifest.id
    do { try persist() } catch { state = previous; throw error }
    try cleanup()
    return ["downloaded":true, "update":manifest.identity(configuration)]
  } }
  private func selectUpdate(_ id: String, candidate: Bool) throws -> URL {
    let manifest = try installed(id)
    let previous = state
    if candidate { state.previousId = state.activeId; state.activeId = id; state.pendingId = nil; state.launchPending = true }
    state.launchedId = id
    do { try persist() } catch { state = previous; throw error }
    let selected = directory(id).appendingPathComponent(manifest.launchAsset.fileName); launchedURL = selected; return selected
  }
  public func launch(embedded: URL) throws -> URL { try exclusive {
    if let selected = launchedURL { return selected }
    embeddedURL = embedded
    if state.launchPending, let failed = state.launchedId {
      block(failed); state.activeId = state.previousId; state.previousId = nil; state.pendingId = nil; state.launchedId = nil; state.launchPending = false
      rollback = ["updateId":failed, "reason":"UNCONFIRMED_LAUNCH"]; try persist()
    }
    if let active = state.activeId {
      do { return try selectUpdate(active, candidate: false) }
      catch { block(active); state.activeId = state.previousId; state.previousId = nil; state.launchPending = false; rollback = ["updateId":active, "reason":"STORED_UPDATE_INVALID"]; try persist()
        if let fallback = state.activeId, let selected = try? selectUpdate(fallback, candidate: false) { return selected }
        state.activeId = nil
      }
    }
    state.launchedId = nil; state.launchPending = false; try persist(); launchedURL = embedded; try cleanup(); return embedded
  } }
  public func activateDownloaded(expectedUpdateId: String) throws -> URL { try exclusive {
    try require(matches(expectedUpdateId, uuidPattern) && state.pendingId == expectedUpdateId && !state.blockedIds.contains(expectedUpdateId), "UPDATE_NOT_DOWNLOADED")
    try require(!state.launchPending, "LAUNCH_UNCONFIRMED")
    return try selectUpdate(expectedUpdateId, candidate: true)
  } }
  public func markLaunchSuccessful(expectedUpdateId: String?) throws { try exclusive {
    try require(launchedURL != nil && state.launchedId == expectedUpdateId, "LAUNCH_ID_MISMATCH")
    if let expected = expectedUpdateId { try require(matches(expected, uuidPattern) && state.activeId == expected, "LAUNCH_ID_MISMATCH"); _ = try installed(expected) }
    state.launchPending = false; try persist(); try cleanup()
  } }
  public func getLaunchInfo() throws -> [String: Any] { try exclusive {
    var assets: [String: String] = [:]
    if let id = state.launchedId, launchedURL != nil { let manifest = try installed(id); for asset in manifest.assets { assets[asset.key] = directory(id).appendingPathComponent(asset.fileName).absoluteString } }
    var result: [String: Any] = ["appId":configuration.appId, "runtimeVersion":configuration.runtimeVersion, "source":state.launchedId == nil ? "embedded" : "update", "updateId":state.launchedId as Any? ?? NSNull(), "assets":assets]
    if let rollback = rollback { result["rollback"] = rollback }
    return result
  } }
}
