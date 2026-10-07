import Capacitor
import Foundation
import WebKit

/// Serves the biometric engine release that ships inside the app
/// (public/biometric/<sha256[0..16]>/<file>, staged by
/// scripts/stage-biometric-assets.mjs) at trustid-native://local/biometric/...
///
/// WKWebView cannot intercept the https origin the shell loads, so the files
/// are exposed on a registered custom scheme. The web SDK verifies the SHA-256
/// of every byte; this handler only has to be strict about which paths it
/// opens. Anything else is a 404, never another file of the app.
final class BiometricAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "trustid-native"
    static let baseUrl = "trustid-native://local/"
    static let apiVersion = 1

    private static let root: URL? = Bundle.main.resourceURL?.appendingPathComponent("public/biometric", isDirectory: true)
    private static let dirPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{16}$")
    private static let filePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$")

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// Bundled file for a request path "/biometric/<sha16>/<file>", or nil.
    static func resolve(path: String) -> URL? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // ["", "biometric", dir, file]
        guard parts.count == 4, parts[0].isEmpty, parts[1] == "biometric" else { return nil }
        let dir = parts[2], file = parts[3]
        guard matches(dirPattern, dir), matches(filePattern, file), !file.contains(".."), !file.hasSuffix(".gz"), !file.hasSuffix(".gz.bin") else { return nil }
        return root?.appendingPathComponent(dir, isDirectory: true).appendingPathComponent(file, isDirectory: false)
    }

    /// Content directories (sha256 prefixes) present in this build.
    static func bundledDirs() -> [String] {
        guard let root = root,
              let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return [] }
        return names.filter { matches(dirPattern, $0) }.sorted()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        // The page is on another origin (the live TrustID host): allow it to read the bytes.
        let origin = urlSchemeTask.request.value(forHTTPHeaderField: "Origin") ?? "*"
        var headers = [
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Access-Control-Allow-Origin": origin,
        ]
        guard let file = Self.resolve(path: url.path),
              let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            headers["Content-Type"] = "text/plain"
            let res = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: headers)!
            urlSchemeTask.didReceive(res)
            urlSchemeTask.didReceive(Data())
            urlSchemeTask.didFinish()
            return
        }
        headers["Content-Type"] = "application/octet-stream"
        headers["Content-Length"] = String(data.count)
        let res = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(res)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

/// NativeBiometricAssetBridge for @trustid/sdk (same contract as Android).
@objc(BiometricAssetsPlugin)
public class BiometricAssetsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricAssetsPlugin"
    public let jsName = "TrustIdBiometricAssets"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getBundle", returnType: CAPPluginReturnPromise),
    ]

    @objc func getBundle(_ call: CAPPluginCall) {
        call.resolve([
            "apiVersion": BiometricAssetSchemeHandler.apiVersion,
            "baseUrl": BiometricAssetSchemeHandler.baseUrl,
            "assets": BiometricAssetSchemeHandler.bundledDirs(),
        ])
    }
}
