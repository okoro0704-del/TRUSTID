import Foundation
import LocalAuthentication
import Security
import Capacitor
import CryptoKit

/**
 * AES-GCM Media Locker with chunked `.tidvault` eSFS envelopes.
 * Files live in Application Support — not indexed by Photos.
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
    call.resolve(["items": loadCatalog()])
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
      let envelope = try TidVaultFormat.encryptChunked(plain: data, wrappingKey: key)
      let id = UUID().uuidString
      let url = try vaultDir().appendingPathComponent("\(id).\(TidVaultFormat.ext)")
      try envelope.write(to: url, options: .completeFileProtection)

      let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      let kind = mime.hasPrefix("image/") ? "image" : mime.hasPrefix("video/") ? "video" : "other"
      let item: [String: Any] = [
        "id": id,
        "kind": kind,
        "mimeType": mime,
        "byteLength": envelope.count,
        "contentHash": hash,
        "createdAt": ISO8601DateFormatter().string(from: Date()),
        "displayName": name,
        "format": "tidvault",
      ]
      var catalog = loadCatalog()
      catalog.append(item)
      saveCatalog(catalog)

      call.resolve([
        "item": item,
        "sourceWiped": false,
        "wipeNote": "iOS PhotoKit deletion requires explicit user library write permission; prefer import into app container.",
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
      let dir = try vaultDir()
      let tid = dir.appendingPathComponent("\(id).\(TidVaultFormat.ext)")
      let legacy = dir.appendingPathComponent("\(id).tvm")
      let url: URL
      if FileManager.default.fileExists(atPath: tid.path) {
        url = tid
      } else if FileManager.default.fileExists(atPath: legacy.path) {
        url = legacy
      } else {
        call.reject("Ciphertext missing")
        return
      }
      let blob = try Data(contentsOf: url)
      let plain: Data
      if url.pathExtension == TidVaultFormat.ext ||
          String(data: blob.prefix(5), encoding: .utf8) == TidVaultFormat.magic {
        plain = try TidVaultFormat.decryptChunked(blob: blob, wrappingKey: key)
      } else {
        let box = try AES.GCM.SealedBox(combined: blob)
        plain = try AES.GCM.open(box, using: key)
      }
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
    if let dir = try? vaultDir() {
      try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).\(TidVaultFormat.ext)"))
      try? FileManager.default.removeItem(at: dir.appendingPathComponent("\(id).tvm"))
    }
    saveCatalog(loadCatalog().filter { ($0["id"] as? String) != id })
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
      [.biometryCurrentSet],
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
