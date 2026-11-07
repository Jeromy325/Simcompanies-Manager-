// Load a classic-script *-core.js into an isolated vm context (no DOM) with a minimal chrome mock.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '../..');
export function loadCore(file) {
  const chrome = { runtime: { id: 'test', getURL: p => p }, storage: { local: { get: async () => ({}), set: async () => {} } } };
  const ctx = vm.createContext({ console, chrome, setTimeout, clearTimeout });
  vm.runInContext('globalThis.self = globalThis;', ctx);
  vm.runInContext(readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  return ctx;
}
