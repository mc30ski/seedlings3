// apps/api/scripts/fix-esm-extensions.mjs
// Make compiled ESM in dist/ resolvable by Node:
//  - add ".js" to relative import/export specifiers with no extension
//  - if specifier points to a directory, use "/index.js"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, "../dist");

const HAS_EXT_RE = /\.(js|mjs|cjs|json|node)$/i;
// Matches: import ... from '...'; export ... from '...'; import('...')
const REL_SPEC_RE =
  /(^\s*import\s+[^'"]*?from\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*;?\s*$)|(^\s*export\s+[^'"]*?from\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*;?\s*$)|(^\s*import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/gm;

function resolveSpecifier(filePath, spec) {
  // Resolve the specifier relative to the importing file
  const baseDir = path.dirname(filePath);
  const abs = path.resolve(baseDir, spec);

  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      // Directory import → require /index.js
      return `${spec.replace(/\/+$/, "")}/index.js`;
    }
  } catch {
    // Not a directory or doesn't exist as given (maybe will exist with .js)
  }

  // If it already has an extension, leave it alone
  if (HAS_EXT_RE.test(spec)) return spec;

  // Otherwise add .js
  return `${spec}.js`;
}

function patchFile(filePath) {
  let code = fs.readFileSync(filePath, "utf8");
  let changed = false;

  code = code.replace(REL_SPEC_RE, (m, a1, a2, a3, b1, b2, b3, c1, c2, c3) => {
    const prefix = a1 || b1 || c1;
    const spec = a2 || b2 || c2;
    const suffix = a3 || b3 || c3;

    const fixed = resolveSpecifier(filePath, spec);
    if (fixed === spec) return m;

    changed = true;
    return `${prefix}${fixed}${suffix}`;
  });

  if (changed) fs.writeFileSync(filePath, code, "utf8");
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) patchFile(p);
  }
}

if (!fs.existsSync(distDir)) {
  console.error(`dist directory not found at ${distDir}`);
  process.exit(1);
}

walk(distDir);
console.log("Patched ESM specifiers in dist/ (added .js or /index.js).");
