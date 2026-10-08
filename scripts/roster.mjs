#!/usr/bin/env node
// Points src/shared/roster.ts at the roster the office runs on: roster.local.ts, your own team (kept
// out of git), when it exists, else roster.default.ts, the generic team that ships. It runs after
// npm install and before every build, dev run, typecheck and test, so the client (Vite), the server
// (tsc) and the tests (tsx) all import the same roster through shared/team.ts.
//
// AGENT_OFFICE_ROSTER=default uses the generic roster even when there's a local one (to try it, or to
// check the shipped roster still builds and passes its tests).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shared = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared');
// Installed without its sources (only bin/ and dist/): there's nothing to point.
if (!existsSync(shared)) process.exit(0);

const local = existsSync(path.join(shared, 'roster.local.ts')) && process.env.AGENT_OFFICE_ROSTER !== 'default';
const which = local ? 'roster.local' : 'roster.default';
const text = `// Written by scripts/roster.mjs (npm run roster): don't edit it, and don't commit it.\nexport * from './${which}.js';\n`;
const file = path.join(shared, 'roster.ts');
const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
// Only when it changes, so a dev server or a watch build isn't nudged for nothing.
if (before !== text) {
  writeFileSync(file, text);
  console.log(`roster: the office runs on src/shared/${which}.ts`);
}
