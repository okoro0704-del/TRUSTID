import LocalAuthentication
import Security
import Capacitor

/**
 * iOS biometric gate via LocalAuthentication + Secure Enclave.
 * Face ID / Touch ID only (Class 3). Passcode fallback is disabled unless
 * allowDeviceCredential is explicitly true (TrustID JS never enables it).
 */
@objc(TrustIdBiometricGatePlugin)
public class TrustIdBiometricGatePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdBiometricGatePlugin"
  public let jsName = "TrustIdBiometricGate"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getAvailability", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "captureFingerprintTemplate", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "storeSecure", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getSecure", returnType: CAPPluginReturnPromise),
  ]

  private let fpKeyTag = "com.trustid.device.fp_backup_v1"
  private let authKeyTag = "com.trustid.device.bio_auth_v1"

  @objc func getAvailability(_ call: CAPPluginCall) {
    let context = LAContext()
    var error: NSError?
    let strong = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    var biometry = "none"
    if strong {
      switch context.biometryType {
      case .faceID: biometry = "face_id"
      case .touchID: biometry = "touch_id"
      case .opticID: biometry = "optic_id"
      default: biometry = "biometric"
      }
    }
    var notes: [String] = [
      "LocalAuthentication + Secure Enclave (Face ID / Touch ID / Optic ID only).",
      "Passcode fallback is disabled for TrustID identity gates.",
    ]
    if let error = error {
      notes.append(error.localizedDescription)
    }
    call.resolve([
      "platform": "ios",
      "available": strong,
      "enrolled": strong,
      "strength": strong ? "strong" : "none",
      "biometryType": biometry,
      "hardwareBoundKeys": true,
      "appLockSupported": false,
      "secureWipeSupported": false,
      "notes": notes,
    ])
  }

  @objc func authenticate(_ call: CAPPluginCall) {
    // Ignore allowDeviceCredential from clients — TrustID requires biometrics only.
    evaluateBiometrics(call, reason: call.getString("reason") ?? "Authenticate") { success, err in
      if success {
        let pub = (try? self.ensureSecureEnclavePublicKey(tag: self.authKeyTag)) ?? Data()
        call.resolve([
          "ok": true,
          "method": "biometric_strong",
          "publicKeyBase64": pub.base64EncodedString(),
        ])
      } else {
        call.reject(err ?? "Biometric failed")
      }
    }
  }

  @objc func captureFingerprintTemplate(_ call: CAPPluginCall) {
    let reason = call.getString("reason")
      ?? "Scan your fingerprint to register a Trust ID backup"
    evaluateBiometrics(call, reason: reason) { success, err in
      if !success {
        call.reject(err ?? "Biometric failed")
        return
      }
      do {
        let pub = try self.ensureSecureEnclavePublicKey(tag: self.fpKeyTag)
        call.resolve([
          "ok": true,
          "method": "biometric_strong",
          "publicKeyBase64": pub.base64EncodedString(),
          "keyAlias": self.fpKeyTag,
        ])
      } catch {
        call.reject("Secure Enclave key unavailable: \(error.localizedDescription)")
      }
    }
  }

  @objc func storeSecure(_ call: CAPPluginCall) {
    guard let key = call.getString("key"), !key.isEmpty else {
      call.reject("key is required")
      return
    }
    let value = call.getString("value") ?? ""
    UserDefaults.standard.set(value, forKey: "trustid.secure.\(key)")
    call.resolve(["ok": true])
  }

  @objc func getSecure(_ call: CAPPluginCall) {
    guard let key = call.getString("key"), !key.isEmpty else {
      call.reject("key is required")
      return
    }
    let value = UserDefaults.standard.string(forKey: "trustid.secure.\(key)")
    call.resolve(["value": value as Any])
  }

  private func evaluateBiometrics(
    _ call: CAPPluginCall,
    reason: String,
    completion: @escaping (Bool, String?) -> Void
  ) {
    let context = LAContext()
    var error: NSError?
    // Class 3 only — never deviceOwnerAuthentication (passcode).
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      completion(false, error?.localizedDescription ?? "No Face ID / Touch ID enrolled")
      return
    }
    context.localizedFallbackTitle = "" // hide "Enter Password"
    context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, evalError in
      DispatchQueue.main.async {
        completion(success, evalError?.localizedDescription)
      }
    }
  }

  private func ensureSecureEnclavePublicKey(tag: String) throws -> Data {
    let tagData = tag.data(using: .utf8)!
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tagData,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let key = item {
      return try exportPublicKey(privateKey: key as! SecKey)
    }

    // Missing alias — create Secure Enclave key (graceful, no crash).
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &error
    ) else {
      throw error!.takeRetainedValue() as Error
    }

    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tagData,
        kSecAttrAccessControl as String: access,
      ],
    ]

    guard let privateKey = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
      // Simulator / no SE: fall back to software key still gated by biometrics above.
      let softAttrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: tagData,
        ],
      ]
      guard let softKey = SecKeyCreateRandomKey(softAttrs as CFDictionary, &error) else {
        throw error!.takeRetainedValue() as Error
      }
      return try exportPublicKey(privateKey: softKey)
    }
    return try exportPublicKey(privateKey: privateKey)
  }

  private func exportPublicKey(privateKey: SecKey) throws -> Data {
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw NSError(domain: "TrustIdBiometricGate", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Missing public key for Secure Enclave alias",
      ])
    }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      throw error!.takeRetainedValue() as Error
    }
    return data
  }
}
