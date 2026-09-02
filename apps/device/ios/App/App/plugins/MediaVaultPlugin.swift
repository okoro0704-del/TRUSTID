import Foundation
import LocalAuthentication
import Security
import Capacitor
import CryptoKit

/**
 * AES-GCM vault with DEK protected by Keychain access control (biometryCurrentSet).
 * Files stored in Application Support — not indexed by Photos.
 */
@objc(TrustIdMediaVaultPlugin)
public class TrustIdMediaVaultPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdMediaVaultPlugin"
  public let jsName = "TrustIdMediaVault"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "importMedia", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "decrypt", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
  ]

  private let catalogKey = "trustid.vault.catalog"
  private let keyTag = "com.trustid.device.vault.dek".data(using: .utf8)!

  @objc func list(_ call: CAPPluginCall) {
    let items = loadCatalog()
    call.resolve(["items": items])
  }

  @objc func importMedia(_ call: CAPPluginCall) {
    guard let b64 = call.getString("bytesBase64"),
          let data = Data(base64Encoded: b64) else {
      call.reject("bytesBase64 required")
      return
    }
    let mime = call.getString("mimeType") ?? "application/octet-stream"
    let name = call.getString("displayName") ?? "media"

    do {
      let key = try loadOrCreateDek()
      let sealed = try AES.GCM.seal(data, using: key)
      guard let combined = sealed.combined else {
        call.reject("seal failed")
        return
      }
      let id = UUID().uuidString
      let url = try vaultDir().appendingPathComponent("\(id).tvm")
      try combined.write(to: url, options: .completeFileProtection)

      let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      let kind = mime.hasPrefix("image/") ? "image" : mime.hasPrefix("video/") ? "video" : "other"
      var item: [String: Any] = [
        "id": id,
        "kind": kind,
        "mimeType": mime,
        "byteLength": data.count,
        "contentHash": hash,
        "createdAt": ISO8601DateFormatter().string(from: Date()),
        "displayName": name,
      ]
      var catalog = loadCatalog()
      catalog.append(item)
      saveCatalog(catalog)

      call.resolve([
        "item": item,
        "sourceWiped": false,
        "wipeNote": "iOS PhotoKit deletion requires explicit user library write permission; prefer import-without-leaving-originals via Files/document picker into app container.",
      ])
    } catch {
      call.reject("import failed: \(error.localizedDescription)")
    }
  }

  @objc func decrypt(_ call: CAPPluginCall) {
    guard let id = call.getString("id") else {
      call.reject("id required")
      return
    }
    do {
      let key = try loadOrCreateDek()
      let url = try vaultDir().appendingPathComponent("\(id).tvm")
      let combined = try Data(contentsOf: url)
      let box = try AES.GCM.SealedBox(combined: combined)
      let plain = try AES.GCM.open(box, using: key)
      let meta = loadCatalog().first { ($0["id"] as? String) == id }
      call.resolve([
        "bytesBase64": plain.base64EncodedString(),
        "mimeType": meta?["mimeType"] as? String ?? "application/octet-stream",
        "displayName": meta?["displayName"] as? String ?? "media",
      ])
    } catch {
      call.reject("decrypt failed: \(error.localizedDescription)")
    }
  }

  @objc func remove(_ call: CAPPluginCall) {
    guard let id = call.getString("id") else {
      call.reject("id required")
      return
    }
    let url = try? vaultDir().appendingPathComponent("\(id).tvm")
    try? url.flatMap { try FileManager.default.removeItem(at: $0) }
    let next = loadCatalog().filter { ($0["id"] as? String) != id }
    saveCatalog(next)
    call.resolve()
  }

  private func vaultDir() throws -> URL {
    let base = try FileManager.default.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true,
    )
    let dir = base.appendingPathComponent("vault", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private func loadCatalog() -> [[String: Any]] {
    guard let data = UserDefaults.standard.data(forKey: catalogKey),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
      return []
    }
    return obj
  }

  private func saveCatalog(_ items: [[String: Any]]) {
    if let data = try? JSONSerialization.data(withJSONObject: items) {
      UserDefaults.standard.set(data, forKey: catalogKey)
    }
  }

  private func loadOrCreateDek() throws -> SymmetricKey {
    // Prefer Keychain-backed 256-bit key with biometry access control.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: "vault-dek",
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data {
      return SymmetricKey(data: data)
    }

    let key = SymmetricKey(size: .bits256)
    let keyData = key.withUnsafeBytes { Data($0) }

    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.biometryCurrentSet, .privateKeyUsage],
      &error,
    ) else {
      throw error!.takeRetainedValue() as Error
    }

    let add: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: "vault-dek",
      kSecValueData as String: keyData,
      kSecAttrAccessControl as String: access,
    ]
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw NSError(domain: "TrustID", code: Int(addStatus))
    }
    return key
  }
}
