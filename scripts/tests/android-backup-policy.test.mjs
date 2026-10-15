import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const res = (p) => readFileSync(new URL(`../../apps/device/android/app/src/main/${p}`, import.meta.url), "utf8");

test("TrustID app data is excluded from backup and device-to-device transfer", () => {
  const manifest = res("AndroidManifest.xml");
  assert.match(manifest, /android:allowBackup="false"/);
  assert.match(manifest, /android:fullBackupContent="false"/);
  assert.match(manifest, /android:dataExtractionRules="@xml\/data_extraction_rules"/);
  const rules = res("res/xml/data_extraction_rules.xml");
  for (const section of ["cloud-backup", "device-transfer"]) {
    const body = rules.match(new RegExp(`<${section}>([\\s\\S]*?)</${section}>`))?.[1] ?? "";
    assert.doesNotMatch(body, /<include/, `${section} must not include anything`);
    for (const domain of ["root", "file", "database", "sharedpref", "external"]) {
      assert.match(body, new RegExp(`<exclude domain="${domain}" path="\\." />`), `${section} excludes ${domain}`);
    }
  }
});
