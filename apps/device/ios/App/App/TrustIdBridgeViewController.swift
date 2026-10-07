import Capacitor
import WebKit

/// Bridge view controller that serves the bundled biometric engine release
/// (BiometricAssets.swift) to the live web app.
class TrustIdBridgeViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        configuration.setURLSchemeHandler(BiometricAssetSchemeHandler(), forURLScheme: BiometricAssetSchemeHandler.scheme)
        return configuration
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(BiometricAssetsPlugin())
    }
}
