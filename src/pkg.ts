/**
 * Read this package's own `package.json` for the two values the iLink protocol
 * requires on every request: the app id (`ilink_appid`) and the client version.
 *
 * The walk-up search is deliberately layout-agnostic: it works both when running
 * TypeScript sources under `src/` (tsx) and when running compiled output under
 * `lib/`.
 *
 * @module @5havv/dsh-weixin/pkg
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OwnPackageJson {
  name?: string;
  version?: string;
  /** iLink app id, sent as the `iLink-App-Id` header. */
  ilink_appid?: string;
}

/** Only accept a `package.json` that is actually ours, never a dependency's. */
function isOwnPackageJson(parsed: OwnPackageJson): boolean {
  if (parsed.ilink_appid !== undefined) return true;
  return typeof parsed.name === 'string' && parsed.name.endsWith('/dsh-weixin');
}

/**
 * Walk up from `startDir` looking for this package's `package.json`.
 *
 * @param startDir - directory to start the search from.
 * @returns the parsed manifest, or an empty object when not found.
 */
export function readOwnPackageJson(startDir: string): OwnPackageJson {
  try {
    let dir = startDir;
    const { root } = path.parse(dir);
    while (dir && dir !== root) {
      const candidate = path.join(dir, 'package.json');
      if (fs.existsSync(candidate)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as OwnPackageJson;
          if (isOwnPackageJson(parsed)) return parsed;
        } catch {
          // Malformed manifest — keep walking up.
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall through to the empty default.
  }
  return {};
}

/** This package's manifest, resolved once from the current module location. */
export const ownPackageJson: OwnPackageJson = readOwnPackageJson(
  path.dirname(fileURLToPath(import.meta.url)),
);
