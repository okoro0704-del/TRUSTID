import Foundation
import LocalAuthentication
import Security
import UIKit
import Capacitor

/**
 * iOS silent auth: Secure Enclave / Keychain ES256 key + biometric unlock.
 * Device metadata is collected automatically (no user text input).
 */
@objc(TrustIdSilentAuthPlugin)
public class TrustIdSilentAuthPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdSilentAuthPlugin"
  public let jsName = "TrustIdSilentAuth"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getDeviceMeta", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "ensureHardwareKey", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "signChallenge", returnType: CAPPluginReturnPromise),
  ]

  private let keyTag = "com.trustid.silent.auth.v1"
  private let keyId = "ios-silent-v1"

  @objc func getDeviceMeta(_ call: CAPPluginCall) {
    let model = UIDevice.current.model
    let version = UIDevice.current.systemVersion
    call.resolve([
      "platform": "ios",
      "model": model,
      "osVersion": version,
    ])
  }

  @objc func ensureHardwareKey(_ call: CAPPluginCall) {
    do {
      let pub = try ensureKeyAndExportSpki()
      call.resolve([
        "keyId": keyId,
        "publicKeySpki": pub,
        "algorithm": "ES256",
      ])
    } catch {
      call.reject(error.localizedDescription)
    }
  }

  @objc func signChallenge(_ call: CAPPluginCall) {
    guard let challenge = call.getString("challenge"), !challenge.isEmpty else {
      call.reject("challenge is required")
      return
    }
    let reason = call.getString("reason") ?? "Sign in to Trust ID"

    DispatchQueue.global(qos: .userInitiated).async {
      do {
        _ = try self.ensureKeyAndExportSpki()
        guard let privateKey = self.loadPrivateKey() else {
          throw NSError(domain: "TrustIdSilentAuth", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Private key missing",
          ])
        }

        let context = LAContext()
        context.localizedReason = reason
        var authError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &authError) else {
          throw authError ?? NSError(domain: "TrustIdSilentAuth", code: 2, userInfo: [
            NSLocalizedDescriptionKey: "Biometrics unavailable",
          ])
        }

        let semaphore = DispatchSemaphore(value: 0)
        var authOk = false
        var authFail: Error?
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, error in
          authOk = success
          authFail = error
          semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 60)
        if !authOk {
          throw authFail ?? NSError(domain: "TrustIdSilentAuth", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "Biometric cancelled",
          ])
        }

        let data = Data(challenge.utf8)
        var error: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
          privateKey,
          .ecdsaSignatureMessageX962SHA256,
          data as CFData,
          &error,
        ) as Data? else {
          throw (error?.takeRetainedValue() as Error?) ?? NSError(
            domain: "TrustIdSilentAuth",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "Sign failed"],
          )
        }

        DispatchQueue.main.async {
          call.resolve([
            "keyId": self.keyId,
            "signature": self.base64url(signature),
          ])
        }
      } catch {
        DispatchQueue.main.async {
          call.reject(error.localizedDescription)
        }
      }
    }
  }

  private func ensureKeyAndExportSpki() throws -> String {
    if let existing = loadPrivateKey(), let pub = SecKeyCopyPublicKey(existing) {
      return try exportSpki(pub)
    }
    return try generateKeyPair()
  }

  private func generateKeyPair() throws -> String {
    let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      nil,
    )!

    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag.data(using: .utf8)!,
        kSecAttrAccessControl as String: access,
      ],
    ]
    #if !targetEnvironment(simulator)
    attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    #endif

    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw (error?.takeRetainedValue() as Error?) ?? NSError(
        domain: "TrustIdSilentAuth",
        code: 5,
        userInfo: [NSLocalizedDescriptionKey: "Key generation failed"],
      )
    }
    guard let pub = SecKeyCopyPublicKey(privateKey) else {
      throw NSError(domain: "TrustIdSilentAuth", code: 6, userInfo: [
        NSLocalizedDescriptionKey: "Public key missing",
      ])
    }
    return try exportSpki(pub)
  }

  private func loadPrivateKey() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag.data(using: .utf8)!,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return nil }
    return (item as! SecKey)
  }

  private func exportSpki(_ key: SecKey) throws -> String {
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(key, &error) as Data? else {
      throw (error?.takeRetainedValue() as Error?) ?? NSError(
        domain: "TrustIdSilentAuth",
        code: 7,
        userInfo: [NSLocalizedDescriptionKey: "Export failed"],
      )
    }
    // SecKeyCopyExternalRepresentation for EC public keys returns ANSI X9.63
    // (0x04 || X || Y). Wrap into SPKI for Node crypto createPublicKey.
    let spki = wrapEcPublicKeySpki(data)
    return base64url(spki)
  }

  /// Minimal SPKI wrapper for P-256 uncompressed point.
  private func wrapEcPublicKeySpki(_ x963: Data) -> Data {
    // AlgorithmIdentifier for id-ecPublicKey + prime256v1
    let algId: [UInt8] = [
      0x30, 0x13,
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    ]
    var bitString = Data([0x03, UInt8(x963.count + 1), 0x00])
    bitString.append(x963)
    var inner = Data(algId)
    inner.append(bitString)
    var spki = Data([0x30, UInt8(inner.count)])
    spki.append(inner)
    return spki
  }

  private func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
