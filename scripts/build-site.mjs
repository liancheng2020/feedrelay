import { build } from 'vite';
import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

await build({ configFile: resolve('vite.site.config.ts') });
await build({
  configFile: resolve('vite.site.config.ts'),
  publicDir: false,
  build: { ssr: resolve('site/render.ts'), outDir: resolve('.cache/site-ssr'), emptyOutDir: true },
});
const { render } = await import(pathToFileURL(resolve('.cache/site-ssr/render.js')).href);
const htmlPath = resolve('dist/site/index.html');
const html = await readFile(htmlPath, 'utf8');
if (!html.includes('<div id="app"></div>')) throw new Error('SITE_MOUNT_NOT_FOUND');
await writeFile(htmlPath, html.replace('<div id="app"></div>', `<div id="app">${await render()}</div>`));
await writeFile(resolve('dist/site/.nojekyll'), '');

// Publish only this static output, never the repository, app build or private data.
async function verify(dir) {
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (/(?:^\.|\.sqlite|\.env|\.db$)/i.test(name) && name !== '.nojekyll')) throw new Error('UNSAFE_SITE_ARTIFACT');
    if (stat.isDirectory()) await verify(path);
    else if (!/\.(html|css|js|png|svg|xml|txt)$/.test(name) && name !== '.nojekyll') throw new Error('UNEXPECTED_SITE_ARTIFACT');
  }
}
await verify(resolve('dist/site'));
console.log('Static, prerendered site ready: dist/site');
