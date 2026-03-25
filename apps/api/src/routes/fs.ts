/**
 * /api/fs — Filesystem browser
 * GET /api/fs/browse?path=... — list directories at a path (server-side)
 * GET /api/fs/home            — return the user home + Documents path
 */

import { Router } from 'express';
import { readdir, stat } from 'node:fs/promises';
import { join, dirname, parse } from 'node:path';
import { homedir } from 'node:os';

const router = Router();

async function listDirs(dirPath: string) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      dirs.push({ name: e.name, path: join(dirPath, e.name) });
    }
  }
  return dirs;
}

// GET /api/fs/home
router.get('/home', (_req, res) => {
  const home = homedir();
  res.json({
    data: {
      home,
      documents: join(home, 'Documents'),
      desktop: join(home, 'Desktop'),
    }
  });
});

// GET /api/fs/browse?path=C:\Users\...
router.get('/browse', async (req, res) => {
  const requestedPath = (req.query.path as string) || join(homedir(), 'Documents');
  try {
    const s = await stat(requestedPath);
    if (!s.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }
    const children = await listDirs(requestedPath);

    // Compute parent path
    const parsed = parse(requestedPath);
    const parent = parsed.root === requestedPath ? null : dirname(requestedPath);

    return res.json({
      data: {
        current: requestedPath,
        parent,
        is_root: parsed.root === requestedPath,
        children,
      }
    });
  } catch (e: any) {
    return res.status(400).json({ error: e.message });
  }
});

export default router;
