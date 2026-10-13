# Flora trusted GitHub Runner

This distribution is built from the included TypeScript source snapshot. The reusable workflow pins the distribution commit, and each file is checked against SHA256SUMS before execution. App code is downloaded separately at the OIDC-admitted commit and runs only in an isolated Docker compiler.

Node 24.19.0; npm 10.9.8; own Flora OTA engine; no EAS. Dependency preparation disables lifecycle scripts and only accepts npm registry SHA512 entries and verified vendored SDK archives. The compiler has no network or publication credentials. GitHub private-repository caller billing and its existing zero-dollar spending cap apply.

Build command in the Flora workspace: node scripts/package-github-runner.mjs /absolute/controller-worktree/ci/flora-runner
