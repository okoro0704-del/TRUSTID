/**
 * Syncs TrustID native plugin sources into Capacitor android/ (and ios/ when present).
 * Run after `npx cap add android|ios` and before `npx cap sync`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(root, "android");
const iosRoot = join(root, "ios");
const nativeAndroid = join(root, "native", "android");
const nativeIos = join(root, "native", "ios");

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest);
  console.log(`  + ${dest.replace(root + "\\", "").replace(root + "/", "")}`);
}

function patchMainActivity() {
  const mainActivity = join(
    androidRoot,
    "app",
    "src",
    "main",
    "java",
    "com",
    "trustid",
    "device",
    "MainActivity.java",
  );
  if (!existsSync(mainActivity)) {
    console.warn("MainActivity.java not found ? skip plugin registration");
    return;
  }
  let src = readFileSync(mainActivity, "utf8");
  if (src.includes("BiometricGatePlugin")) {
    console.log("  ? MainActivity already registers TrustID plugins");
    return;
  }

  if (!src.includes("import com.getcapacitor.BridgeActivity")) {
    console.warn("Unexpected MainActivity format ? skip auto-patch");
    return;
  }

  src = src.replace(
    "import com.getcapacitor.BridgeActivity;",
    `import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import com.trustid.device.plugins.BiometricGatePlugin;
import com.trustid.device.plugins.MediaVaultPlugin;
import com.trustid.device.plugins.AppLockPlugin;`,
  );

  if (src.includes("public class MainActivity extends BridgeActivity {}")) {
    src = src.replace(
      "public class MainActivity extends BridgeActivity {}",
      `public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BiometricGatePlugin.class);
        registerPlugin(MediaVaultPlugin.class);
        registerPlugin(AppLockPlugin.class);
        super.onCreate(savedInstanceState);
    }
}`,
    );
  } else if (src.includes("extends BridgeActivity")) {
    // Already has a body ? inject register calls before super.onCreate if present
    if (src.includes("super.onCreate")) {
      src = src.replace(
        "super.onCreate(savedInstanceState);",
        `registerPlugin(BiometricGatePlugin.class);
        registerPlugin(MediaVaultPlugin.class);
        registerPlugin(AppLockPlugin.class);
        super.onCreate(savedInstanceState);`,
      );
    }
  }

  writeFileSync(mainActivity, src);
  console.log("  + MainActivity plugin registration");
}

function mergeAndroidManifest() {
  const manifestPath = join(androidRoot, "app", "src", "main", "AndroidManifest.xml");
  if (!existsSync(manifestPath)) return;
  let manifest = readFileSync(manifestPath, "utf8");
  let changed = false;

  const perms = [
    'android.permission.USE_BIOMETRIC',
    'android.permission.USE_FINGERPRINT',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.CAMERA',
  ];
  for (const perm of perms) {
    if (!manifest.includes(perm)) {
      manifest = manifest.replace(
        "<application",
        `    <uses-permission android:name="${perm}" />\n\n    <application`,
      );
      changed = true;
    }
  }

  if (!manifest.includes("AppLockService") || !manifest.includes("OverlayGuardActivity")) {
    manifest = manifest.replace(
      "</application>",
      `        <activity
            android:name="com.trustid.device.applock.OverlayGuardActivity"
            android:excludeFromRecents="true"
            android:exported="false"
            android:launchMode="singleInstance"
            android:showWhenLocked="true"
            android:taskAffinity=""
            android:theme="@style/Theme.AppCompat.DayNight.NoActionBar" />

        <service
            android:name="com.trustid.device.applock.AppLockService"
            android:exported="false"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/trustid_app_lock_accessibility" />
        </service>
    </application>`,
    );
    changed = true;
  }

  if (changed) {
    writeFileSync(manifestPath, manifest);
    console.log("  + AndroidManifest permissions + App Lock components");
  } else {
    console.log("  ? AndroidManifest already merged");
  }
}

function patchGradleKotlin() {
  const rootGradle = join(androidRoot, "build.gradle");
  const appGradle = join(androidRoot, "app", "build.gradle");
  if (existsSync(rootGradle)) {
    let text = readFileSync(rootGradle, "utf8");
    if (!text.includes("kotlin-gradle-plugin")) {
      text = text.replace(
        "classpath 'com.google.gms:google-services:4.4.0'",
        "classpath 'com.google.gms:google-services:4.4.0'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.24'",
      );
      writeFileSync(rootGradle, text);
      console.log("  + root build.gradle Kotlin plugin");
    }
  }
  if (existsSync(appGradle)) {
    let text = readFileSync(appGradle, "utf8");
    if (!text.includes("kotlin-android")) {
      text = text.replace(
        "apply plugin: 'com.android.application'",
        "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'",
      );
      writeFileSync(appGradle, text);
      console.log("  + app/build.gradle kotlin-android");
    }
    if (!text.includes("jvmTarget")) {
      text = readFileSync(appGradle, "utf8");
      if (!text.includes("kotlinOptions")) {
        text = text.replace(
          /buildTypes\s*\{/,
          `compileOptions {
        sourceCompatibility JavaVersion.VERSION_17
        targetCompatibility JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = '17'
    }
    buildTypes {`,
        );
        writeFileSync(appGradle, text);
        console.log("  + app/build.gradle jvmTarget 17");
      }
    }
  }
}

function patchGradleDependencies() {
  const gradle = join(androidRoot, "app", "build.gradle");
  if (!existsSync(gradle)) return;
  let text = readFileSync(gradle, "utf8");
  const deps = [
    'implementation "androidx.biometric:biometric:1.1.0"',
    'implementation "androidx.security:security-crypto:1.1.0-alpha06"',
    'implementation "androidx.appcompat:appcompat:1.7.0"',
    'implementation "androidx.camera:camera-camera2:1.3.4"',
    'implementation "androidx.camera:camera-lifecycle:1.3.4"',
  ];
  let changed = false;
  for (const dep of deps) {
    if (!text.includes(dep.split('"')[1])) {
      text = text.replace(
        /dependencies\s*\{/,
        `dependencies {\n    ${dep}`,
      );
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(gradle, text);
    console.log("  + app/build.gradle biometric + security-crypto");
  } else {
    console.log("  ? Gradle deps already present");
  }
}

function syncAndroid() {
  if (!existsSync(androidRoot)) {
    console.log("No android/ project yet. Run: npm run cap:add:android -w @trustid/device");
    return;
  }
  console.log("Syncing Android native sources?");

  const javaPlugins = join(androidRoot, "app", "src", "main", "java", "com", "trustid", "device", "plugins");
  const javaApplock = join(androidRoot, "app", "src", "main", "java", "com", "trustid", "device", "applock");
  const resXml = join(androidRoot, "app", "src", "main", "res", "xml");
  const resValues = join(androidRoot, "app", "src", "main", "res", "values");

  copyFile(join(nativeAndroid, "BiometricGatePlugin.kt"), join(javaPlugins, "BiometricGatePlugin.kt"));
  copyFile(join(nativeAndroid, "MediaVaultPlugin.kt"), join(javaPlugins, "MediaVaultPlugin.kt"));
  copyFile(join(nativeAndroid, "AppLockPlugin.kt"), join(javaPlugins, "AppLockPlugin.kt"));
  copyFile(join(nativeAndroid, "SilentFaceCapturePlugin.kt"), join(javaPlugins, "SilentFaceCapturePlugin.kt"));
  copyFile(join(nativeAndroid, "OverlayGuardActivity.kt"), join(javaApplock, "OverlayGuardActivity.kt"));
  copyFile(join(nativeAndroid, "AppLockService.kt"), join(javaApplock, "AppLockService.kt"));
  if (existsSync(join(nativeAndroid, "OverlayWindowGuard.kt"))) {
    copyFile(join(nativeAndroid, "OverlayWindowGuard.kt"), join(javaApplock, "OverlayWindowGuard.kt"));
  }
  // Remove legacy misnamed copies that redeclare the same classes
  for (const stale of ["AppLockOverlayActivity.kt", "AppLockAccessibilityService.kt"]) {
    const p = join(javaApplock, stale);
    if (existsSync(p)) {
      unlinkSync(p);
      console.log(`  - removed stale ${stale}`);
    }
  }
  copyFile(
    join(nativeAndroid, "res", "xml", "trustid_app_lock_accessibility.xml"),
    join(resXml, "trustid_app_lock_accessibility.xml"),
  );

  // Merge strings
  const stringsPath = join(resValues, "strings.xml");
  const mergeStrings = readFileSync(join(nativeAndroid, "res", "values", "strings.merge.xml"), "utf8");
  const extra = `    <string name="trustid_app_lock_a11y_description">TrustID App Lock watches when protected apps open and asks for your biometric before they can be used.</string>`;
  if (existsSync(stringsPath)) {
    let strings = readFileSync(stringsPath, "utf8");
    if (!strings.includes("trustid_app_lock_a11y_description")) {
      strings = strings.replace("</resources>", `${extra}\n</resources>`);
      writeFileSync(stringsPath, strings);
      console.log("  + strings.xml a11y description");
    }
  } else {
    writeFileSync(stringsPath, mergeStrings);
    console.log("  + strings.xml created");
  }

  patchMainActivity();
  mergeAndroidManifest();
  patchGradleKotlin();
  patchGradleDependencies();
}

function syncIos() {
  if (!existsSync(iosRoot)) {
    console.log("No ios/ project yet. On macOS run: npm run cap:add:ios -w @trustid/device");
    return;
  }
  console.log("Syncing iOS native plugin sources...");
  const dest = join(iosRoot, "App", "App", "plugins");
  ensureDir(dest);
  for (const file of ["BiometricGatePlugin.swift", "MediaVaultPlugin.swift", "AppLockPlugin.swift"]) {
    copyFile(join(nativeIos, file), join(dest, file));
  }

  const infoPlist = join(iosRoot, "App", "App", "Info.plist");
  if (existsSync(infoPlist)) {
    let plist = readFileSync(infoPlist, "utf8");
    if (!plist.includes("NSFaceIDUsageDescription")) {
      plist = plist.replace(
        "</dict>\n</plist>",
        `\t<key>NSFaceIDUsageDescription</key>\n\t<string>TrustID uses Face ID to unlock your private media and protected apps.</string>\n</dict>\n</plist>`,
      );
      writeFileSync(infoPlist, plist);
      console.log("  + Info.plist NSFaceIDUsageDescription");
    }
  }
  console.log("  ? On macOS: add plugins/*.swift to the Xcode App target if needed, then pod install.");
}

syncAndroid();
syncIos();
console.log("Native sync complete.");
