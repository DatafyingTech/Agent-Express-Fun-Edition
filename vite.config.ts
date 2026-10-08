import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DEFAULT_EDITION, EDITIONS, parseEdition } from './src/shared/edition.ts';

// Which app this build is (src/shared/edition.ts): HEARTH_EDITION=hearth npm run build. A tree
// without the 3D office's page (the Hearth repo) can only be built without it, whatever it's told.
const client = resolve(import.meta.dirname, 'src/client');
const editionId = parseEdition(process.env.HEARTH_EDITION) ?? DEFAULT_EDITION;
const edition = EDITIONS[editionId];
const has3d = edition.has3d && existsSync(join(client, 'index.html'));

// The whiteboard's fonts (Excalidraw's hand-drawn Virgil/Excalifont and friends), served by the
// office itself rather than a CDN. Excalidraw looks for them under window.EXCALIDRAW_ASSET_PATH;
// the version in the path lets them be cached for good. Xiaolai (CJK, 12 MB) is left out: Excalidraw
// falls back to its CDN for that one, only when someone writes Chinese, Japanese or Korean.
// Only the 3D office has a whiteboard, so a build without it never looks for Excalidraw.
const excalidrawDir = resolve(import.meta.dirname, 'node_modules/@excalidraw/excalidraw');
const EXCALIDRAW_ASSETS = has3d
  ? `/assets/excalidraw-${(JSON.parse(readFileSync(join(excalidrawDir, 'package.json'), 'utf8')) as { version: string }).version}/`
  : '';

function excalidrawFonts(): Plugin {
  const fonts = join(excalidrawDir, 'dist/prod/fonts');
  const files = (dir: string, rel = ''): string[] =>
    readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) return d.name === 'Xiaolai' ? [] : files(dir, r);
      return d.name.endsWith('.woff2') ? [r] : [];
    });
  return {
    name: 'excalidraw-fonts',
    configureServer(server) {
      server.middlewares.use(`${EXCALIDRAW_ASSETS}fonts/`, (req, res, next) => {
        const file = join(fonts, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(fonts + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files(fonts)) this.emitFile({ type: 'asset', fileName: `${EXCALIDRAW_ASSETS.slice(1)}fonts/${f}`, source: readFileSync(join(fonts, f)) });
    },
  };
}

/**
 * The edition in the pages themselves: %EDITION_NAME% becomes the app's name, and a part wrapped in
 * <!--hearth-->...<!--/hearth--> or <!--office-->...<!--/office--> is kept only in that look (the
 * Hearth edition has Hearth's look; HQ and Agent Office keep the cartoon one). Runs before Vite
 * reads the page, so a stylesheet or script inside a dropped part is never bundled.
 */
function editionPages(): Plugin {
  const look = editionId === 'hearth' ? 'hearth' : 'office';
  const drop = look === 'hearth' ? 'office' : 'hearth';
  return {
    name: 'edition-pages',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) =>
        html
          .replace(new RegExp(`[ \\t]*<!--${drop}-->[\\s\\S]*?<!--/${drop}-->[ \\t]*\\r?\\n?`, 'g'), '')
          .replace(new RegExp(`[ \\t]*<!--/?${look}-->[ \\t]*\\r?\\n?`, 'g'), '')
          .replaceAll('%EDITION_NAME%', edition.name),
    },
  };
}

const pages = has3d ? ['index', 'login', 'claim', 'join', 'phone', 'app'] : ['login', 'claim', 'join', 'phone', 'app'];

export default defineConfig({
  root: client,
  publicDir: resolve(import.meta.dirname, 'src/client/public'),
  plugins: [editionPages(), ...(has3d ? [excalidrawFonts()] : [])],
  define: {
    __EXCALIDRAW_ASSETS__: JSON.stringify(EXCALIDRAW_ASSETS),
    __HEARTH_EDITION__: JSON.stringify(editionId),
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      onwarn(warning, warn) {
        // Excalidraw's Radix UI parts start with "use client", which means nothing outside React Server Components.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
      input: Object.fromEntries(pages.map((p) => [p === 'index' ? 'main' : p, join(client, `${p}.html`)])),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Not the string shorthand: that sets changeOrigin, so /api would see Host :4600 while /ws sees
      // Vite's port, and the session cookie (named per port, see auth.ts) would never reach the socket.
      '/api': { target: 'http://localhost:4600', changeOrigin: false },
      '/ws': { target: 'ws://localhost:4600', ws: true },
    },
  },
});
