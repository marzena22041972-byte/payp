import fs from "fs/promises";
import path from "path";
import JavaScriptObfuscator from "javascript-obfuscator";

/**
 * Obfuscate a single file or an array of files.
 *
 * Usage from Node:
 *   node --experimental-modules tools/obfuscate.js
 * or import and call from your server startup.
 */

const defaultOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: false,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: false,
  debugProtectionInterval: 0,
  disableConsoleOutput: false,
  identifierNamesGenerator: "hexadecimal",
  rotateStringArray: true,
  stringArray: true,
  stringArrayEncoding: ["rc4"], // ["rc4"] or [] or ["base64"]
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false
};

async function obfuscateFile(inputPath, outputPath, options = {}) {
  const opts = { ...defaultOptions, ...options };

  try {
    const code = await fs.readFile(inputPath, "utf8");
    const obfuscated = JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, obfuscated, "utf8");
    console.log(`✅ Obfuscated: ${inputPath} → ${outputPath}`);
  } catch (err) {
    console.error(`❌ Failed to obfuscate ${inputPath}:`, err);
    throw err;
  }
}

async function obfuscateMultiple(list, outDir, options) {
  for (const infile of list) {
    const name = path.basename(infile);
    const out = path.join(outDir, name);
    await obfuscateFile(infile, out, options);
  }
}

// If called directly (node tools/obfuscate.js) you can hard-code/scan files:
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    const srcDir = path.resolve("./public/js");       // your source JS
    const outDir = path.resolve("./public/obf-js");   // obfuscated output
    // Example: obfuscate all .js files in srcDir
    const entries = await fs.readdir(srcDir, { withFileTypes: true });
    const jsFiles = entries
      .filter(e => e.isFile() && e.name.endsWith(".js"))
      .map(e => path.join(srcDir, e.name));
    await obfuscateMultiple(jsFiles, outDir, {
      // you can override default opts here
      // example: disable control flow for faster output
      controlFlowFlattening: true,
      stringArrayEncoding: ["rc4"]
    });
    console.log("All files obfuscated.");
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { obfuscateFile, obfuscateMultiple }; 