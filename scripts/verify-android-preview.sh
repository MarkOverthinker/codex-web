#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
  echo "Usage: bash scripts/verify-android-preview.sh APK EXPECTED_SIGNER_SHA256" >&2
  exit 2
fi

apk=$1
expected_signer=${2,,}
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
tools="$sdk/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
[[ -f "$apk" && "$expected_signer" =~ ^[0-9a-f]{64}$ ]] || { echo "Invalid APK path or certificate digest" >&2; exit 2; }
for tool in aapt apksigner zipalign; do
  [[ -x "$tools/$tool" ]] || { echo "Missing Android build tool: $tool" >&2; exit 2; }
done

certificate=$("$tools/apksigner" verify --verbose --print-certs "$apk")
actual_signer=$(printf '%s\n' "$certificate" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[[ "$actual_signer" == "$expected_signer" ]] || { echo "Unexpected signing certificate" >&2; exit 1; }
printf '%s\n' "$certificate" | grep -q '^Number of signers: 1$'

badging=$("$tools/aapt" dump badging "$apk")
manifest=$("$tools/aapt" dump xmltree "$apk" AndroidManifest.xml)
printf '%s\n' "$badging" | grep -q "^package: name='app.codexweb.mobile.preview' "
printf '%s\n' "$badging" | grep -q "^sdkVersion:'26'$"
printf '%s\n' "$badging" | grep -q "^targetSdkVersion:'36'$"
printf '%s\n' "$badging" | grep -q "^native-code: .*'arm64-v8a'"
if printf '%s\n' "$manifest" | grep -Eq 'android:(debuggable|testOnly).*0xffffffff| A: split='; then
  echo "User preview must be standalone, non-debuggable and not test-only" >&2
  exit 1
fi
"$tools/zipalign" -c -P 16 4 "$apk"
unzip -t "$apk" >/dev/null
printf '%s\n' "PASS: preview identity, pinned signature, SDK, ARM64, flags, archive and 16KB ZIP alignment"
sha256sum "$apk"
