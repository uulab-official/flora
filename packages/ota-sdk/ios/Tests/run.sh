#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$fixture/key.pem" -out "$fixture/certificate.pem" -days 2 -subj /CN=Flora-Test >/dev/null 2>&1
printf 'globalThis.floraVersion = 2;' > "$fixture/asset"
digest=$(/usr/bin/openssl dgst -sha256 "$fixture/asset" | sed 's/^.*= //')
hash=$(/usr/bin/openssl dgst -sha256 -binary "$fixture/asset" | /usr/bin/openssl base64 -A | tr '+/' '-_' | tr -d '=')
printf '{"id":"00000000-0000-4000-8000-000000000001","createdAt":"2026-10-12T00:00:00.000Z","runtimeVersion":"native-v1","launchAsset":{"hash":"%s","key":"launch","contentType":"application/javascript","url":"https://updates.example/updates/app_one/assets/%s"},"assets":[],"metadata":{"channel":"production","appid":"app_one"},"extra":{"flora":{"appId":"app_one","platform":"ios"}}}' "$hash" "$digest" > "$fixture/manifest.json"
/usr/bin/openssl dgst -sha256 -sign "$fixture/key.pem" -out "$fixture/signature.bin" "$fixture/manifest.json"
xcrun swiftc -swift-version 5 "$here/../FloraOTACore.swift" "$here/../FloraOTAURLSessionTransport.swift" "$here/main.swift" -o "$fixture/test"
"$fixture/test" "$fixture"
