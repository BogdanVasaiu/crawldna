// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Bogdan Marian Vasaiu
// Tiny static server for the docs/ landing page — used by the `docs-preview`
// launch config. Node built-ins only; the root is resolved relative to this
// file so it works on any clone (no machine-specific paths).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const ROOT = fileURLToPath(new URL('../docs', import.meta.url));
const PORT = Number(process.env.PORT) || 4174;
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

http
  .createServer(async (req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    // Confine every request to ROOT (no path traversal).
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    try {
      const buf = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  })
  .listen(PORT, () => console.log(`docs on http://localhost:${PORT}`));
