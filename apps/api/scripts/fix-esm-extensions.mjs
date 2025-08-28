// apps/api/scripts/fix-esm-extensions.mjs
// Add ".js" to relative import/export specifiers in compiled ESM (dist/*).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const distDir = path.resolve(__dirname, "../dist");

const JS_RE = /\.(js|mjs|cjs|json|node)$/i;
const REL_RE =
  /(^\s*import\s+[^'"]*?from\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*;?\s*$)|(^\s*export\s+[^'"]*?from\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*;?\s*$)|(^\s*import\s*\(\s*['"])(\.{1,2}\/[^'"]+)(['"]\s*\))/gm;

function patch(filePath) {
  let code = fs.readFileSync(filePath, "utf8");
  let changed = false;

  code = code.replace(REL_RE, (m, a1, a2, a3, b1, b2, b3, c1, c2, c3) => {
    const prefix = a1 || b1 || c1;
    const spec = a2 || b2 || c2;
    const suffix = a3 || b3 || c3;

    // skip if already has extension
    if (JS_RE.test(spec)) return m;

    changed = true;
    return `${prefix}${spec}.js${suffix}`;
  });

  if (changed) fs.writeFileSync(filePath, code, "utf8");
}

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) patch(p);
  }
}

if (!fs.existsSync(distDir)) {
  console.error(`dist directory not found at ${distDir}`);
  process.exit(1);
}

walk(distDir);
console.log("Patched ESM import/export specifiers in dist/.");
