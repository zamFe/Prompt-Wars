// Bundles the game into a single self-contained HTML file.
//
//   node build.js
//
// The modules use plain `import { a } from './b.js'` and `export` declarations
// with no default exports and no name collisions, so resolving the import graph
// and concatenating in dependency order is enough - no bundler dependency.
//
// Outputs:
//   dist/prompt-wars.html  a complete document you can open with file://
//   dist/artifact.html     the same page as a body fragment, for hosts that
//                          supply their own <html>/<head>/<body>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'public', 'src');
const DIST = path.join(HERE, 'dist');

const IMPORT_RE = /^\s*import\s+[\s\S]*?from\s+['"]([^'"]+)['"];?\s*$/gm;
const BARE_EXPORT_RE = /^\s*export\s*\{[^}]*\}\s*(from\s+['"][^'"]+['"])?;?\s*$/gm;

const seen = new Set();
const ordered = [];

/** Depth-first walk of the import graph, deepest dependency first. */
function collect(file) {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return;
  seen.add(resolved);

  const source = fs.readFileSync(resolved, 'utf8');
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      throw new Error(`${path.relative(HERE, resolved)} imports the bare specifier "${specifier}"; the bundler only handles relative paths.`);
    }
    collect(path.resolve(path.dirname(resolved), specifier));
  }
  ordered.push(resolved);
}

collect(path.join(SRC, 'main.js'));

const chunks = ordered.map((file) => {
  const body = fs
    .readFileSync(file, 'utf8')
    .replace(IMPORT_RE, '')
    .replace(BARE_EXPORT_RE, '')
    .replace(/^\s*export\s+(?=(const|let|var|function|async function|class)\b)/gm, '');

  if (/^\s*export\b/m.test(body)) {
    throw new Error(`Unhandled export syntax in ${path.relative(HERE, file)}`);
  }
  return `// ---- ${path.relative(HERE, file)} ${'-'.repeat(Math.max(0, 60 - path.relative(HERE, file).length))}\n${body.trim()}\n`;
});

// Guard against two modules declaring the same top-level name, which naive
// concatenation would silently break.
const declared = new Map();
for (const [index, chunk] of chunks.entries()) {
  for (const match of chunk.matchAll(/^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1];
    if (declared.has(name)) {
      throw new Error(`Duplicate top-level name "${name}" in ${ordered[index]} and ${declared.get(name)}`);
    }
    declared.set(name, ordered[index]);
  }
}

const styles = fs.readFileSync(path.join(HERE, 'public', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(HERE, 'public', 'index.html'), 'utf8');

const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('could not find <body> in public/index.html');

// The webfont links live in <head>, which the fragment output does not get.
// A stylesheet link is valid in the body, so carry them across verbatim.
const fontLinks = [...html.matchAll(/<link[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>/g)].map((m) => m[0]);
if (!fontLinks.length) console.warn('warning: no webfont links found in public/index.html');

const markup = bodyMatch[1].replace(/\s*<script[\s\S]*?<\/script>\s*/g, '\n');
const title = (html.match(/<title>([^<]*)<\/title>/) ?? [, 'Prompt Wars'])[1];

const fragment = `<title>${title}</title>
${fontLinks.join('\n')}
<style>
${styles.trim()}
</style>
${markup.trim()}
<script type="module">
${chunks.join('\n')}
</script>
`;

// The standalone document lifts the title and font links into a real <head>.
const headLines = 1 + fontLinks.length;
const fragmentLines = fragment.split('\n');

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${fragmentLines.slice(0, headLines).join('\n')}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='16' cy='16' r='11' fill='%23ff5c7a'/></svg>" />
</head>
<body>
${fragmentLines.slice(headLines).join('\n')}
</body>
</html>
`;

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'prompt-wars.html'), standalone);
fs.writeFileSync(path.join(DIST, 'artifact.html'), fragment);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`bundled ${ordered.length} modules`);
console.log(`  dist/prompt-wars.html  ${kb(standalone)}`);
console.log(`  dist/artifact.html     ${kb(fragment)}`);
