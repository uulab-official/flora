#!/usr/bin/env bash
set -euo pipefail
sdk_android_dir="$(cd "$(dirname "$0")/.." && pwd)"
test_dir="$(mktemp -d "${TMPDIR:-/tmp}/flora-android-tests.XXXXXX")"
trap 'rm -rf "$test_dir"' EXIT
gradle_bin="${FLORA_GRADLE_BIN:-}"
if [[ -z "$gradle_bin" ]]; then
  gradle_bin="$(command -v gradle || true)"
fi
if [[ -z "$gradle_bin" ]]; then
  for candidate in "$HOME"/.gradle/wrapper/dists/gradle-8.13-bin/*/gradle-8.13/bin/gradle; do
    if [[ -x "$candidate" ]]; then gradle_bin="$candidate"; break; fi
  done
fi
if [[ -z "$gradle_bin" ]]; then printf '%s\n' 'Set FLORA_GRADLE_BIN to Gradle 8.13 or install Gradle.' >&2; exit 1; fi
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost' -keyout "$test_dir/private-key.pem" -out "$test_dir/certificate.pem" >"$test_dir/openssl.log" 2>&1
keytool -importcert -noprompt -alias flora-unit-test -file "$test_dir/certificate.pem" -keystore "$test_dir/truststore.p12" -storetype PKCS12 -storepass flora-unit-test >"$test_dir/keytool.log" 2>&1
cat >"$test_dir/settings.gradle" <<'GRADLE'
pluginManagement { repositories { gradlePluginPortal(); mavenCentral() } }
rootProject.name = 'flora-android-native-tests'
GRADLE
cat >"$test_dir/build.gradle" <<'GRADLE'
plugins { id 'org.jetbrains.kotlin.jvm' version '2.1.20' }
repositories { mavenCentral() }
dependencies { testImplementation 'junit:junit:4.13.2'; implementation 'org.json:json:20180813'; implementation 'com.squareup.okhttp3:okhttp:4.9.2' }
kotlin { jvmToolchain(17) }
sourceSets {
  main.kotlin {
    srcDirs = [System.getenv('FLORA_ANDROID_SOURCE') + '/src/main/java']
    include '**/FloraProtocol.kt', '**/FloraStore.kt', '**/FloraEngine.kt'
  }
  test.kotlin { srcDirs = [System.getenv('FLORA_ANDROID_SOURCE') + '/src/test/java'] }
}
test {
  systemProperty 'flora.test.certificate', System.getenv('FLORA_NATIVE_TEST_CERTIFICATE')
  systemProperty 'flora.test.privateKey', System.getenv('FLORA_NATIVE_TEST_KEY')
  systemProperty 'javax.net.ssl.trustStore', System.getenv('FLORA_NATIVE_TEST_TRUSTSTORE')
  systemProperty 'javax.net.ssl.trustStorePassword', 'flora-unit-test'
  testLogging { events 'passed', 'failed'; exceptionFormat = 'full' }
}
GRADLE
FLORA_ANDROID_SOURCE="$sdk_android_dir" FLORA_NATIVE_TEST_CERTIFICATE="$test_dir/certificate.pem" FLORA_NATIVE_TEST_KEY="$test_dir/private-key.pem" FLORA_NATIVE_TEST_TRUSTSTORE="$test_dir/truststore.p12" "$gradle_bin" --project-dir "$test_dir" --console=plain --max-workers=2 test
