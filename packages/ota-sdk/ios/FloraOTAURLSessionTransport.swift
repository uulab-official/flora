import Foundation

/// Ephemeral requests use platform TLS validation and reject every redirect.
/// Asset data goes straight to a private staging file; limits apply before buffering.
public final class FloraOTAURLSessionTransport: FloraOTATransport {
  public init() {}
  public func fetch(_ url: URL, headers: [String: String], maximumBytes: Int, destination: URL?) throws -> FloraOTAHTTPResponse {
    guard url.scheme == "https", maximumBytes > 0 else { throw FloraOTAError("NETWORK_ERROR") }
    let receiver = FloraOTAResponseReceiver(maximumBytes: maximumBytes, destination: destination)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30; configuration.timeoutIntervalForResource = 60
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
    configuration.httpMaximumConnectionsPerHost = 1
    let session = URLSession(configuration: configuration, delegate: receiver, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: url); request.httpMethod = "GET"; request.allHTTPHeaderFields = headers
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let task = session.dataTask(with: request); task.resume()
    guard receiver.completion.wait(timeout: .now() + 65) == .success else { task.cancel(); throw FloraOTAError("NETWORK_TIMEOUT") }
    if let error = receiver.failure { throw error }
    guard let status = receiver.status else { throw FloraOTAError("NETWORK_ERROR") }
    return FloraOTAHTTPResponse(status: status, headers: receiver.headers, body: receiver.body)
  }
}

private final class FloraOTAResponseReceiver: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  let completion = DispatchSemaphore(value: 0)
  let maximumBytes: Int, destination: URL?
  var status: Int?, headers: [String: String] = [:], body = Data(), failure: FloraOTAError?
  private var handle: FileHandle?, count = 0
  init(maximumBytes: Int, destination: URL?) { self.maximumBytes = maximumBytes; self.destination = destination }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { failure = FloraOTAError("REDIRECT_REJECTED"); completionHandler(nil) }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, response.url?.scheme == "https" else { failure = FloraOTAError("NETWORK_ERROR"); completionHandler(.cancel); return }
    status = response.statusCode
    for (key, value) in response.allHeaderFields { if let key = key as? String, let value = value as? String { headers[key.lowercased()] = value } }
    if response.expectedContentLength > Int64(maximumBytes) { failure = FloraOTAError("RESPONSE_TOO_LARGE"); completionHandler(.cancel); return }
    if let destination = destination {
      guard response.statusCode == 200 else { failure = FloraOTAError("NETWORK_ERROR"); completionHandler(.cancel); return }
      guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { failure = FloraOTAError("STORAGE_FAILURE"); completionHandler(.cancel); return }
      do { handle = try FileHandle(forWritingTo: destination) } catch { failure = FloraOTAError("STORAGE_FAILURE"); completionHandler(.cancel); return }
    }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard failure == nil else { dataTask.cancel(); return }
    count += data.count
    guard count <= maximumBytes else { failure = FloraOTAError("RESPONSE_TOO_LARGE"); dataTask.cancel(); return }
    do { if let handle = handle { try handle.write(contentsOf: data) } else { body.append(data) } }
    catch { failure = FloraOTAError("STORAGE_FAILURE"); dataTask.cancel() }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    do { try handle?.synchronize(); try handle?.close() } catch { failure = FloraOTAError("STORAGE_FAILURE") }
    handle = nil
    if error != nil && failure == nil { failure = FloraOTAError("NETWORK_ERROR") }
    completion.signal()
  }
}
