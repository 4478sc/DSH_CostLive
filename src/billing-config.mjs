/** Local settings only: never reads or writes DSH data or credentials. */
import { existsSync, readFileSync, mkdirSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBilling } from './billing.mjs';
export const DEFAULT_BILLING_PATH = fileURLToPath(new URL('../config/billing.local.json', import.meta.url));
export function loadBilling(path = DEFAULT_BILLING_PATH) {
  return existsSync(path) ? normalizeBilling(JSON.parse(readFileSync(path, 'utf8'))) : normalizeBilling();
}
export function saveBilling(path, value) {
  const config = normalizeBilling(value);
  const target = resolve(path ?? DEFAULT_BILLING_PATH);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = target + '.' + process.pid + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return config;
}
