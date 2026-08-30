#if canImport(FamilyControls)
import FamilyControls
#endif
#if canImport(ManagedSettings)
import ManagedSettings
#endif
import Foundation

/**
 * Applies ManagedSettings shields to restricted applications selected via FamilyControls.
 * Requires the Family Controls entitlement on a paid Apple Developer account.
 */
public final class ManagedSettingsShield {
  public static let shared = ManagedSettingsShield()

  #if canImport(ManagedSettings)
  @available(iOS 15.0, *)
  private lazy var store = ManagedSettingsStore()
  #endif

  private init() {}

  public var isAuthorized: Bool {
    #if canImport(FamilyControls)
    if #available(iOS 16.0, *) {
      return AuthorizationCenter.shared.authorizationStatus == .approved
    }
    #endif
    return false
  }

  public func requestAuthorization(completion: @escaping (Bool, String?) -> Void) {
    #if canImport(FamilyControls)
    if #available(iOS 16.0, *) {
      Task {
        do {
          try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
          await MainActor.run { completion(true, "FamilyControls authorized") }
        } catch {
          await MainActor.run { completion(false, error.localizedDescription) }
        }
      }
      return
    }
    #endif
    completion(false, "FamilyControls requires iOS 16+ and the Family Controls entitlement")
  }

  public func syncLockedTokens(fromPolicy policy: [String: Any]) {
    let enabled = policy["enabled"] as? Bool ?? false
    let packages = ((policy["apps"] as? [[String: Any]]) ?? []).compactMap { $0["packageId"] as? String }
    if enabled {
      syncLockedBundleIds(packages)
    } else {
      clearShields()
    }
  }

  /**
   * Persist desired lock list. ApplicationToken shields are applied when the
   * FamilyActivityPicker stores tokens via [applySelectionTokens].
   */
  public func syncLockedBundleIds(_ bundleIds: [String]) {
    UserDefaults.standard.set(bundleIds, forKey: "trustid.family.locked_bundle_ids")
    if bundleIds.isEmpty {
      clearShields()
    }
  }

  #if canImport(FamilyControls) && canImport(ManagedSettings)
  @available(iOS 16.0, *)
  public func applySelectionTokens(
    applications: Set<ApplicationToken>,
    categories: Set<ActivityCategoryToken>,
  ) {
    store.shield.applications = applications.isEmpty ? nil : applications
    store.shield.applicationCategories = categories.isEmpty ? nil : .specific(categories)
  }
  #endif

  public func clearShields() {
    #if canImport(ManagedSettings)
    if #available(iOS 15.0, *) {
      store.clearAllSettings()
    }
    #endif
  }
}

public enum TrustIdShieldAction {
  public static let denyMessage = "Locked by Trust ID. Unlock in the Trust ID app."
}
