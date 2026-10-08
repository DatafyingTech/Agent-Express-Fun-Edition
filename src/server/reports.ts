// 📊 Reports: what the agents make for people to look at (budget dashboards, PDFs, the Chart Artist's
// charts), listed from a floor's reports/ and charts/ folders and served to a signed-in browser, so
// they open on a phone as well as on the PC. Nothing outside those two folders is ever served.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const REPORT_DIRS = ['reports', 'charts'] as const;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
const MAX_FILES = 300;
const MAX_BYTES = 40 * 1024 * 1024;

export interface ReportFile {
  /** Relative to the floor's checkout, with forward slashes: reports/2026-09-29_weekly.html. */
  path: string;
  size: number;
  modified: number;
}

/** The reports on a floor, newest first. */
export function listReports(floorDir: string): ReportFile[] {
  const out: ReportFile[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 3 || out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(path.join(floorDir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r, depth + 1);
      else if (e.isFile() && TYPES[path.extname(e.name).toLowerCase()] && !/^readme\.md$/i.test(e.name)) {
        try {
          const st = statSync(path.join(floorDir, r));
          out.push({ path: r, size: st.size, modified: st.mtimeMs });
        } catch {
          // gone already
        }
      }
    }
  };
  for (const d of REPORT_DIRS) walk(d, 0);
  return out.sort((a, b) => b.modified - a.modified).slice(0, MAX_FILES);
}

/** One report's bytes and type, or why not. Only files inside the floor's reports/ or charts/. */
export function readReport(floorDir: string, rel: string): { body: Buffer; type: string } | { status: number; error: string } {
  const clean = rel.replace(/\\/g, '/');
  if (!REPORT_DIRS.some((d) => clean.startsWith(`${d}/`)) || clean.split('/').includes('..')) return { status: 400, error: 'Not a report' };
  const root = path.resolve(floorDir);
  const file = path.resolve(root, clean);
  if (!REPORT_DIRS.some((d) => file.startsWith(path.join(root, d) + path.sep))) return { status: 400, error: 'Not a report' };
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return { status: 400, error: 'Not a report' };
  if (!existsSync(file)) return { status: 404, error: 'No such report' };
  const st = statSync(file);
  if (!st.isFile() || st.size > MAX_BYTES) return { status: 400, error: 'Not a report' };
  return { body: readFileSync(file), type };
}
