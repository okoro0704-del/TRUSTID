import LocalAuthentication
import Security
import Capacitor

/**
 * iOS biometric gate via LocalAuthentication.
 * Cross-app process shield is NOT implemented — Apple does not allow it for third-party apps.
 */
@objc(TrustIdBiometricGatePlugin)
public class TrustIdBiometricGatePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdBiometricGatePlugin"
  public let jsName = "TrustIdBiometricGate"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getAvailability", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
  ]

  @objc func getAvailability(_ call: CAPPluginCall) {
    let context = LAContext()
    var error: NSError?
    let strong = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    call.resolve([
      "platform": "ios",
      "available": strong,
      "enrolled": strong,
      "strength": strong ? "strong" : "none",
      "hardwareBoundKeys": true,
      "appLockSupported": false,
      "secureWipeSupported": false,
      "notes": [
        "LocalAuthentication + Secure Enclave Keychain items.",
        "iOS cannot intercept other apps' launches; use Screen Time / Focus.",
      ],
    ])
  }

  @objc func authenticate(_ call: CAPPluginCall) {
    let reason = call.getString("reason") ?? "Authenticate"
    let allowDevice = call.getBool("allowDeviceCredential") ?? false
    let policy: LAPolicy = allowDevice
      ? .deviceOwnerAuthentication
      : .deviceOwnerAuthenticationWithBiometrics

    let context = LAContext()
    context.localizedFallbackTitle = allowDevice ? nil : ""

    context.evaluatePolicy(policy, localizedReason: reason) { success, error in
      DispatchQueue.main.async {
        if success {
          call.resolve(["ok": true, "method": allowDevice ? "device_or_biometric" : "biometric"])
        } else {
          call.reject(error?.localizedDescription ?? "Biometric failed")
        }
      }
    }
  }
}
