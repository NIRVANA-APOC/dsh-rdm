// Single source of truth for the plugin version.
//
// `scripts/build.mjs` (and `scripts/dev-build.sh`) define
// `__DSH_RDM_VERSION__` from `package.json` at build time, so a released
// artifact always names the version it shipped as. 0.3.0 hard-coded the string
// inside {@link protocolMismatchMessage} and drifted from the manifest the
// moment the package was bumped; bundling the whole manifest to read one field
// costs ~15 KB, so the value is injected instead.
//
// @module dsh-rdm/version

/** Build-time replacement; absent only in a hand-rolled esbuild invocation. */
declare const __DSH_RDM_VERSION__: string

/** Version of this plugin build (`package.json` `version`). */
export const PLUGIN_VERSION: string = typeof __DSH_RDM_VERSION__ === 'string' ? __DSH_RDM_VERSION__ : '0.0.0'
