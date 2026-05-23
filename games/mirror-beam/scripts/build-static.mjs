import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function loadBabelBundle() {
  try {
    return await readFile(resolve(root, "vendor", "babel.min.js"), "utf8");
  } catch {
    const res = await fetch("https://unpkg.com/@babel/standalone@7.25.6/babel.min.js");
    if (!res.ok) throw new Error(`Could not download Babel: ${res.status}`);
    return await res.text();
  }
}

const babelBundle = await loadBabelBundle();
const sandbox = {};
vm.runInNewContext(babelBundle, sandbox);
const Babel = sandbox.Babel;

const inputPath = resolve(root, "src", "App.jsx");
const outputPath = resolve(root, "dist", "mirror-beam.js");

let source = await readFile(inputPath, "utf8");
source = source
  .replace(/^import React, \{ useEffect, useMemo, useRef, useState \} from "react";\s*/m, "const { useEffect, useMemo, useRef, useState } = React;\n")
  .replace("export default function App()", "function App()");

source += `

ReactDOM.createRoot(document.getElementById("root")).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
);
`;

const result = Babel.transform(source, {
  presets: [["react", { runtime: "classic" }]],
  comments: false,
  compact: true,
});

await mkdir(resolve(root, "dist"), { recursive: true });
await writeFile(outputPath, result.code, "utf8");
console.log(`Built ${outputPath}`);
