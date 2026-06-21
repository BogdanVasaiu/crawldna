// Disk output (§9): a flat bundle of AI-grouped .md files plus a stable
// manifest.json. The grouping (one file by default, several when the task asks
// to split) is decided upstream in lib/layout.mjs; this module only writes a
// pre-built `files` list and the manifest to a directory.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Write a bundle of grouped Markdown files + manifest.json to `dir`.
 * @param {string} dir
 * @param {{ files: Array<{ filename: string, markdown: string }>, manifest: object }} bundle
 * @returns {Promise<{ dir: string, manifestPath: string, files: number }>}
 */
export async function writeBundle(dir, { files = [], manifest }) {
  const root = path.resolve(dir);
  await mkdir(root, { recursive: true });

  for (const f of files) {
    // basename guards against any stray path separators in a filename.
    const abs = path.join(root, path.basename(f.filename));
    await writeFile(abs, f.markdown, 'utf8');
  }

  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return { dir: root, manifestPath, files: files.length };
}
