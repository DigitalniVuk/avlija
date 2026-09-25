/**
 * Persisted PTZ verification results.
 *
 * Written by tools/ptz-verify.ts and read at server start, so the UI's
 * affordances (which buttons to enable, whether to offer optical zoom) come
 * from measurements of the actual hardware rather than from model names or
 * firmware capability flags — both of which are wrong on this device class.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { VerifiedCapabilities } from '../camera/camera.js';

const DEFAULT_PATH = resolve('.avlija/capabilities.json');

export async function loadVerifiedCapabilities(
  cameraId: string,
  path = DEFAULT_PATH,
): Promise<Map<string, VerifiedCapabilities>> {
  const out = new Map<string, VerifiedCapabilities>();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, VerifiedCapabilities>;
    const entry = parsed[cameraId];
    if (entry) out.set(cameraId, entry);
  } catch {
    // No results recorded yet; Camera falls back to its built-in defaults.
  }
  return out;
}

export async function saveVerifiedCapabilities(
  cameraId: string,
  caps: VerifiedCapabilities,
  path = DEFAULT_PATH,
): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    /* first write */
  }
  existing[cameraId] = caps;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}
