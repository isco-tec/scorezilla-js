// Build-time constants injected by tsup's `define` (see tsup.config.ts).
//
// `__SCOREZILLA_SDK_VERSION__` is replaced with the string value of the
// `version` field in this package's package.json at build time. At runtime
// it is a string literal — never read package.json from the shipped bundle.
declare const __SCOREZILLA_SDK_VERSION__: string;
