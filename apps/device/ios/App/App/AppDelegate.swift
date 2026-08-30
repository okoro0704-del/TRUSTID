import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Task switcher / multitasking preview protection
        SceneBlurHandler.shared.cover(window: window)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        SceneBlurHandler.shared.cover(window: window)
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        SceneBlurHandler.shared.reveal()
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        SceneBlurHandler.shared.reveal()
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
