import { createRequire } from "node:module";

// Resolves to the package root from both src/ and dist/.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const PRESTON_VERSION = pkg.version;
