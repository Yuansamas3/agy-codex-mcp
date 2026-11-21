import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, 'src');
const distDir = join(__dirname, 'dist');
mkdirSync(distDir, { recursive: true });

// Keep Zod v4 strictly jitless so strict MCP App CSP ("default-src 'none'")
// never emits a console securitypolicyviolation from `new Function("")`.
const zodCspSafePlugin = {
  name: 'zod-csp-safe',
  setup(build) {
    build.onLoad({ filter: /zod[\\/]v4[\\/]core[\\/]util\.js$/ }, (args) => {
      let contents = readFileSync(args.path, 'utf8');
      contents = contents.replace(
        /export const allowsEval = cached\(\(\) => \{[\s\S]*?\n\}\);/,
        'export const allowsEval = cached(() => false);'
      );
      return { contents, loader: 'js' };
    });
  },
};

const jsResult = await esbuild.build({
  entryPoints: [join(srcDir, 'main.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  write: false,
  legalComments: 'none',
  plugins: [zodCspSafePlugin],
});

const cssResult = await esbuild.build({
  entryPoints: [join(srcDir, 'styles.css')],
  bundle: true,
  minify: true,
  write: false,
});

const bundledJs = jsResult.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const bundledCss = cssResult.outputFiles[0].text.replace(/<\/style/gi, '<\\/style');
const template = readFileSync(join(srcDir, 'template.html'), 'utf8');

const finalHtml = template
  .replace('/*__INLINE_CSS__*/', () => bundledCss)
  .replace('/*__INLINE_JS__*/', () => bundledJs);

const outFile = join(distDir, 'app.html');
writeFileSync(outFile, finalHtml, 'utf8');

const sizeKb = (Buffer.byteLength(finalHtml, 'utf8') / 1024).toFixed(1);
console.log(`Built SideDesk single-file MCP App: ${resolve(outFile)} (${sizeKb} KB)`);
