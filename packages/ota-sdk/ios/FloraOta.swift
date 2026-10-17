import Foundation
import React

/// Add this binary-owned selector to AppDelegate.bundleURL(). Invalid OTA settings
/// or cache state always preserve the application's embedded bundle.
@objc(FloraOTAController)
public final class FloraOTAController: NSObject {
  fileprivate static let queue = DispatchQueue(label: "dev.flora.ota.engine", qos: .utility)
  private static var instance: FloraOTAEngine?
  private static var initializationError: FloraOTAError?
  private static var initialized = false
  private static var selectedURL: URL?
  fileprivate static func engine() throws -> FloraOTAEngine {
    if !initialized {
      initialized = true
      do {
        let configuration = try FloraOTAConfiguration(dictionary: Bundle.main.infoDictionary ?? [:])
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        instance = try FloraOTAEngine(configuration: configuration, storageRoot: support.appendingPathComponent("FloraOTA", isDirectory: true))
      } catch let error as FloraOTAError { initializationError = error }
      catch { initializationError = FloraOTAError("CONFIGURATION_INVALID") }
    }
    if let engine = instance { return engine }
    throw initializationError ?? FloraOTAError("CONFIGURATION_INVALID")
  }
  @objc(bundleURLWithEmbedded:)
  public static func bundleURL(embedded: URL) -> URL {
    queue.sync {
      if let selected = selectedURL { return selected }
      do { let selected = try engine().launch(embedded: embedded); selectedURL = selected; return selected }
      catch let error as FloraOTAError { instance = nil; initializationError = error; selectedURL = embedded; return embedded }
      catch { instance = nil; initializationError = FloraOTAError("STORAGE_FAILURE"); selectedURL = embedded; return embedded }
    }
  }
  fileprivate static func apply(_ id: String) throws -> URL { let selected = try engine().activateDownloaded(expectedUpdateId: id); selectedURL = selected; return selected }
}

@objc(FloraOta)
public final class FloraOta: NSObject {
  @objc public static func requiresMainQueueSetup() -> Bool { false }
  @objc public func constantsToExport() -> [String: Any] {
    FloraOTAController.queue.sync {
      do {
        let engine = try FloraOTAController.engine()
        return ["initialConfiguration": engine.configuration.bridgeValue, "initialLaunchInfo": try engine.getLaunchInfo()]
      } catch { return [:] }
    }
  }
  private func run(_ resolve: @escaping RCTPromiseResolveBlock, _ reject: @escaping RCTPromiseRejectBlock, _ operation: @escaping () throws -> Any) {
    FloraOTAController.queue.async {
      do { resolve(try operation()) }
      catch let error as FloraOTAError { reject(error.code, error.code, nil) }
      catch { reject("NATIVE_ENGINE_ERROR", "NATIVE_ENGINE_ERROR", nil) }
    }
  }
  @objc(getNativeConfiguration:rejecter:)
  public func getNativeConfiguration(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { run(resolve, reject) { try FloraOTAController.engine().configuration.bridgeValue } }
  @objc(check:rejecter:)
  public func check(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { run(resolve, reject) { try FloraOTAController.engine().check() } }
  @objc(download:rejecter:)
  public func download(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { run(resolve, reject) { try FloraOTAController.engine().download() } }
  @objc(getLaunchInfo:rejecter:)
  public func getLaunchInfo(_ resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { run(resolve, reject) { try FloraOTAController.engine().getLaunchInfo() } }
  @objc(markLaunchSuccessful:resolver:rejecter:)
  public func markLaunchSuccessful(_ expectedUpdateId: String?, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) { run(resolve, reject) { try FloraOTAController.engine().markLaunchSuccessful(expectedUpdateId: expectedUpdateId); return NSNull() } }
  @objc(reload:resolver:rejecter:)
  public func reload(_ expectedUpdateId: String, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    FloraOTAController.queue.async {
      do {
        let selected = try FloraOTAController.apply(expectedUpdateId)
        DispatchQueue.main.async { resolve(NSNull()); RCTReloadCommandSetBundleURL(selected); RCTTriggerReloadCommandListeners("Flora OTA") }
      } catch let error as FloraOTAError { reject(error.code, error.code, nil) }
      catch { reject("NATIVE_ENGINE_ERROR", "NATIVE_ENGINE_ERROR", nil) }
    }
  }
}
