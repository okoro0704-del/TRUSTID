import Foundation
import UIKit
import Capacitor

/**
 * iOS stub ù cross-app App Lock is unavailable.
 * Methods resolve with policy storage only; UI should explain Screen Time.
 */
@objc(TrustIdAppLockPlugin)
public class TrustIdAppLockPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdAppLockPlugin"
  public let jsName = "TrustIdAppLock"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getPolicy", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "setPolicy", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openAccessibilitySettings", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "isAccessibilityEnabled", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "challengeNow", returnType: CAPPluginReturnPromise),
  ]

  private let key = "trustid.app_lock.policy"

  @objc func getPolicy(_ call: CAPPluginCall) {
    if let data = UserDefaults.standard.data(forKey: key),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      call.resolve(obj)
      return
    }
    call.resolve([
      "enabled": false,
      "allowDeviceCredential": false,
      "biometricStrongOnly": true,
      "postAuthGraceMs": 8000,
      "lockOnBackground": true,
      "apps": [],
    ])
  }

  @objc func setPolicy(_ call: CAPPluginCall) {
    guard let policy = call.getObject("policy"),
          let data = try? JSONSerialization.data(withJSONObject: policy) else {
      call.reject("policy required")
      return
    }
    UserDefaults.standard.set(data, forKey: key)
    call.resolve()
  }

  @objc func openAccessibilitySettings(_ call: CAPPluginCall) {
    // Deep-link to Screen Time is not publicly stable; open Settings root.
    if let url = URL(string: UIApplication.openSettingsURLString) {
      DispatchQueue.main.async {
        UIApplication.shared.open(url)
      }
    }
    call.resolve()
  }

  @objc func isAccessibilityEnabled(_ call: CAPPluginCall) {
    call.resolve(["enabled": false])
  }

  @objc func challengeNow(_ call: CAPPluginCall) {
    call.resolve(["ok": false])
  }
}
