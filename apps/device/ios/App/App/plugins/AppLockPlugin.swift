import Foundation
import UIKit
import LocalAuthentication
import Capacitor

#if canImport(FamilyControls)
import FamilyControls
#endif
#if canImport(ManagedSettings)
import ManagedSettings
#endif

/**
 * Trust ID App Lock ? iOS.
 * Cross-app shields via FamilyControls + ManagedSettings when authorized;
 * otherwise policy is stored and Screen Time settings are opened.
 */
@objc(TrustIdAppLockPlugin)
public class TrustIdAppLockPlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "TrustIdAppLockPlugin"
  public let jsName = "TrustIdAppLock"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "getPolicy", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "setPolicy", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "setLockedApps", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getInstalledApps", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openAccessibilitySettings", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "openOverlayPermissionSettings", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "canDrawOverlays", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "isAccessibilityEnabled", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "challengeNow", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "isDuressBiometricConfigured", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "requestFamilyControlsAuth", returnType: CAPPluginReturnPromise),
  ]

  private let key = "trustid.app_lock.policy"
  private let lockedKey = "trustid.app_lock.packages"
  private let shield = ManagedSettingsShield.shared

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
    let packages = ((policy["apps"] as? [[String: Any]]) ?? []).compactMap { $0["packageId"] as? String }
    UserDefaults.standard.set(packages, forKey: lockedKey)
    shield.syncLockedTokens(fromPolicy: policy)
    call.resolve()
  }

  @objc func setLockedApps(_ call: CAPPluginCall) {
    guard let packages = call.getArray("packages", String.self) else {
      call.reject("packages required")
      return
    }
    UserDefaults.standard.set(packages, forKey: lockedKey)
    var policy: [String: Any] = [
      "enabled": !packages.isEmpty,
      "allowDeviceCredential": false,
      "biometricStrongOnly": true,
      "postAuthGraceMs": 8000,
      "lockOnBackground": true,
    ]
    if let data = UserDefaults.standard.data(forKey: key),
       let existing = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      policy.merge(existing) { _, new in new }
      policy["enabled"] = true
    }
    let apps = packages.map { pkg -> [String: Any] in
      [
        "packageId": pkg,
        "displayName": pkg,
        "addedAt": ISO8601DateFormatter().string(from: Date()),
      ]
    }
    policy["apps"] = apps
    if let data = try? JSONSerialization.data(withJSONObject: policy) {
      UserDefaults.standard.set(data, forKey: key)
    }
    shield.syncLockedBundleIds(packages)
    call.resolve(["ok": true, "count": packages.count])
  }

  @objc func getInstalledApps(_ call: CAPPluginCall) {
    // iOS does not allow arbitrary enumeration of third-party apps.
    // FamilyActivityPicker is the sanctioned picker; return empty + guidance.
    call.resolve([
      "apps": [],
      "platform": "ios",
      "note": "Use FamilyControls FamilyActivityPicker to select apps; arbitrary enumeration is blocked by iOS.",
    ])
  }

  @objc func openAccessibilitySettings(_ call: CAPPluginCall) {
    if let url = URL(string: UIApplication.openSettingsURLString) {
      DispatchQueue.main.async { UIApplication.shared.open(url) }
    }
    call.resolve()
  }

  @objc func openOverlayPermissionSettings(_ call: CAPPluginCall) {
    openAccessibilitySettings(call)
  }

  @objc func canDrawOverlays(_ call: CAPPluginCall) {
    call.resolve(["granted": false])
  }

  @objc func isAccessibilityEnabled(_ call: CAPPluginCall) {
    #if canImport(FamilyControls)
    if #available(iOS 16.0, *) {
      call.resolve(["enabled": shield.isAuthorized])
      return
    }
    #endif
    call.resolve(["enabled": false])
  }

  @objc func challengeNow(_ call: CAPPluginCall) {
    let reason = call.getString("packageId").map { "Unlock \($0)" } ?? "Unlock Trust ID"
    let ctx = LAContext()
    var err: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
      call.resolve(["ok": false])
      return
    }
    ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, _ in
      DispatchQueue.main.async {
        call.resolve(["ok": ok])
      }
    }
  }

  @objc func isDuressBiometricConfigured(_ call: CAPPluginCall) {
    call.resolve(["configured": false])
  }

  @objc func requestFamilyControlsAuth(_ call: CAPPluginCall) {
    shield.requestAuthorization { authorized, message in
      call.resolve(["authorized": authorized, "message": message ?? ""])
    }
  }
}
