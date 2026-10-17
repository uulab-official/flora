// Bundle the pinned YAML parser into the trusted helper. Repository code is not an input.
import {buildPnpmHelper} from './pnpm-helper-build.mjs';
await buildPnpmHelper();
