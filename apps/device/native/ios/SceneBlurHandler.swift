import UIKit

/**
 * Automatic task-switcher screen blackout / blur.
 * Hook from AppDelegate.applicationWillResignActive / DidBecomeActive.
 */
public final class SceneBlurHandler {
  public static let shared = SceneBlurHandler()

  private weak var overlay: UIView?
  private init() {}

  public func cover(window: UIWindow?) {
    guard let window = window ?? UIApplication.shared.windows.first(where: { $0.isKeyWindow })
            ?? UIApplication.shared.windows.first else { return }
    remove()

    let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    blur.frame = window.bounds
    blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    blur.isUserInteractionEnabled = false
    blur.tag = 0x71D_B100

    let black = UIView(frame: window.bounds)
    black.backgroundColor = UIColor.black.withAlphaComponent(0.92)
    black.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    black.tag = 0x71D_B101

    window.addSubview(black)
    window.addSubview(blur)
    overlay = black
  }

  public func reveal() {
    remove()
  }

  private func remove() {
    guard let window = UIApplication.shared.windows.first(where: { $0.isKeyWindow })
            ?? UIApplication.shared.windows.first else {
      overlay?.removeFromSuperview()
      overlay = nil
      return
    }
    window.viewWithTag(0x71D_B100)?.removeFromSuperview()
    window.viewWithTag(0x71D_B101)?.removeFromSuperview()
    overlay = nil
  }
}
