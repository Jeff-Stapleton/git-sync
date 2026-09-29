// isomorphic-git (and its deps) need a global Buffer, which mobile Obsidian does not have.
// esbuild `inject` replaces free `Buffer` references with this export. The polyfill is used on
// desktop too, so the built-in engine behaves identically on every platform.
import { Buffer } from "buffer";
export { Buffer };
