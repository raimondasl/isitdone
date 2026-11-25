#!/usr/bin/env node

// src/cli.ts
import { existsSync as existsSync18, readdirSync as readdirSync14, readFileSync as readFileSync13, writeFileSync as writeFileSync8 } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { join as join23, resolve as resolve6 } from "node:path";

// src/config.ts
import { existsSync } from "node:fs";
import { join } from "node:path";

// src/fsutil.ts
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
function stripBom(s) {
  return s.charCodeAt(0) === 65279 ? s.slice(1) : s;
}
function readTextFile(file) {
  return stripBom(readFileSync(file, "utf8"));
}
function readJsonFile(file) {
  return JSON.parse(readTextFile(file));
}
function tryReadJsonFile(file) {
  try {
    return readJsonFile(file);
  } catch {
    return null;
  }
}
function writeFileAtomic(file, content, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content, mode !== void 0 ? { encoding: "utf8", mode } : { encoding: "utf8" });
  try {
    renameSync(tmp, file);
  } catch {
    writeFileSync(file, content, { encoding: "utf8" });
    rmSync(tmp, { force: true });
  }
}

// src/ignore.ts
function ignorePatternError(p) {
  if (typeof p !== "string" || p === "") return "must be a non-empty string";
  if (p.trim() !== p) return "must not start or end with spaces";
  if (p.startsWith("!")) return 'negation ("!") is not supported; list only paths the check never reads';
  if (p.includes("\\")) return "use forward slashes";
  if (/(^|\/)\.\.(\/|$)/.test(p)) return 'must stay inside the project (no "..")';
  const core = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (/^[*?/]*$/.test(core)) return "would match every file, so the check would never run again";
  try {
    compile(p);
  } catch (err2) {
    return `is not a valid pattern (${err2.message})`;
  }
  return null;
}
function parseName(seg) {
  const tokens = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") {
      while (seg[i + 1] === "*") i++;
      tokens.push({ t: "star" });
    } else if (c === "?") {
      tokens.push({ t: "one" });
    } else if (c === "[") {
      const close = seg.indexOf("]", i + 2);
      if (close < 0) {
        tokens.push({ t: "lit", c });
        continue;
      }
      let body = seg.slice(i + 1, close);
      const neg = body.startsWith("!") || body.startsWith("^");
      if (neg) body = body.slice(1);
      const ranges = [];
      for (let k = 0; k < body.length; k++) {
        const a = body[k];
        if (body[k + 1] === "-" && k + 2 < body.length) {
          const b = body[k + 2];
          if (b < a) throw new Error(`range "${a}-${b}" is out of order`);
          ranges.push([a, b]);
          k += 2;
        } else {
          ranges.push([a, a]);
        }
      }
      if (ranges.length === 0) throw new Error("empty character class");
      tokens.push({ t: "class", neg, test: (ch) => ranges.some(([lo, hi]) => ch >= lo && ch <= hi) });
      i = close;
    } else {
      tokens.push({ t: "lit", c });
    }
  }
  return tokens;
}
function compile(pattern) {
  const anchored = pattern.includes("/");
  let s = pattern.startsWith("./") ? pattern.slice(2) : pattern;
  s = s.replace(/^\/+/, "");
  let dirOnly = s.endsWith("/");
  s = s.replace(/\/+$/, "");
  const parts = s.split("/").filter((x) => x !== "");
  while (parts.length > 1 && parts[parts.length - 1] === "**") {
    parts.pop();
    dirOnly = true;
  }
  const segments = [];
  if (!anchored) segments.push("**");
  for (const part of parts) {
    if (part === "**") {
      if (segments[segments.length - 1] !== "**") segments.push("**");
    } else {
      segments.push(parseName(part));
    }
  }
  return { segments, dirOnly };
}
function matchName(tokens, name) {
  let ti = 0;
  let ni = 0;
  let starTi = -1;
  let starNi = 0;
  while (ni < name.length) {
    const tok = tokens[ti];
    const c = name[ni];
    if (tok && tok.t !== "star" && (tok.t === "one" || tok.t === "lit" && tok.c === c || tok.t === "class" && tok.test(c) !== tok.neg)) {
      ti++;
      ni++;
    } else if (tok && tok.t === "star") {
      starTi = ti++;
      starNi = ni;
    } else if (starTi >= 0) {
      ti = starTi + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  while (tokens[ti]?.t === "star") ti++;
  return ti === tokens.length;
}
function matches(c, path, isDir4) {
  const P = c.segments.length;
  const N = path.length;
  let reach = new Array(N + 1).fill(false);
  reach[0] = true;
  for (let i = 0; i < P; i++) {
    const seg = c.segments[i];
    const next = new Array(N + 1).fill(false);
    if (seg === "**") {
      let any = false;
      for (let j = 0; j <= N; j++) {
        any = any || reach[j];
        next[j] = any;
      }
    } else {
      for (let j = 0; j < N; j++) if (reach[j] && matchName(seg, path[j])) next[j + 1] = true;
    }
    reach = next;
  }
  for (let k = 1; k <= N; k++) {
    if (!reach[k]) continue;
    if (k < N) return true;
    if (!c.dirOnly || isDir4) return true;
  }
  return false;
}
var ALWAYS_INPUT_NAMES = /* @__PURE__ */ new Set([
  ".isitdone.json",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".browserslistrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "bunfig.toml",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "rush.json",
  "project.json",
  "jsconfig.json",
  "biome.json",
  "biome.jsonc",
  "dprint.json",
  ".swcrc",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "pytest.ini",
  "conftest.py",
  "noxfile.py",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "pdm.lock",
  "uv.lock",
  "mypy.ini",
  ".mypy.ini",
  "ruff.toml",
  ".ruff.toml",
  ".flake8",
  ".pylintrc",
  "pylintrc",
  ".coveragerc",
  ".pre-commit-config.yaml",
  "go.mod",
  "go.sum",
  "go.work",
  "go.work.sum",
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain",
  "rust-toolchain.toml",
  "clippy.toml",
  ".clippy.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
  "deny.toml",
  "Makefile",
  "makefile",
  "GNUmakefile",
  "justfile",
  "Justfile",
  ".justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "CMakeLists.txt",
  "CMakePresets.json",
  "meson.build",
  "BUILD",
  "BUILD.bazel",
  "WORKSPACE",
  "WORKSPACE.bazel",
  "MODULE.bazel",
  ".bazelrc",
  ".bazelversion",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "gradle-wrapper.properties",
  "pom.xml",
  "Gemfile",
  "Gemfile.lock",
  ".rspec",
  ".rubocop.yml",
  "composer.json",
  "composer.lock",
  "phpunit.xml",
  "phpunit.xml.dist",
  "phpstan.neon",
  "global.json",
  "nuget.config",
  "NuGet.Config",
  "Directory.Build.props",
  "Directory.Build.targets",
  "Directory.Packages.props",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml"
]);
var ALWAYS_INPUT_PATTERNS = [
  /^tsconfig.*\.json$/,
  /^jest[\w.-]*\.json$/,
  // jest.config.json, NestJS test/jest-e2e.json
  /^requirements.*\.(txt|in)$/,
  /^[\w.-]+\.(config|conf|workspace)\.[\w.]+$/,
  // vitest.config.ts, vitest.e2e.config.ts, karma.conf.js, vitest.workspace.ts
  /^\.[\w.-]*(rc|ignore)(\.[\w]+)?$/,
  // .eslintrc.json, .prettierrc, .babelrc, .mocharc.yml, .eslintignore, .prettierignore
  /^\.(golangci|goreleaser|markdownlint|yamllint|stylelint|lintstaged|c8|nyc)[\w.-]*$/,
  /^\.env(\..+)?$/,
  /\.(csproj|fsproj|vbproj|sln|props|targets)$/
];
var ALWAYS_INPUT_PATHS = [/^\.github\/workflows\//, /(^|\/)\.cargo\/config(\.toml)?$/, /(^|\/)requirements\/[^/]+\.(txt|in)$/, /(^|\/)\.mvn\//, /(^|\/)gradle\/wrapper\//];
function alwaysInput(rel) {
  if (ALWAYS_INPUT_PATHS.some((r) => r.test(rel))) return true;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name !== "" && (ALWAYS_INPUT_NAMES.has(name) || ALWAYS_INPUT_PATTERNS.some((r) => r.test(name)));
}
function ignoreMatcher(patterns, prefix) {
  const compiled = [];
  for (const p of patterns) {
    if (ignorePatternError(p) !== null) continue;
    try {
      compiled.push(compile(p));
    } catch {
    }
  }
  return (path) => {
    if (prefix !== "" && !path.startsWith(prefix)) return false;
    const rel = path.slice(prefix.length);
    if (rel === "" || alwaysInput(rel)) return false;
    const isDir4 = rel.endsWith("/");
    const segs = rel.split("/").filter((x) => x !== "");
    return segs.length > 0 && compiled.some((c) => matches(c, segs, isDir4));
  };
}

// src/config.ts
var CONFIG_FILE = ".isitdone.json";
var CHECK_KEYS = /* @__PURE__ */ new Set(["cmd", "kind", "timeout", "cwd", "ignore"]);
function ignoreProblem(value) {
  if (!Array.isArray(value)) return "must be an array of path patterns";
  for (const p of value) {
    const problem = ignorePatternError(p);
    if (problem) return `${JSON.stringify(p)} ${problem}`;
  }
  return null;
}
function loadConfig(root) {
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) {
    let parsed;
    try {
      parsed = readJsonFile(file);
    } catch (err2) {
      throw new Error(`Could not parse ${CONFIG_FILE}: ${err2.message}`);
    }
    return { config: validate(parsed, CONFIG_FILE), source: CONFIG_FILE };
  }
  const pkgFile = join(root, "package.json");
  if (existsSync(pkgFile)) {
    let pkg = null;
    try {
      pkg = readJsonFile(pkgFile);
    } catch {
    }
    if (pkg?.isitdone && typeof pkg.isitdone === "object") {
      return { config: validate(pkg.isitdone, "package.json#isitdone"), source: "package.json#isitdone" };
    }
  }
  return { config: {}, source: null };
}
function validate(c, where) {
  if (c === null || typeof c !== "object" || Array.isArray(c)) throw new Error(`${where}: must be a JSON object`);
  if (c.profile !== void 0 && !["claim-gated", "lite", "full"].includes(c.profile)) {
    throw new Error(`${where}: profile must be one of claim-gated, lite, full`);
  }
  for (const key of ["timeout", "liteTimeout", "maxAttempts"]) {
    const v = c[key];
    if (v !== void 0 && (typeof v !== "number" || !(v > 0))) {
      throw new Error(`${where}: ${key} must be a positive number`);
    }
  }
  if (c.checks !== void 0) {
    if (typeof c.checks !== "object" || c.checks === null || Array.isArray(c.checks)) throw new Error(`${where}: checks must be an object`);
    for (const [id2, v] of Object.entries(c.checks)) {
      if (v === false || typeof v === "string") continue;
      if (typeof v !== "object" || v === null || Array.isArray(v) || v.cmd !== void 0 && typeof v.cmd !== "string") {
        throw new Error(`${where}: checks.${id2} must be a string, false, or an object with cmd, kind, timeout, cwd or ignore`);
      }
      const unknown = v.cmd === void 0 ? Object.keys(v).filter((k) => !CHECK_KEYS.has(k)) : [];
      if (unknown.length > 0) throw new Error(`${where}: checks.${id2} has unknown key${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => JSON.stringify(k)).join(", ")} (allowed: cmd, kind, timeout, cwd, ignore)`);
      if (v.kind !== void 0 && v.kind !== "lite" && v.kind !== "full") throw new Error(`${where}: checks.${id2}.kind must be lite or full`);
    }
  }
  if (c.claimPatterns !== void 0 && (!Array.isArray(c.claimPatterns) || c.claimPatterns.some((p) => typeof p !== "string"))) {
    throw new Error(`${where}: claimPatterns must be an array of strings`);
  }
  if (c.integrity !== void 0 && !["warn", "strict", "off"].includes(c.integrity)) {
    throw new Error(`${where}: integrity must be one of warn, strict, off`);
  }
  if (c.otherSessions !== void 0 && !["respect", "ignore"].includes(c.otherSessions)) {
    throw new Error(`${where}: otherSessions must be one of respect, ignore`);
  }
  if (c.history !== void 0) {
    if (typeof c.history !== "object" || c.history === null) throw new Error(`${where}: history must be an object`);
    if (c.history.exclude !== void 0 && (!Array.isArray(c.history.exclude) || c.history.exclude.some((p) => typeof p !== "string"))) {
      throw new Error(`${where}: history.exclude must be an array of strings`);
    }
  }
  return c;
}

// src/version.ts
var VERSION = true ? "0.11.0" : "0.0.0-dev";

// src/sarif.ts
var LEVEL = { critical: "error", high: "error", medium: "warning", low: "note" };
var RULES = {
  "only-added": "A .only/fit/fdescribe was added; every other test in the file is skipped",
  "skip-added": "A test was skipped or marked as expected failure",
  "todo-added": "A todo placeholder was added",
  "tautology-added": "An assertion that can never fail was added",
  "early-return-added": "A return was added before the assertions; the rest of the test never runs",
  "assertion-weakened": "An assertion was replaced by a weaker one",
  "tolerance-widened": "A numeric tolerance was widened",
  "error-swallowed": "Errors are swallowed inside a test",
  "tests-removed": "The number of tests in a file dropped",
  "tests-moved": "Tests moved to another file",
  "assertions-removed": "The number of assertions in a file dropped",
  "test-file-deleted": "A test file was deleted or moved out of the test locations",
  "config-weakened": "Test or CI configuration was weakened",
  "test-step-removed": "A test command was removed from configuration",
  "ci-workflow-deleted": "A CI workflow was deleted",
  "snapshot-changed": "A snapshot file changed",
  "suppression-added": "An isitdone suppression was added"
};
function toSarif(report, opts = {}) {
  const used = [...new Set(report.findings.map((f) => f.id))];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "isitdone",
            version: VERSION,
            informationUri: "https://github.com/raimondasl/isitdone",
            rules: used.map((id2) => ({
              id: id2,
              name: id2.replace(/-(\w)/g, (_, c) => c.toUpperCase()),
              shortDescription: { text: RULES[id2] ?? id2 },
              helpUri: "https://github.com/raimondasl/isitdone#how-it-decides",
              properties: { tags: ["test-integrity"] }
            }))
          }
        },
        properties: { base: opts.base ?? "HEAD", summary: report.summary },
        results: report.findings.map((f) => ({
          ruleId: f.id,
          level: f.suppressed ? "note" : LEVEL[f.severity],
          message: { text: `${f.message}${f.suppressed ? ` (allowed: ${f.suppressed})` : ""}${f.evidence ? `
${f.evidence}` : ""}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file.replace(/\\/g, "/"), uriBaseId: "%SRCROOT%" },
                ...f.line ? { region: { startLine: f.line } } : {}
              }
            }
          ],
          properties: { severity: f.severity, suppressed: f.suppressed ?? null }
        }))
      }
    ]
  };
}

// src/detect.ts
import { existsSync as existsSync2, readdirSync, statSync } from "node:fs";
import { delimiter, join as join2 } from "node:path";
var KIND_BY_ID = {
  test: "full",
  build: "full",
  typecheck: "lite",
  lint: "lite",
  check: "lite",
  vet: "lite"
};
function readText(file) {
  try {
    return readTextFile(file);
  } catch {
    return "";
  }
}
function has(root, ...names) {
  return names.some((n) => existsSync2(join2(root, n)));
}
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function onPath(name, env = process.env) {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const dirs = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase()) : [""];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join2(d, name + ext);
      if (existsSync2(p)) return p;
    }
    if (process.platform === "win32" && existsSync2(join2(d, name))) return join2(d, name);
  }
  return null;
}
function detectPackageManager(root, pkg) {
  const pm = pkg.packageManager?.split("@")[0];
  if (pm === "pnpm" || pm === "yarn" || pm === "bun" || pm === "npm") return pm;
  if (has(root, "pnpm-lock.yaml")) return "pnpm";
  if (has(root, "yarn.lock")) return "yarn";
  if (has(root, "bun.lockb", "bun.lock")) return "bun";
  if (has(root, "deno.json", "deno.jsonc")) return "deno";
  return "npm";
}
function runScript(pm, script) {
  if (script === "test" && pm !== "deno" && pm !== "bun") return `${pm} test`;
  if (pm === "npm") return `npm run ${script}`;
  if (pm === "deno") return `deno task ${script}`;
  return `${pm} run ${script}`;
}
var NPM_DEFAULT_TEST = /echo\s+["']?Error: no test specified/i;
var NEGATED_WATCH = /--no-watch\w*\b|--watch\w*(?:=|\s+)(?:false|0)\b|\bwatch(?:All)?\s*[:=]\s*false\b/gi;
function isWatchMode(script) {
  const stripped = script.replace(NEGATED_WATCH, "");
  return /\bwatch\b/i.test(stripped) || /\bnodemon\b/.test(stripped);
}
function hasDep(pkg, name) {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}
function readTsconfig(root) {
  const text = readText(join2(root, "tsconfig.json"));
  if (!text) return null;
  const cleaned = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
function isSolutionTsconfig(ts2) {
  if (!ts2) return false;
  const refs = ts2.references;
  const files = ts2.files;
  const include = ts2.include;
  const emptyList = (v) => v === void 0 || Array.isArray(v) && v.length === 0;
  return Array.isArray(refs) && refs.length > 0 && emptyList(files) && emptyList(include);
}
function detectNode(root, out3, config) {
  const pkgFile = join2(root, "package.json");
  if (!existsSync2(pkgFile)) return;
  const pkg = tryReadJsonFile(pkgFile);
  if (!pkg) {
    out3.notes.push("package.json could not be parsed");
    return;
  }
  out3.stacks.push("node");
  const pm = detectPackageManager(root, pkg);
  const scripts = pkg.scripts ?? {};
  const push = (id2, cmd, source = "package.json") => out3.checks.push({ id: id2, cmd, kind: KIND_BY_ID[id2] ?? "full", source });
  if (scripts.test && NPM_DEFAULT_TEST.test(scripts.test)) {
    out3.notes.push('package.json "test" script is the npm placeholder; no test check');
  } else if (scripts.test && isWatchMode(scripts.test)) {
    out3.notes.push(`package.json "test" script looks like watch mode (${scripts.test}); set "checks": { "test": "<non-watch command>" } in .isitdone.json`);
  } else if (scripts.test) {
    push("test", runScript(pm, "test"));
  }
  const typecheckScript = ["typecheck", "type-check", "types", "tsc", "check-types", "check:types"].find((s) => scripts[s]);
  if (typecheckScript) {
    push("typecheck", runScript(pm, typecheckScript));
  } else if (has(root, "tsconfig.json") && hasDep(pkg, "typescript")) {
    if (isSolutionTsconfig(readTsconfig(root))) {
      out3.notes.push('tsconfig.json is a solution-style file (references only); "npx tsc --noEmit" would check nothing. Add a "typecheck" script (e.g. "tsc -b") to enable typechecking');
    } else {
      push("typecheck", pm === "deno" ? "deno check ." : "npx tsc --noEmit", "tsconfig.json");
    }
  }
  const lintScript = ["lint", "eslint", "check:lint"].find((s) => scripts[s]);
  if (lintScript) push("lint", runScript(pm, lintScript));
  if (scripts.build && !isWatchMode(scripts.build)) {
    const hasOther = out3.checks.some((c) => c.id === "test" || c.id === "typecheck");
    if (config.build === true || !hasOther) {
      push("build", runScript(pm, "build"));
    } else {
      out3.notes.push('build script found but skipped (set "build": true in .isitdone.json to include it)');
    }
  }
}
function hasPyTool(pyproject, tool) {
  return new RegExp(`^\\[tool\\.${tool}(\\.|\\])`, "m").test(pyproject);
}
function hasPyDep(pyproject, requirements, name) {
  const re = new RegExp(`["'\\s]${name}(\\[[^\\]]*\\])?\\s*([<>=!~;\\s"']|$)`, "im");
  return re.test(pyproject) || re.test(requirements);
}
function venvEnv(root) {
  if (process.env.VIRTUAL_ENV) return { env: {}, note: null };
  for (const name of [".venv", "venv", "env"]) {
    const dir2 = join2(root, name);
    const bin = join2(dir2, process.platform === "win32" ? "Scripts" : "bin");
    const python = join2(bin, process.platform === "win32" ? "python.exe" : "python");
    if (existsSync2(python)) {
      const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
      return { env: { VIRTUAL_ENV: dir2, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}` }, note: `using virtualenv ${name}/ for Python checks` };
    }
  }
  return { env: {}, note: null };
}
function ciCommandLines(root) {
  const dir2 = join2(root, ".github", "workflows");
  const out3 = [];
  let names = [];
  try {
    names = readdirSync(dir2).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch {
    return out3;
  }
  for (const name of names.slice(0, 20)) {
    const text = readText(join2(dir2, name));
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const rest = m[2].trim();
      if (rest !== "" && !/^[|>][+-]?$/.test(rest)) {
        out3.push({ line: rest.replace(/^["']|["']$/g, ""), file: name });
        continue;
      }
      const indent = m[1].length + (lines[i].trimStart().startsWith("- ") ? 2 : 0);
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (/^\s*/.exec(l)[0].length <= indent) break;
        out3.push({ line: l.trim(), file: name });
      }
    }
  }
  return out3;
}
var SAFE_ARG = /^(?:[\w./=:,@+\-\[\]*]+|"[\w ./=:,@+\-]*"|'[\w ./=:,@+\-]*')$/;
function ciArgsFor(lines, tool, sub) {
  const re = new RegExp(`^(?:(?:uv|poetry|pipenv|pdm|hatch|rye)\\s+run\\s+(?:--?[\\w-]+(?:[= ][\\w.-]+)?\\s+)*)?(?:python3?\\s+-m\\s+)?${tool}${sub ? `\\s+${sub}` : ""}(?=\\s|$)(.*)$`);
  for (const { line, file } of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const args = m[1].trim() === "" ? [] : m[1].trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
    if (args.every((a) => SAFE_ARG.test(a))) return { args, file };
  }
  return null;
}
function mypyConfigHasTargets(root, pyproject, setupCfg) {
  const key = /^\s*(?:files|packages|modules)\s*=/m;
  const section = (text, header) => {
    const m = header.exec(text);
    if (!m) return "";
    const rest = text.slice(m.index + m[0].length);
    const next = /^\[/m.exec(rest);
    return next ? rest.slice(0, next.index) : rest;
  };
  return key.test(section(pyproject, /^\[tool\.mypy\]\s*$/m)) || key.test(section(readText(join2(root, "mypy.ini")), /^\[mypy\]\s*$/m)) || key.test(section(readText(join2(root, ".mypy.ini")), /^\[mypy\]\s*$/m)) || key.test(section(setupCfg, /^\[mypy\]\s*$/m));
}
function detectPython(root, out3) {
  const pyproject = readText(join2(root, "pyproject.toml"));
  const hasPy = pyproject !== "" || has(root, "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "tox.ini", "Pipfile");
  if (!hasPy) return;
  out3.stacks.push("python");
  const requirements = ["requirements.txt", "requirements-dev.txt", "requirements/dev.txt", "dev-requirements.txt"].map((f) => readText(join2(root, f))).join("\n");
  const setupCfg = readText(join2(root, "setup.cfg"));
  const runner = has(root, "uv.lock") ? "uv run " : has(root, "poetry.lock") ? "poetry run " : has(root, "Pipfile.lock") ? "pipenv run " : "";
  if (runner === "") {
    const v = venvEnv(root);
    Object.assign(out3.env, v.env);
    if (v.note) out3.notes.push(v.note);
  }
  const push = (id2, cmd, source) => out3.checks.push({ id: id2, cmd: runner + cmd, kind: KIND_BY_ID[id2] ?? "full", source });
  const pytestConfigured = has(root, "pytest.ini", "conftest.py") || hasPyTool(pyproject, "pytest") || /^\[tool:pytest\]/m.test(setupCfg) || /^\[pytest\]/m.test(readText(join2(root, "tox.ini"))) || hasPyDep(pyproject, requirements, "pytest");
  const testsDir = ["tests", "test"].find((d) => isDir(join2(root, d)));
  const ci = ciCommandLines(root);
  if (pytestConfigured || testsDir) {
    const fromCi = ciArgsFor(ci, "pytest");
    const keep = [];
    if (fromCi) {
      for (let i = 0; i < fromCi.args.length; i++) {
        const a = fromCi.args[i];
        if ((a === "-m" || a === "-k") && i + 1 < fromCi.args.length) keep.push(a, fromCi.args[++i]);
        else if (!a.startsWith("-") && existsSync2(join2(root, a.split("::")[0].replace(/^["']|["']$/g, "")))) keep.push(a);
      }
    }
    if (keep.length > 0) push("test", `pytest -q ${keep.join(" ")}`, `.github/workflows/${fromCi.file}`);
    else push("test", "pytest -q", pytestConfigured ? "pytest config" : `${testsDir}/ directory`);
  }
  const mirrored = (tool, sub) => {
    const c = ciArgsFor(ci, tool, sub);
    return c ? { cmd: [tool, sub, ...c.args].filter(Boolean).join(" "), source: `.github/workflows/${c.file}` } : null;
  };
  const srcLayout = isDir(join2(root, "src"));
  if (has(root, "ruff.toml", ".ruff.toml") || hasPyTool(pyproject, "ruff") || hasPyDep(pyproject, requirements, "ruff")) {
    const m = mirrored("ruff", "check");
    push("lint", m ? m.cmd : "ruff check .", m ? m.source : "ruff config");
  } else if (has(root, ".flake8") || /^\[flake8\]/m.test(setupCfg) || hasPyDep(pyproject, requirements, "flake8")) {
    const m = mirrored("flake8");
    push("lint", m ? m.cmd : "flake8", m ? m.source : "flake8 config");
  }
  if (has(root, "mypy.ini", ".mypy.ini") || hasPyTool(pyproject, "mypy") || /^\[mypy\]/m.test(setupCfg) || hasPyDep(pyproject, requirements, "mypy")) {
    const m = mirrored("mypy");
    if (m) push("typecheck", m.cmd, m.source);
    else if (mypyConfigHasTargets(root, pyproject, setupCfg)) push("typecheck", "mypy", "mypy config (files/packages)");
    else if (srcLayout) push("typecheck", "mypy src", "mypy config, src/ layout");
    else push("typecheck", "mypy .", "mypy config");
  } else if (has(root, "pyrightconfig.json") || hasPyTool(pyproject, "pyright") || hasPyDep(pyproject, requirements, "pyright")) {
    const m = mirrored("pyright");
    push("typecheck", m ? m.cmd : "pyright", m ? m.source : "pyright config");
  }
}
function detectGo(root, out3) {
  if (!has(root, "go.mod")) return;
  out3.stacks.push("go");
  out3.checks.push({ id: "vet", cmd: "go vet ./...", kind: "lite", source: "go.mod" });
  out3.checks.push({ id: "test", cmd: "go test ./...", kind: "full", source: "go.mod" });
}
function detectRust(root, out3) {
  if (!has(root, "Cargo.toml")) return;
  out3.stacks.push("rust");
  out3.checks.push({ id: "check", cmd: "cargo check --all-targets", kind: "lite", source: "Cargo.toml" });
  out3.checks.push({ id: "test", cmd: "cargo test", kind: "full", source: "Cargo.toml" });
}
function detectDotnet(root, out3) {
  let entries = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const hasProject = entries.some((e) => /\.(sln|slnx|csproj|fsproj)$/i.test(e));
  if (!hasProject) return;
  out3.stacks.push("dotnet");
  out3.env.MSBUILDDISABLENODEREUSE = "1";
  out3.checks.push({ id: "build", cmd: "dotnet build --nologo -v q", kind: "lite", source: "dotnet project" });
  out3.checks.push({ id: "test", cmd: "dotnet test --nologo -v q --no-build", kind: "full", source: "dotnet project" });
}
function detectJvm(root, out3) {
  if (has(root, "build.gradle", "build.gradle.kts")) {
    out3.stacks.push("gradle");
    const wrapper = has(root, "gradlew") ? process.platform === "win32" ? "gradlew.bat" : "./gradlew" : "gradle";
    out3.checks.push({ id: "test", cmd: `${wrapper} test -q`, kind: "full", source: "build.gradle" });
  } else if (has(root, "pom.xml")) {
    out3.stacks.push("maven");
    const wrapper = has(root, "mvnw") ? process.platform === "win32" ? "mvnw.cmd" : "./mvnw" : "mvn";
    out3.checks.push({ id: "test", cmd: `${wrapper} -q -B test`, kind: "full", source: "pom.xml" });
  }
}
function detectMakefile(root, out3) {
  const mk = readText(join2(root, "Makefile")) || readText(join2(root, "makefile"));
  if (!mk) return;
  const targets = /* @__PURE__ */ new Set();
  for (const m of mk.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) targets.add(m[1]);
  if (targets.size === 0) return;
  const want = [
    ["test", ["test", "tests", "check"]],
    ["lint", ["lint"]],
    ["typecheck", ["typecheck", "type-check", "mypy"]]
  ];
  const wanted = want.filter(([id2, names]) => !out3.checks.some((c) => c.id === id2) && names.some((n) => targets.has(n)));
  if (wanted.length === 0) return;
  let make = "make";
  if (process.platform === "win32") {
    const found = onPath("make") ? "make" : onPath("mingw32-make") ? "mingw32-make" : null;
    if (!found) {
      out3.notes.push('Makefile targets found but "make" is not on PATH; install make or set the commands in .isitdone.json');
      return;
    }
    make = found;
  }
  out3.stacks.push("make");
  for (const [id2, names] of wanted) {
    const t = names.find((n) => targets.has(n));
    out3.checks.push({ id: id2, cmd: `${make} ${t}`, kind: KIND_BY_ID[id2] ?? "full", source: "Makefile" });
  }
}
function applyConfig(out3, config) {
  if (!config.checks) return;
  for (const [id2, value] of Object.entries(config.checks)) {
    const existing = out3.checks.findIndex((c) => c.id === id2);
    if (value === false) {
      if (existing >= 0) out3.checks.splice(existing, 1);
      out3.notes.push(`check "${id2}" disabled by config`);
      continue;
    }
    const cfg = typeof value === "string" ? { cmd: value } : value;
    const detected = existing >= 0 ? out3.checks[existing] : null;
    if (cfg.cmd === void 0 && !detected) {
      out3.notes.push(`check "${id2}" in config has no "cmd" and no "${id2}" check was detected; nothing to apply it to`);
      continue;
    }
    const check = cfg.cmd === void 0 && detected ? { ...detected } : { id: id2, cmd: cfg.cmd, kind: detected?.kind ?? KIND_BY_ID[id2] ?? "full", source: "config" };
    if (cfg.kind !== void 0) check.kind = cfg.kind;
    if (cfg.timeout !== void 0) check.timeout = cfg.timeout;
    if (cfg.cwd !== void 0) check.cwd = cfg.cwd;
    if (cfg.ignore !== void 0) {
      const problem = ignoreProblem(cfg.ignore);
      if (problem) {
        delete check.ignore;
        out3.notes.push(`checks.${id2}.ignore ${problem}; the list is not used, so "${id2}" runs every time until it is fixed`);
      } else if (cfg.ignore.length > 0) {
        check.ignore = [...cfg.ignore];
      } else {
        delete check.ignore;
      }
    }
    if (existing >= 0) out3.checks[existing] = check;
    else out3.checks.push(check);
  }
}
function order(checks) {
  const rank = (c) => c.kind === "lite" ? 0 : 1;
  return [...checks].sort((a, b) => rank(a) - rank(b));
}
function detectChecks(root, config = {}) {
  const out3 = { checks: [], notes: [], stacks: [], env: {} };
  detectNode(root, out3, config);
  detectPython(root, out3);
  detectGo(root, out3);
  detectRust(root, out3);
  detectDotnet(root, out3);
  detectJvm(root, out3);
  detectMakefile(root, out3);
  applyConfig(out3, config);
  out3.checks = order(out3.checks);
  return out3;
}

// src/doctor.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync10, readFileSync as readFileSync7 } from "node:fs";
import { join as join14 } from "node:path";

// src/git.ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync as existsSync3, readdirSync as readdirSync2, realpathSync, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as dirname2, isAbsolute, join as join3, relative, resolve, sep } from "node:path";
var RECEIPT_DIR = ".isitdone";
function git(args, cwd, env, input) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    input
  });
  if (r.error) return { ok: false, stdout: "", stderr: r.error.message };
  return { ok: r.status === 0, stdout: (r.stdout ?? "").replace(/\r?\n$/, ""), stderr: (r.stderr ?? "").trim() };
}
function out(args, cwd) {
  const r = git(args, cwd);
  return r.ok ? r.stdout : null;
}
function gitCommonDir(cwd) {
  const d = out(["rev-parse", "--git-common-dir"], cwd);
  if (!d) return null;
  const abs = resolve(cwd, d);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}
function gitTopLevel(cwd) {
  const top = out(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return null;
  try {
    return realpathSync.native(top);
  } catch {
    return resolve(top);
  }
}
function workingTreeHash(top, depth = 0, ignored = []) {
  const tmp = join3(tmpdir(), `isitdone-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmp };
  try {
    const rel = out(["rev-parse", "--git-path", "index"], top);
    if (rel) {
      const p = isAbsolute(rel) ? rel : join3(top, rel);
      if (existsSync3(p)) copyFileSync(p, tmp);
    }
    const exclude = `:(exclude)${RECEIPT_DIR}`;
    const others = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ".", exclude], top, env);
    if (!others.ok) return { tree: null, error: `git ls-files failed: ${others.stderr}` };
    const changed = git(["ls-files", "-z", "--modified", "--deleted", "--", ".", exclude], top, env);
    if (!changed.ok) return { tree: null, error: `git ls-files failed: ${changed.stderr}` };
    const stage = git(["ls-files", "-z", "--stage"], top, env);
    const gitlinkSha = /* @__PURE__ */ new Map();
    for (const l of (stage.ok ? stage.stdout : "").split("\0")) {
      if (!l.startsWith("160000 ")) continue;
      const path = l.split("	")[1] ?? "";
      if (path) gitlinkSha.set(path, l.slice(7, 47));
    }
    const gitlinks = new Set(gitlinkSha.keys());
    const nested = [];
    const paths = /* @__PURE__ */ new Set();
    for (const p of [...others.stdout.split("\0"), ...changed.stdout.split("\0")]) {
      if (p === "") continue;
      if (p.endsWith("/")) nested.push(p.slice(0, -1));
      else if (!gitlinks.has(p)) paths.add(p);
    }
    if (paths.size > 0) {
      const upd = git(["update-index", "--info-only", "--add", "--remove", "-z", "--stdin"], top, env, [...paths].join("\0") + "\0");
      if (!upd.ok) return { tree: null, error: `git update-index failed: ${upd.stderr}` };
    }
    const wt = git(["write-tree", "--missing-ok"], top, env);
    if (!wt.ok) return { tree: null, error: `git write-tree failed: ${wt.stderr}` };
    const inner = [...gitlinks, ...nested].sort();
    const innerHash = /* @__PURE__ */ new Map();
    let tree = wt.stdout.trim();
    if (inner.length > 0) {
      const h = createHash("sha1").update(tree);
      for (const path of inner) {
        const dir2 = resolve(top, path);
        let contribution;
        if (depth >= 8 || dir2 === top || !dir2.startsWith(top) || !existsSync3(join3(dir2, ".git"))) {
          contribution = gitlinkSha.get(path) ?? "missing";
        } else {
          const sub = workingTreeHash(dir2, depth + 1);
          if (sub.error) return { tree: null, error: `submodule ${path}: ${sub.error}` };
          contribution = sub.tree ?? "unknown";
        }
        h.update("\0").update(path).update("\0").update(contribution);
        innerHash.set(path, contribution);
      }
      tree = h.digest("hex");
    }
    if (ignored.length === 0) return { tree, error: null };
    const staged = git(["ls-files", "-s", "-z"], top, env);
    const entries = staged.ok ? staged.stdout.split("\0").filter((e) => e !== "") : null;
    const inputs = ignored.map((isIgnored) => {
      if (!entries) return null;
      const h = createHash("sha256");
      let kept = 0;
      for (const e of entries) {
        if (e.startsWith("160000 ")) continue;
        if (isIgnored(e.slice(e.indexOf("	") + 1))) continue;
        h.update(e).update("\0");
        kept++;
      }
      for (const [path, contribution] of innerHash) {
        if (isIgnored(path) || isIgnored(`${path}/`)) continue;
        h.update("repo\0").update(path).update("\0").update(contribution).update("\0");
        kept++;
      }
      return kept > 0 ? h.digest("hex") : null;
    });
    return { tree, error: null, inputs };
  } catch (err2) {
    return { tree: null, error: err2.message };
  } finally {
    try {
      rmSync2(tmp, { force: true });
      rmSync2(tmp + ".lock", { force: true });
    } catch {
    }
  }
}
function dirtyPathSet(top) {
  const status = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ".", `:(exclude)${RECEIPT_DIR}`], top);
  const paths = /* @__PURE__ */ new Set();
  if (!status.ok) return paths;
  const parts = status.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const old = parts[++i];
      if (old) paths.add(old);
    }
  }
  return paths;
}
function existingPathsChanged(top, before, after) {
  if (!/^[0-9a-f]{40,64}$/.test(before) || !/^[0-9a-f]{40,64}$/.test(after) || before === after) return false;
  const r = git(["diff-tree", "-r", "--name-status", "--no-renames", "-z", before, after], top);
  if (!r.ok) return false;
  const parts = r.stdout.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i] === "M" || parts[i] === "D") return true;
  return false;
}
function trackedPaths(top) {
  const r = git(["ls-files", "-z"], top);
  return r.ok ? r.stdout.split("\0").filter((p) => p !== "") : [];
}
function gitPrefix(top, dir2) {
  let real = dir2;
  try {
    real = realpathSync.native(dir2);
  } catch {
  }
  const rel = relative(top, real);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/") + "/";
}
function gitInfo(cwd, ignoreSets = []) {
  const top = gitTopLevel(cwd);
  if (!top) {
    return { isRepo: false, root: cwd, head: null, headShort: null, branch: null, tree: "nogit", treeError: null, dirtyFiles: 0, dirtyPaths: [], ...ignoreSets.length ? { inputs: ignoreSets.map(() => null) } : {} };
  }
  const head = out(["rev-parse", "HEAD"], top);
  const branch = out(["rev-parse", "--abbrev-ref", "HEAD"], top);
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", ".", `:(exclude)${RECEIPT_DIR}`], top);
  const dirtyPaths = (status.ok ? status.stdout : "").split("\n").filter((l) => l.trim() !== "").map((l) => l.slice(3).trim());
  const prefix = ignoreSets.length ? gitPrefix(top, cwd) : null;
  const matchers = ignoreSets.map((patterns) => prefix === null ? () => false : ignoreMatcher(patterns, prefix));
  const { tree, error, inputs } = workingTreeHash(top, 0, matchers);
  return {
    isRepo: true,
    root: top,
    head,
    headShort: head ? head.slice(0, 7) : null,
    branch: branch === "HEAD" ? null : branch,
    tree: tree ?? "unknown",
    treeError: error,
    dirtyFiles: dirtyPaths.length,
    dirtyPaths: dirtyPaths.slice(0, 20),
    ...ignoreSets.length ? { inputs: inputs ?? ignoreSets.map(() => null) } : {}
  };
}
var PROJECT_MARKERS = [".isitdone.json", "package.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pytest.ini", "go.mod", "Cargo.toml", "Makefile", "makefile", "build.gradle", "build.gradle.kts", "pom.xml"];
function hasProjectMarker(dir2) {
  if (PROJECT_MARKERS.some((m) => existsSync3(join3(dir2, m)))) return true;
  try {
    return readdirSync2(dir2).some((e) => /\.(sln|slnx|csproj|fsproj)$/i.test(e));
  } catch {
    return false;
  }
}
function findRoot(cwd, knownTop) {
  let start = resolve(cwd);
  try {
    start = realpathSync.native(start);
  } catch {
  }
  const top = knownTop !== void 0 ? knownTop : gitTopLevel(start);
  let dir2 = start;
  for (; ; ) {
    if (hasProjectMarker(dir2)) return dir2;
    if (top && resolve(dir2) === top) return top;
    const parent = dirname2(dir2);
    if (parent === dir2) return top ?? start;
    if (top && !parent.startsWith(top)) return top;
    dir2 = parent;
  }
}

// src/init.ts
import { chmodSync, existsSync as existsSync7, mkdirSync as mkdirSync4, readdirSync as readdirSync5, readFileSync as readFileSync5, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname3, join as join10, relative as relative2, resolve as resolve3, sep as sep2 } from "node:path";

// src/hosts.ts
import { homedir } from "node:os";
import { join as join4, resolve as resolve2 } from "node:path";

// src/opencode-plugin.ts
var OPENCODE_PLUGIN_MARKER = "// isitdone-opencode-plugin v1";
var OPENCODE_FOLLOWUP_MARKER = "[isitdone]";
var RE_STOP = /^const STOP_COMMAND = ("(?:[^"\\]|\\.)*");$/m;
var RE_EDIT = /^const EDIT_COMMAND = ("(?:[^"\\]|\\.)*"|null);$/m;
var RE_TIMEOUT = /^const STOP_TIMEOUT_MS = (\d+);$/m;
function renderOpencodePlugin(o) {
  return `${OPENCODE_PLUGIN_MARKER}
// Generated by \`isitdone init --agent opencode\`. Re-run init to update it; \`isitdone uninstall --agent opencode\` removes it.
// OpenCode has no blocking end-of-turn hook, so this plugin runs \`isitdone hook\` when a session goes idle and, when the
// checks fail, sends the report back into the same session as a "${OPENCODE_FOLLOWUP_MARKER} ..." user message so the agent keeps working.
// After edit/write/apply_patch it runs the warn-only edit hook and appends its note to the tool result.
// Plugin API: https://opencode.ai/docs/plugins/
import { spawn } from "node:child_process";

const STOP_COMMAND = ${JSON.stringify(o.stopCommand)};
const EDIT_COMMAND = ${o.editCommand === null ? "null" : JSON.stringify(o.editCommand)};
const STOP_TIMEOUT_MS = ${Math.round(o.timeoutSeconds * 1e3)};
const EDIT_TIMEOUT_MS = ${Math.round(o.editTimeoutSeconds * 1e3)};
const MARKER = ${JSON.stringify(OPENCODE_FOLLOWUP_MARKER)};
const EDIT_TOOLS = ["edit", "write", "apply_patch"];

// Run a hook command with the payload on stdin and resolve with its JSON stdout, or null. Never throws and never
// blocks the server's event loop. On Windows kill() reaches the shell, not necessarily npx's children (best effort).
function run(command, payload, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = out.trim();
      if (!text.startsWith("{")) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish();
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const textOf = (m) => (m.parts || []).filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("\\n");
const isOurs = (m) => m.info && m.info.role === "user" && (m.parts || []).some((p) => p && p.type === "text" && typeof p.text === "string" && p.text.startsWith(MARKER));
const describe = (e) => (e && e.message ? e.message : String(e));
// A user message whose text parts are all synthetic is OpenCode talking to itself (shell runs, compaction auto-continue), not a prompt.
const synthetic = (m) => { const t = (m.parts || []).filter((p) => p && p.type === "text"); return t.length > 0 && t.every((p) => p.synthetic); };
// One check per session at a time: a second idle while the checks run would grade a stale turn or inject twice.
const inflight = new Set();
// Subagent session id -> the top-level session it works for.
const owners = new Map();

export const IsItDone = async ({ client, directory, worktree }) => {
  const root = worktree && worktree !== "/" ? worktree : directory || process.cwd(); // OpenCode reports "/" outside version control
  const log = async (level, message) => {
    try {
      await client.app.log({ body: { service: "isitdone", level, message } });
    } catch {}
  };
  // Only top-level sessions are graded, so a subagent's edits are recorded under the session it works for; recorded
  // under its own id they would look like another session's files to its parent.
  const ownerOf = async (id) => {
    if (!id) return id;
    if (owners.has(id)) return owners.get(id);
    let owner = id;
    try {
      for (let i = 0; i < 8; i++) {
        const s = (await client.session.get({ path: { id: owner } })).data;
        if (!s || !s.parentID) break;
        owner = s.parentID;
      }
      owners.set(id, owner);
    } catch {}
    return owner;
  };
  const hooks = {
    event: async ({ event }) => {
      if (!event || event.type !== "session.idle") return;
      const id = event.properties && event.properties.sessionID;
      if (!id || inflight.has(id)) return;
      inflight.add(id);
      try {
        const session = (await client.session.get({ path: { id } })).data;
        if (!session || session.parentID) return; // subagent sessions are graded through their parent
        const messages = (await client.session.messages({ path: { id } })).data || [];
        let user = null;
        let assistant = null;
        for (let i = messages.length - 1; i >= 0 && !(user && assistant); i--) {
          const m = messages[i];
          if (!m || !m.info) continue;
          if (!assistant && m.info.role === "assistant") assistant = m;
          else if (!user && m.info.role === "user" && !synthetic(m)) user = m;
        }
        if (!user || !assistant || assistant.info.error) return; // aborted or errored turn: nothing to grade
        if (textOf(assistant) === "" || (assistant.info.parentID && assistant.info.parentID !== user.info.id)) return; // a !shell run or a tool-only message, not the end of a turn
        // Trailing user messages that we injected = how many times we already sent this turn back.
        let loop = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (!m || !m.info || m.info.role !== "user") continue;
          if (isOurs(m)) loop++;
          else if (synthetic(m)) continue;
          else break;
        }
        const payload = {
          hook_event_name: "session.idle",
          session_id: id,
          message_id: user.info.id,
          cwd: directory,
          worktree,
          last_assistant_message: textOf(assistant),
          stop_hook_active: loop > 0,
          loop_count: loop,
        };
        const out = await run(STOP_COMMAND, payload, root, STOP_TIMEOUT_MS);
        if (out && out.decision === "block" && typeof out.reason === "string" && out.reason !== "") {
          // Still the same turn? Another prompt may have arrived while the checks ran.
          const latest = (await client.session.messages({ path: { id } })).data || [];
          const last = latest.length ? latest[latest.length - 1] : null;
          if (!last || !last.info || last.info.id !== assistant.info.id) return;
          // Re-prompt under the session's own agent and model; without them OpenCode would switch to its defaults.
          const body = { parts: [{ type: "text", text: MARKER + " " + out.reason }] };
          if (user.info.agent) body.agent = user.info.agent;
          if (user.info.model && user.info.model.providerID && user.info.model.modelID) body.model = { providerID: user.info.model.providerID, modelID: user.info.model.modelID };
          if (user.info.model && user.info.model.variant) body.variant = user.info.model.variant;
          await client.session.promptAsync({ path: { id }, body });
        }
      } catch (e) {
        await log("error", "stop check failed: " + describe(e));
      } finally {
        inflight.delete(id);
      }
    },
  };
  if (EDIT_COMMAND) {
    hooks["tool.execute.after"] = async (input, output) => {
      if (!input || EDIT_TOOLS.indexOf(input.tool) < 0) return;
      try {
        const payload = { hook_event_name: "tool.execute.after", session_id: await ownerOf(input.sessionID), cwd: directory, worktree, tool_name: input.tool, tool_input: input.args || {} };
        const out = await run(EDIT_COMMAND, payload, root, EDIT_TIMEOUT_MS);
        const note = out && out.hookSpecificOutput && typeof out.hookSpecificOutput.additionalContext === "string" ? out.hookSpecificOutput.additionalContext : "";
        if (note && output && typeof output.output === "string") output.output += "\\n\\n" + note;
      } catch (e) {
        await log("warn", "edit check failed: " + describe(e));
      }
    };
  }
  return hooks;
};
`;
}
function parseOpencodePlugin(text) {
  const head = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  if (!head.startsWith(OPENCODE_PLUGIN_MARKER)) return null;
  const lit = (m) => {
    if (!m || m[1] === void 0 || m[1] === "null") return null;
    try {
      const v = JSON.parse(m[1]);
      return typeof v === "string" && v !== "" ? v : null;
    } catch {
      return null;
    }
  };
  const t = RE_TIMEOUT.exec(head);
  return { stopCommand: lit(RE_STOP.exec(head)), editCommand: lit(RE_EDIT.exec(head)), timeoutSeconds: t ? Number(t[1]) / 1e3 : null };
}

// src/hosts.ts
var HOST_NAMES = ["claude", "codex", "cursor", "gemini", "copilot", "qwen", "goose", "droid", "devin", "augment", "opencode", "junie"];
var HOOK_MARKER = /\bisitdone\b[^\n]*\bhook\b/;
function isOurCommand(v) {
  return typeof v === "string" && HOOK_MARKER.test(v);
}
function isEditCommand(v) {
  return isOurCommand(v) && /--event[=\s]+edit\b/.test(v);
}
function str(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function obj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function flag(v) {
  return typeof v === "boolean" ? v : null;
}
function xdgConfig() {
  return str(process.env.XDG_CONFIG_HOME) ?? join4(homedir(), ".config");
}
function devinConfigDir() {
  return process.platform === "win32" ? join4(str(process.env.APPDATA) ?? join4(homedir(), "AppData", "Roaming"), "devin") : join4(xdgConfig(), "devin");
}
function pickRoot(roots) {
  const list = roots.filter((r) => typeof r === "string" && r !== "");
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const cwd = resolve2(process.cwd()).toLowerCase();
  const inside = list.find((r) => {
    const rr = resolve2(r).toLowerCase();
    return cwd === rr || cwd.startsWith(rr.endsWith("\\") || rr.endsWith("/") ? rr : rr + (process.platform === "win32" ? "\\" : "/"));
  });
  return inside ?? list[0];
}
function patchPaths(patch) {
  const out3 = [];
  for (const m of patch.matchAll(/^\s*\*\*\* (Update File|Add File|Delete File|Move to): (.+?)\s*$/gm)) {
    if (m[1] === "Move to" && out3.length > 0) out3.pop();
    out3.push(m[2]);
  }
  return [...new Set(out3)];
}
function hooksMap(settings, unwrapped, create) {
  if (unwrapped) return settings;
  const existing = obj(settings.hooks);
  if (existing) return existing;
  return create ? settings.hooks = {} : null;
}
function carries(have, want) {
  const ho = obj(have);
  const wo = obj(want);
  if (ho && wo) return Object.entries(wo).every(([k, v]) => carries(ho[k], v));
  return JSON.stringify(have) === JSON.stringify(want);
}
function registerClaudeStyle(settings, event, command, timeout, opts) {
  const hooks = hooksMap(settings, opts.unwrapped, true);
  const groups = hooks[event] = arr(hooks[event]);
  const groupExtra = opts.groupExtra ?? {};
  for (const g of groups) {
    const go = obj(g);
    if (!go) continue;
    for (const h of arr(go.hooks)) {
      const ho = obj(h);
      if (ho && opts.isMine(ho.command)) {
        const sameGroup = (opts.matcher === void 0 || go.matcher === opts.matcher) && Object.entries(groupExtra).every(([k, v]) => carries(go[k], v));
        if (ho.command === command && ho.timeout === timeout && sameGroup) return false;
        ho.command = command;
        ho.timeout = timeout;
        if (opts.matcher !== void 0) go.matcher = opts.matcher;
        for (const [k, v] of Object.entries(groupExtra)) {
          const existing = obj(go[k]);
          go[k] = existing && obj(v) ? { ...existing, ...v } : v;
        }
        return true;
      }
    }
  }
  groups.push({ ...opts.matcher !== void 0 ? { matcher: opts.matcher } : {}, ...groupExtra, hooks: [{ type: "command", command, timeout, ...opts.extra ?? {} }] });
  return true;
}
function registeredClaudeStyle(settings, event, isMine, unwrapped) {
  for (const g of arr(hooksMap(settings, unwrapped, false)?.[event])) {
    for (const h of arr(obj(g)?.hooks)) {
      const cmd = obj(h)?.command;
      if (isMine(cmd)) return cmd;
    }
  }
  return null;
}
function unregisterClaudeStyle(settings, event, isMine, unwrapped) {
  const hooks = hooksMap(settings, unwrapped, false);
  if (!hooks) return false;
  const groups = arr(hooks[event]);
  let changed = false;
  const kept = groups.filter((g) => {
    const go = obj(g);
    if (!go) return true;
    const before = arr(go.hooks).length;
    go.hooks = arr(go.hooks).filter((h) => !isMine(obj(h)?.command));
    if (go.hooks.length !== before) changed = true;
    return go.hooks.length > 0;
  });
  if (kept.length !== groups.length) changed = true;
  if (kept.length === 0) delete hooks[event];
  else hooks[event] = kept;
  if (!unwrapped && Object.keys(hooks).length === 0) delete settings.hooks;
  return changed;
}
var isStop = (v) => isOurCommand(v) && !isEditCommand(v);
function additionalContext(eventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } });
}
function editFiles(raw) {
  const input = obj(raw.tool_input) ?? {};
  const files = [];
  for (const k of ["file_path", "filePath", "notebook_path", "path"]) {
    const v = str(input[k]);
    if (v) files.push(v);
  }
  if (typeof input.command === "string" && /\*\*\* (?:Begin Patch|Update File|Add File)/.test(input.command)) files.push(...patchPaths(input.command));
  if (typeof input.patchText === "string") files.push(...patchPaths(input.patchText));
  for (const e of arr(input.edits)) {
    const p = str(obj(e)?.file_path);
    if (p) files.push(p);
  }
  return [...new Set(files)];
}
function parseClaudeShape(raw) {
  return {
    sessionId: str(raw.session_id),
    turnId: str(raw.prompt_id),
    cwd: str(raw.cwd),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: arr(raw.background_tasks).length,
    permissionMode: str(raw.permission_mode),
    hookEventName: str(raw.hook_event_name)
  };
}
var claude = {
  name: "claude",
  displayName: "Claude Code",
  kind: "json",
  event: "Stop",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".claude", "settings.json") : join4(homedir(), ".claude", "settings.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".claude") : join4(homedir(), ".claude")],
  // Also tolerates Cursor-shaped payloads: Cursor can run .claude/settings.json hooks when third-party configs are enabled.
  // Devin Local / Devin CLI and Continue (cn) load these hooks too: Devin sends no cwd (DEVIN_PROJECT_DIR instead) and
  // Continue hard-codes stop_hook_active: true, so under Continue the flag says nothing and is treated as absent.
  // verified: docs.devin.ai lifecycle-hooks (DEVIN_PROJECT_DIR, .claude paths loaded by default);
  // continuedev/continue extensions/cli/src/hooks/fireHook.ts (fireStop) and hookRunner.ts (CONTINUE_PROJECT_DIR).
  parse: (raw) => ({
    sessionId: str(raw.session_id) ?? str(raw.conversation_id),
    turnId: str(raw.prompt_id) ?? str(raw.generation_id),
    cwd: str(raw.cwd) ?? pickRoot(arr(raw.workspace_roots)) ?? str(process.env.DEVIN_PROJECT_DIR) ?? str(process.env.CLAUDE_PROJECT_DIR),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: str(process.env.CONTINUE_PROJECT_DIR) ? null : raw.stop_hook_active === true,
    loopCount: num(raw.loop_count),
    status: str(raw.status),
    backgroundTasks: arr(raw.background_tasks).length,
    permissionMode: str(raw.permission_mode),
    hookEventName: str(raw.hook_event_name)
  }),
  allow: (systemMessage) => systemMessage ? JSON.stringify({ systemMessage }) : "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Claude Code reloads settings automatically; if the hook does not show in /hooks within a few seconds, restart the session. This registration is also loaded by Devin Local / Devin CLI and Continue (cn), and Copilot CLI has been seen running .claude/settings.json hooks too: keep a single isitdone registration per repo so the checks do not run twice.",
  synthetic: (root, message) => ({
    session_id: "isitdone-doctor",
    transcript_path: join4(root, ".isitdone", "doctor-transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: message,
    background_tasks: []
  }),
  edit: {
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit",
    register: (s, command, timeout) => registerClaudeStyle(s, "PostToolUse", command, timeout, { matcher: "Edit|Write|MultiEdit", isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, "PostToolUse", isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, "PostToolUse", isEditCommand),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd) ?? pickRoot(arr(raw.workspace_roots)), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext("PostToolUse", text),
    silent: () => "",
    synthetic: (root, file) => ({ session_id: "isitdone-doctor", cwd: root, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join4(root, file), old_string: "a", new_string: "b" }, tool_response: { filePath: join4(root, file), success: true }, tool_use_id: "doctor" })
  }
};
var codex = {
  name: "codex",
  displayName: "Codex CLI",
  kind: "json",
  event: "Stop",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".codex", "hooks.json") : join4(homedir(), ".codex", "hooks.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".codex") : join4(homedir(), ".codex")],
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: str(raw.turn_id),
    cwd: str(raw.cwd),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: str(raw.permission_mode),
    hookEventName: str(raw.hook_event_name)
  }),
  // Codex validates output strictly (no extra keys) and prefers empty stdout for "allow".
  allow: (systemMessage) => systemMessage ? JSON.stringify({ systemMessage }) : "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Codex requires you to trust new hooks: open Codex in this repo and run /hooks, then trust the isitdone entries. Re-trust after any change to the commands.",
  synthetic: (root, message) => ({
    session_id: "isitdone-doctor",
    turn_id: "turn-1",
    transcript_path: null,
    cwd: root,
    hook_event_name: "Stop",
    model: "doctor",
    permission_mode: "default",
    stop_hook_active: false,
    last_assistant_message: message
  }),
  edit: {
    event: "PostToolUse",
    matcher: "Edit|Write",
    register: (s, command, timeout) => registerClaudeStyle(s, "PostToolUse", command, timeout, { matcher: "Edit|Write", isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, "PostToolUse", isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, "PostToolUse", isEditCommand),
    // apply_patch reports tool_input.command = the patch text; file names come from its *** headers.
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext("PostToolUse", text),
    silent: () => "",
    synthetic: (root, file) => ({ session_id: "isitdone-doctor", turn_id: "turn-1", transcript_path: null, cwd: root, hook_event_name: "PostToolUse", model: "doctor", permission_mode: "default", tool_name: "apply_patch", tool_use_id: "doctor", tool_input: { command: `*** Begin Patch
*** Update File: ${file}
@@
-a
+b
*** End Patch
` }, tool_response: `Success. Updated the following files:
M ${file}
` })
  }
};
var cursor = {
  name: "cursor",
  displayName: "Cursor",
  kind: "json",
  event: "stop",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".cursor", "hooks.json") : join4(homedir(), ".cursor", "hooks.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".cursor") : join4(homedir(), ".cursor")],
  parse: (raw) => ({
    sessionId: str(raw.conversation_id),
    turnId: str(raw.generation_id),
    cwd: pickRoot(arr(raw.workspace_roots)) ?? str(raw.cwd),
    lastMessage: str(raw.last_assistant_message) ?? str(raw.text),
    // Cursor has no per-turn flag; loop_count is per conversation. hook.ts derives continuation from its delta.
    stopHookActive: false,
    loopCount: num(raw.loop_count),
    status: str(raw.status),
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name)
  }),
  allow: () => "{}",
  block: (reason) => JSON.stringify({ followup_message: reason }),
  register: (s, command, timeout) => {
    if (s.version === void 0) s.version = 1;
    const hooks = s.hooks = obj(s.hooks) ?? {};
    const list = hooks.stop = arr(hooks.stop);
    for (const h of list) {
      const ho = obj(h);
      if (ho && isStop(ho.command)) {
        if (ho.command === command && ho.timeout === timeout) return false;
        ho.command = command;
        ho.timeout = timeout;
        return true;
      }
    }
    list.push({ command, timeout, loop_limit: null });
    return true;
  },
  registered: (s) => {
    for (const h of arr(obj(s.hooks)?.stop)) {
      const cmd = obj(h)?.command;
      if (isStop(cmd)) return cmd;
    }
    return null;
  },
  unregister: (s) => {
    const hooks = obj(s.hooks);
    if (!hooks) return false;
    const list = arr(hooks.stop);
    const kept = list.filter((h) => !isStop(obj(h)?.command));
    if (kept.length === list.length) return false;
    if (kept.length === 0) delete hooks.stop;
    else hooks.stop = kept;
    return true;
  },
  postInstallNote: 'Cursor runs project hooks only in trusted workspaces; check the Hooks tab under Customize. Cursor does not pass the final message to stop hooks, so isitdone runs the full profile there (cached per tree), and it has no agent-visible channel after a file edit, so the test-integrity warnings arrive with the Stop hook. If "Include third-party Plugins, Skills, and other configs" is enabled, Cursor also runs hooks from .claude/settings.json: keep only one registration to avoid running the checks twice.',
  synthetic: (root, message) => ({
    conversation_id: "isitdone-doctor",
    generation_id: "gen-1",
    model: "doctor",
    hook_event_name: "stop",
    cursor_version: "0",
    workspace_roots: [root],
    user_email: null,
    transcript_path: null,
    status: "completed",
    loop_count: 0,
    last_assistant_message: message
  }),
  edit: null
};
var gemini = {
  name: "gemini",
  displayName: "Gemini CLI",
  kind: "json",
  event: "AfterAgent",
  msTimeouts: true,
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".gemini", "settings.json") : join4(homedir(), ".gemini", "settings.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".gemini") : join4(homedir(), ".gemini")],
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: null,
    cwd: str(raw.cwd),
    lastMessage: str(raw.prompt_response) === "[no response text]" ? null : str(raw.prompt_response),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name)
  }),
  allow: (systemMessage) => JSON.stringify(systemMessage ? { decision: "allow", systemMessage } : {}),
  block: (reason) => JSON.stringify({ decision: "deny", reason }),
  // Gemini timeouts are milliseconds.
  register: (s, command, timeout) => registerClaudeStyle(s, "AfterAgent", command, timeout * 1e3, { matcher: "*", extra: { name: "isitdone" }, isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "AfterAgent", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "AfterAgent", isStop),
  postInstallNote: "Gemini CLI prints a warning the first time it sees a project hook, then runs it. The folder must be trusted. Use /hooks panel to inspect.",
  synthetic: (root, message) => ({
    session_id: "isitdone-doctor",
    transcript_path: join4(root, ".isitdone", "doctor-transcript.json"),
    cwd: root,
    hook_event_name: "AfterAgent",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    prompt: "doctor",
    prompt_response: message,
    stop_hook_active: false
  }),
  edit: {
    event: "AfterTool",
    matcher: "write_file|replace",
    register: (s, command, timeout) => registerClaudeStyle(s, "AfterTool", command, timeout * 1e3, { matcher: "write_file|replace", extra: { name: "isitdone-edit" }, isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, "AfterTool", isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, "AfterTool", isEditCommand),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd), toolName: str(raw.tool_name) }),
    // Gemini HTML-escapes additionalContext ("->" would reach the model as "-&gt;").
    warn: (text) => additionalContext("AfterTool", text.replace(/->/g, "\u2192")),
    silent: () => "{}",
    synthetic: (root, file) => ({ session_id: "isitdone-doctor", cwd: root, hook_event_name: "AfterTool", timestamp: (/* @__PURE__ */ new Date()).toISOString(), tool_name: "replace", tool_input: { file_path: join4(root, file), old_string: "a", new_string: "b" }, tool_response: { llmContent: "Successfully modified file", returnDisplay: {} } })
  }
};
var copilot = {
  name: "copilot",
  displayName: "Copilot CLI",
  kind: "json",
  event: "agentStop",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".github", "hooks", "isitdone.json") : join4(str(process.env.COPILOT_HOME) ?? join4(homedir(), ".copilot"), "hooks", "isitdone.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".github", "hooks") : str(process.env.COPILOT_HOME) ?? join4(homedir(), ".copilot")],
  parse: (raw) => ({
    sessionId: str(raw.sessionId) ?? str(raw.session_id),
    turnId: null,
    cwd: str(raw.cwd),
    // No last-message field (only transcriptPath): hook.ts runs the full profile, cached per tree.
    lastMessage: null,
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    // stopReason is documented as "end_turn" only; never skip verification on an unknown value.
    status: null,
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name) ?? str(raw.hookEventName)
  }),
  allow: (systemMessage) => JSON.stringify(systemMessage ? { decision: "allow", reason: systemMessage } : { decision: "allow" }),
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => {
    if (s.version === void 0) s.version = 1;
    const hooks = s.hooks = obj(s.hooks) ?? {};
    const list = hooks.agentStop = arr(hooks.agentStop);
    for (const h of list) {
      const ho = obj(h);
      if (ho && (isStop(ho.bash) || isStop(ho.powershell))) {
        if (ho.bash === command && ho.powershell === command && ho.timeoutSec === timeout) return false;
        ho.type = "command";
        ho.bash = command;
        ho.powershell = command;
        ho.timeoutSec = timeout;
        return true;
      }
    }
    list.push({ type: "command", bash: command, powershell: command, timeoutSec: timeout });
    return true;
  },
  registered: (s) => {
    for (const h of arr(obj(s.hooks)?.agentStop)) {
      const ho = obj(h);
      if (!ho) continue;
      if (isStop(ho.bash)) return ho.bash;
      if (isStop(ho.powershell)) return ho.powershell;
    }
    return null;
  },
  unregister: (s) => {
    const hooks = obj(s.hooks);
    if (!hooks) return false;
    const list = arr(hooks.agentStop);
    const kept = list.filter((h) => !(isStop(obj(h)?.bash) || isStop(obj(h)?.powershell)));
    if (kept.length === list.length) return false;
    if (kept.length === 0) delete hooks.agentStop;
    else hooks.agentStop = kept;
    if (Object.keys(hooks).length === 0) delete s.hooks;
    return true;
  },
  postInstallNote: "Copilot CLI reads hook files at startup: restart copilot after init. It does not pass the final message to agentStop hooks, so isitdone runs the full profile (cached per tree). Copilot CLI has also been seen running hooks from .claude/settings.json; keep only one isitdone registration so the checks do not run twice.",
  synthetic: (root) => ({
    sessionId: "isitdone-doctor",
    timestamp: Date.now(),
    cwd: root,
    transcriptPath: join4(root, ".isitdone", "doctor-transcript.jsonl"),
    stopReason: "end_turn",
    stop_hook_active: false
  }),
  // postToolUse exists, but no agent-visible output field is documented for it.
  edit: null
};
var qwen = {
  name: "qwen",
  displayName: "Qwen Code",
  kind: "json",
  event: "Stop",
  msTimeouts: true,
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".qwen", "settings.json") : join4(homedir(), ".qwen", "settings.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".qwen") : join4(homedir(), ".qwen")],
  parse: parseClaudeShape,
  // Like Gemini, empty stdout is safest expressed as an empty object.
  allow: (systemMessage) => JSON.stringify(systemMessage ? { systemMessage } : {}),
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout * 1e3, { matcher: "*", extra: { name: "isitdone" }, isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Qwen Code reads .qwen/settings.json at startup: restart qwen after init and check /hooks. Project-level hooks may need to be trusted before they run (unverified).",
  synthetic: (root, message) => ({
    session_id: "isitdone-doctor",
    transcript_path: join4(root, ".isitdone", "doctor-transcript.json"),
    cwd: root,
    hook_event_name: "Stop",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    stop_hook_active: false,
    last_assistant_message: message,
    background_tasks: [],
    crons: []
  }),
  edit: {
    event: "PostToolUse",
    matcher: "write_file|replace|edit",
    register: (s, command, timeout) => registerClaudeStyle(s, "PostToolUse", command, timeout * 1e3, { matcher: "write_file|replace|edit", extra: { name: "isitdone-edit" }, isMine: isEditCommand }),
    registered: (s) => registeredClaudeStyle(s, "PostToolUse", isEditCommand),
    unregister: (s) => unregisterClaudeStyle(s, "PostToolUse", isEditCommand),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext("PostToolUse", text),
    silent: () => "{}",
    synthetic: (root, file) => ({ session_id: "isitdone-doctor", cwd: root, hook_event_name: "PostToolUse", timestamp: (/* @__PURE__ */ new Date()).toISOString(), tool_name: "replace", tool_input: { file_path: join4(root, file), old_string: "a", new_string: "b" }, tool_response: { llmContent: "Successfully modified file", returnDisplay: {} } })
  }
};
var goose = {
  name: "goose",
  displayName: "Goose",
  kind: "json",
  event: "Stop",
  settingsPath: (root, scope) => join4(scope === "project" ? root : homedir(), ".agents", "plugins", "isitdone", "hooks", "hooks.json"),
  detect: (root, scope) => scope === "project" ? [join4(root, ".agents", "plugins"), join4(root, ".config", "goose")] : [join4(homedir(), ".config", "goose"), join4(homedir(), ".agents", "plugins")],
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: null,
    // working_dir is documented for tool events only; a Stop payload has no directory, so hook.ts uses the process cwd.
    cwd: str(raw.working_dir) ?? str(raw.cwd),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: flag(raw.stop_hook_active),
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.event) ?? str(raw.hook_event_name)
  }),
  // Empty stdout is the documented allow; any other JSON is "no decision (logged as hook failure)", so there is no
  // channel for a user-facing message.
  allow: () => "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Goose discovers plugin hooks at startup: restart goose after init. Goose sends no working directory to Stop hooks, so isitdone verifies the directory goose runs the hook in; commands run through sh -c, so Windows needs a POSIX sh on PATH (unverified). Goose has no per-turn continuation flag: isitdone counts its own attempts per session.",
  synthetic: (root, message) => ({ event: "Stop", session_id: "isitdone-doctor", matcher_context: {}, last_assistant_message: message, working_dir: root }),
  // AfterFileEdit exists but only PreToolUse and Stop carry decisions; no agent-visible context field is documented.
  edit: null
};
var droid = {
  name: "droid",
  displayName: "Factory Droid",
  kind: "json",
  event: "Stop",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".factory", "hooks.json") : join4(homedir(), ".factory", "hooks.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".factory") : join4(homedir(), ".factory")],
  parse: (raw) => ({
    ...parseClaudeShape(raw),
    turnId: str(raw.message_id),
    // Hooks run from Droid's current directory, which can move during a session; FACTORY_PROJECT_DIR is the root.
    cwd: str(raw.cwd) ?? str(process.env.FACTORY_PROJECT_DIR),
    lastMessage: null
  }),
  allow: (systemMessage) => systemMessage ? JSON.stringify({ systemMessage }) : "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout, { unwrapped: true, isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop, true),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop, true),
  postInstallNote: 'Droid does not pass the final message to Stop hooks, so isitdone runs the full profile (cached per tree). Once .factory/hooks.json exists Droid ignores a "hooks" key in .factory/settings.json; move any hooks you kept there into hooks.json. Restart droid if /hooks does not list the entry.',
  synthetic: (root) => ({
    session_id: "isitdone-doctor",
    transcript_path: join4(root, ".isitdone", "doctor-transcript.jsonl"),
    cwd: root,
    permission_mode: "default",
    hook_event_name: "Stop",
    stop_hook_active: false,
    tool_execution_count: 3,
    elapsed_time: 1e3
  }),
  edit: null
};
var devin = {
  name: "devin",
  displayName: "Devin",
  kind: "json",
  event: "Stop",
  coveredBy: "claude",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".devin", "hooks.v1.json") : join4(devinConfigDir(), "config.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".devin") : devinConfigDir()],
  parse: (raw) => ({ ...parseClaudeShape(raw), cwd: str(raw.cwd) ?? str(process.env.DEVIN_PROJECT_DIR), lastMessage: null }),
  allow: () => "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  register: (s, command, timeout, scope) => registerClaudeStyle(s, "Stop", command, timeout, { unwrapped: scope !== "user", isMine: isStop }),
  registered: (s, scope) => registeredClaudeStyle(s, "Stop", isStop, scope !== "user"),
  unregister: (s, scope) => unregisterClaudeStyle(s, "Stop", isStop, scope !== "user"),
  postInstallNote: "Devin also loads .claude/settings.json hooks (read_config_from.claude defaults to true): keep a single isitdone registration or the checks run twice. Devin passes neither the final message nor a cwd to Stop hooks, so isitdone runs the full profile (cached per tree) in $DEVIN_PROJECT_DIR. Run /hooks inside devin to confirm the source; hooks do not run in Restricted Mode.",
  // No cwd in the payload: the doctor spawns the hook in the repo root, which is what Devin's process cwd would be.
  synthetic: () => ({ hook_event_name: "Stop", session_id: "isitdone-doctor", prompt_id: "prompt-1", stop_hook_active: false }),
  edit: {
    event: "PostToolUse",
    matcher: "^(edit|write|apply_patch|notebook_edit)$",
    register: (s, command, timeout, scope) => registerClaudeStyle(s, "PostToolUse", command, timeout, { matcher: "^(edit|write|apply_patch|notebook_edit)$", unwrapped: scope !== "user", isMine: isEditCommand }),
    registered: (s, scope) => registeredClaudeStyle(s, "PostToolUse", isEditCommand, scope !== "user"),
    unregister: (s, scope) => unregisterClaudeStyle(s, "PostToolUse", isEditCommand, scope !== "user"),
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd) ?? str(process.env.DEVIN_PROJECT_DIR), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext("PostToolUse", text),
    silent: () => "",
    synthetic: (root, file) => ({ hook_event_name: "PostToolUse", session_id: "isitdone-doctor", prompt_id: "prompt-1", tool_name: "edit", tool_input: { file_path: join4(root, file), old_string: "a", new_string: "b" }, tool_response: { success: true, output: "" } })
  }
};
var augment = {
  name: "augment",
  displayName: "Augment (Auggie)",
  kind: "json",
  event: "Stop",
  msTimeouts: true,
  // verified: https://docs.augmentcode.com/cli/hooks ("command: Path to the script to execute (must use a supported script
  // extension: .ps1, .cmd, .bat, or .sh)"), so init registers .augment/hooks/isitdone-hook.{sh,cmd} instead of a command line.
  scriptOnly: true,
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".augment", "settings.json") : join4(homedir(), ".augment", "settings.json"),
  detect: (root, scope) => [scope === "project" ? join4(root, ".augment") : join4(homedir(), ".augment")],
  parse: (raw) => {
    const cause = str(raw.agent_stop_cause);
    return {
      sessionId: str(raw.conversation_id),
      turnId: null,
      cwd: pickRoot(arr(raw.workspace_roots)) ?? str(raw.cwd),
      lastMessage: str(obj(raw.conversation)?.agentTextResponse),
      stopHookActive: flag(raw.stop_hook_active),
      loopCount: null,
      // end_turn | interrupted | max_iterations | error: only a finished turn is worth verifying.
      status: cause === null ? null : cause === "end_turn" ? "completed" : cause,
      backgroundTasks: 0,
      permissionMode: null,
      hookEventName: str(raw.hook_event_name)
    };
  },
  allow: (systemMessage) => systemMessage ? JSON.stringify({ systemMessage }) : "",
  block: (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", decision: "block", reason } }),
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout * 1e3, { groupExtra: { metadata: { includeConversationData: true } }, isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Auggie reads .augment/settings.json at startup: restart auggie after init. Auggie runs hook scripts, not command lines, so the entry points at .augment/hooks/isitdone-hook.sh (.cmd on Windows), a one-line wrapper around the isitdone command; keep both files with the settings. Augment has no per-turn continuation flag, so isitdone counts its own attempts per conversation.",
  synthetic: (root, message) => ({
    hook_event_name: "Stop",
    conversation_id: "isitdone-doctor",
    workspace_roots: [root],
    agent_stop_cause: "end_turn",
    conversation: { userPrompt: "doctor", agentTextResponse: message, agentCodeResponse: [] }
  }),
  // PostToolUse cannot block and documents no context field the agent sees.
  edit: null
};
var opencode = {
  name: "opencode",
  displayName: "OpenCode",
  kind: "file",
  file: {
    render: (stopCommand, editCommand2, timeoutSeconds, editTimeoutSeconds) => renderOpencodePlugin({ stopCommand, editCommand: editCommand2, timeoutSeconds, editTimeoutSeconds }),
    parse: parseOpencodePlugin
  },
  event: "session.idle",
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".opencode", "plugins", "isitdone.js") : join4(xdgConfig(), "opencode", "plugins", "isitdone.js"),
  detect: (root, scope) => scope === "project" ? [join4(root, ".opencode"), join4(root, "opencode.json"), join4(root, "opencode.jsonc")] : [join4(xdgConfig(), "opencode")],
  parse: (raw) => ({
    sessionId: str(raw.session_id),
    turnId: str(raw.message_id),
    cwd: str(raw.cwd) ?? str(raw.worktree),
    lastMessage: str(raw.last_assistant_message),
    stopHookActive: raw.stop_hook_active === true,
    loopCount: null,
    status: null,
    backgroundTasks: 0,
    permissionMode: null,
    hookEventName: str(raw.hook_event_name)
  }),
  allow: () => "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  // The shim file is rendered whole by init; nothing to merge into a settings object.
  register: () => false,
  registered: () => null,
  unregister: () => false,
  postInstallNote: 'OpenCode loads plugins at startup: restart opencode (or the server) after init. OpenCode has no blocking stop hook, so a failed check comes back as a visible "[isitdone] ..." user message in the same session and the agent keeps working; in `opencode run` the process may exit before that follow-up is applied.',
  synthetic: (root, message) => ({
    hook_event_name: "session.idle",
    session_id: "isitdone-doctor",
    message_id: "msg-1",
    cwd: root,
    worktree: root,
    last_assistant_message: message,
    stop_hook_active: false,
    loop_count: 0
  }),
  edit: {
    event: "tool.execute.after",
    matcher: "edit|write|apply_patch",
    register: () => false,
    registered: () => null,
    unregister: () => false,
    // edit/write send filePath, apply_patch sends patchText (same *** headers as Codex).
    parse: (raw) => ({ files: editFiles(raw), cwd: str(raw.cwd) ?? str(raw.worktree), toolName: str(raw.tool_name) }),
    warn: (text) => additionalContext("tool.execute.after", text),
    silent: () => "",
    synthetic: (root, file) => ({ hook_event_name: "tool.execute.after", session_id: "isitdone-doctor", cwd: root, worktree: root, tool_name: "edit", tool_input: { filePath: join4(root, file), oldString: "a", newString: "b" } })
  }
};
var junie = {
  name: "junie",
  displayName: "Junie CLI (early access)",
  kind: "json",
  event: "Stop",
  scopes: ["user"],
  settingsPath: (root, scope) => scope === "project" ? join4(root, ".junie", "config.json") : join4(homedir(), ".junie", "config.json"),
  detect: (root, scope) => scope === "project" ? [] : [join4(homedir(), ".junie")],
  parse: (raw) => ({ ...parseClaudeShape(raw), cwd: str(raw.cwd) ?? str(raw.project_path) }),
  allow: () => "",
  block: (reason) => JSON.stringify({ decision: "block", reason }),
  // blockOnError is deliberately not set: a crashed or timed-out hook must fail open, like everywhere else.
  register: (s, command, timeout) => registerClaudeStyle(s, "Stop", command, timeout, { isMine: isStop }),
  registered: (s) => registeredClaudeStyle(s, "Stop", isStop),
  unregister: (s) => unregisterClaudeStyle(s, "Stop", isStop),
  postInstallNote: "Junie CLI hooks are an Early Access feature: they need the EAP build and run in the interactive TUI and -p batch mode only. Junie passes no session id or working directory to Stop hooks, so isitdone verifies the directory junie runs the hook in and counts attempts per repository. A project-local .junie/config.json is ignored unless junie is started with --config-location.",
  synthetic: (_root, message) => ({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: message }),
  edit: null
};
var HOSTS = { claude, codex, cursor, gemini, copilot, qwen, goose, droid, devin, augment, opencode, junie };
function getHost(name) {
  const h = HOSTS[name];
  if (!h) throw new Error(`unknown host "${name}" (expected one of ${HOST_NAMES.join(", ")})`);
  return h;
}
function hostScopes(host) {
  return host.scopes ?? ["project", "user"];
}
function detectHosts(root, exists) {
  const found = [];
  for (const name of HOST_NAMES) {
    const host = HOSTS[name];
    for (const scope of hostScopes(host)) {
      if (host.detect(root, scope).some(exists)) found.push({ host, scope, path: host.settingsPath(root, scope) });
    }
  }
  return found;
}

// src/verify.ts
import { join as join9 } from "node:path";

// src/diff.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync4, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { join as join5 } from "node:path";
var MAX_SYNTH_BYTES = 2 * 1024 * 1024;
function parseUnifiedDiff(text) {
  const files = [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let cur = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      cur = { path: m ? unquote(m[2]) : line.slice(11), oldPath: m ? unquote(m[1]) : null, status: "modified", binary: false, hunks: [] };
      if (cur.oldPath === cur.path) cur.oldPath = null;
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = unquote(line.slice(12));
    } else if (line.startsWith("rename to ")) cur.path = unquote(line.slice(10));
    else if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) cur.binary = true;
    else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
    } else if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { oldStart: oldNo, newStart: newNo, lines: [] };
      cur.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith("+")) hunk.lines.push({ kind: "+", text: line.slice(1), newNo: newNo++, oldNo: null });
      else if (line.startsWith("-")) hunk.lines.push({ kind: "-", text: line.slice(1), newNo: null, oldNo: oldNo++ });
      else if (line.startsWith(" ") || line === "") hunk.lines.push({ kind: " ", text: line.slice(1), newNo: newNo++, oldNo: oldNo++ });
    }
  }
  return files;
}
function unquote(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}
function git2(args, cwd) {
  const r = spawnSync2("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) return { ok: false, out: "", err: r.error.message };
  return { ok: r.status === 0, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}
function synthAdded(top, rel) {
  const abs = join5(top, rel);
  try {
    const st = statSync2(abs);
    if (!st.isFile() || st.size > MAX_SYNTH_BYTES) return null;
    const content = readFileSync2(abs, "utf8");
    if (content.includes("\0")) return { path: rel, oldPath: null, status: "added", binary: true, hunks: [] };
    const lines = content.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return {
      path: rel,
      oldPath: null,
      status: "added",
      binary: false,
      hunks: [{ oldStart: 0, newStart: 1, lines: lines.map((text, i) => ({ kind: "+", text: text.replace(/\r$/, ""), newNo: i + 1, oldNo: null })) }]
    };
  } catch {
    return null;
  }
}
function collectDiff(top, base = "HEAD") {
  const exclude = `:(exclude)${RECEIPT_DIR}`;
  const hasHead = git2(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], top).ok;
  if (!hasHead && base !== "HEAD") return { files: [], base, error: `base ${base} not found` };
  let files = [];
  if (hasHead) {
    const d = git2(["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-U3", "-M", base, "--", ".", exclude], top);
    if (!d.ok) return { files: [], base, error: `git diff failed: ${d.err}` };
    files = parseUnifiedDiff(d.out);
  }
  const others = git2(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard", ...hasHead ? [] : ["--cached"], "--", ".", exclude], top);
  if (others.ok) {
    for (const rel of others.out.split("\0").filter(Boolean)) {
      if (files.some((f) => f.path === rel)) continue;
      const synth = synthAdded(top, rel);
      if (synth) files.push(synth);
    }
  }
  return { files, base, error: null };
}
function readAtBase(top, path, base = "HEAD") {
  const r = spawnSync2("git", ["show", `${base}:${path}`], { cwd: top, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout ?? "" : null;
}
function readNow(top, path) {
  const abs = join5(top, path);
  if (!existsSync4(abs)) return null;
  try {
    return readFileSync2(abs, "utf8");
  } catch {
    return null;
  }
}

// src/integrity.ts
var isAttrLang = (lang) => lang === "rust" || lang === "java" || lang === "csharp";
var SUPPRESS_RE = /isitdone:\s*allow(?:\s*[:\-]?\s*(.*?))?\s*(?:\*\/)?\s*$/i;
function langOf(path) {
  const p = path.toLowerCase();
  if (/\.(?:[cm]?[jt]sx?)$/.test(p)) return "js";
  if (p.endsWith(".py")) return "py";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".rs")) return "rust";
  if (p.endsWith(".java") || p.endsWith(".kt")) return "java";
  if (p.endsWith(".cs")) return "csharp";
  return "other";
}
var SNIFF = {
  // verified: cargo runs #[test] fns inside any lib/bin target; the module is normally gated with #[cfg(test)]
  // (https://doc.rust-lang.org/book/ch11-01-writing-tests.html)
  rust: /^[ \t]*#\[\s*cfg\s*\((?:all|any)?\(?\s*test\b|^[ \t]*#\[\s*(?:[\w:]+::)?(?:test|rstest|quickcheck|wasm_bindgen_test|test_case|test_matrix)\b/m,
  java: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/m,
  csharp: /^\s*\[\s*(?:Fact|Theory|Test|TestMethod|TestCase|DataTestMethod)\b/m
};
var MAX_SNIFF_BYTES = 1024 * 1024;
var MAVEN_TEST_NAME = /^(?:Test[^/]*|[^/]*(?:Test|Tests|TestCase|IT|ITCase)|IT[^/]*)\.java$/;
function isTestFile(path, readers) {
  const raw = path.replace(/\\/g, "/");
  const rawBase = raw.split("/").pop() ?? raw;
  const p = raw.toLowerCase();
  const base = p.split("/").pop() ?? p;
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  const lang = langOf(p);
  if (/(^|\/)(?:__tests__|tests?|spec|specs|e2e|integration)\//.test(p) && (lang === "js" || lang === "py" || lang === "go")) return true;
  if (/^test_.*\.py$|_test\.py$|^tests?\.py$|^conftest\.py$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  if (lang === "rust") {
    if (/(^|\/)tests\//.test(p)) return true;
    if (/(?:^|\/)(?:tests?|test_[^/]*|[^/]*_tests?)\.rs$/.test(p)) return true;
  }
  if (lang === "java") {
    if (/(^|\/)src\/(?:test|it|integrationtest|integration-test|functionaltest|androidtest|jvmtest|commontest)\//.test(p)) return true;
    if (MAVEN_TEST_NAME.test(rawBase) && !/(^|\/)src\/main\//.test(p)) return true;
    if (/(?:Test|Tests|Spec)\.kt$/.test(rawBase)) return true;
  }
  if (lang === "csharp") {
    if (/(^|\/)[^/]*\.(?:tests?|unittests|integrationtests|specs?)\//.test(p) || /(^|\/)(?:tests?|specs?|unittests|integrationtests)\//.test(p)) return true;
    if (/(?:Tests?|Specs?|Fixture)\.cs$/.test(rawBase)) return true;
  }
  if (readers && isAttrLang(lang)) {
    for (const read of readers) {
      const text = read();
      if (text && text.length <= MAX_SNIFF_BYTES && SNIFF[lang].test(text)) return true;
    }
  }
  return false;
}
function isTestConfigFile(path) {
  const p = path.replace(/\\/g, "/");
  const base = p.split("/").pop() ?? p;
  if (/^(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava|wdio)\.config\.[cm]?[jt]s$/.test(base)) return true;
  if (/^\.mocharc/.test(base) || base === "jest.config.json") return true;
  if (["package.json", "pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini", "Makefile", "makefile", ".nycrc", "codecov.yml", ".codecov.yml"].includes(base)) return true;
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return true;
  if (/(^|\/)\.gitlab-ci\.ya?ml$/.test(p) || /(^|\/)\.circleci\/config\.ya?ml$/.test(p) || base === "azure-pipelines.yml" || base === "Jenkinsfile") return true;
  if (["bitbucket-pipelines.yml", ".travis.yml", ".drone.yml", "cloudbuild.yaml", "justfile", "Justfile", "Taskfile.yml"].includes(base) || /(^|\/)\.buildkite\/[^/]+\.ya?ml$/.test(p)) return true;
  if (base === "Cargo.toml" || /(^|\/)\.cargo\/config(?:\.toml)?$/.test(p) || base === "nextest.toml") return true;
  if (["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "testng.xml", "junit-platform.properties"].includes(base) || /(^|\/)\.mvn\/maven\.config$/.test(p)) return true;
  if (/\.(?:cs|fs|vb)proj$|\.runsettings$/.test(base) || base === "Directory.Build.props" || base === "Directory.Build.targets" || base === "xunit.runner.json") return true;
  return false;
}
function stripStrings(text, lang = "other") {
  const re = isAttrLang(lang) ? /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\(?:u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.))'|`(?:[^`\\\n]|\\.)*`/g : /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`/g;
  return text.replace(re, (m) => m[0] + " ".repeat(Math.max(0, m.length - 2)) + m[m.length - 1]);
}
function stripComment(lang, text) {
  if (lang === "py") return text.replace(/#.*$/, "");
  return text.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}
function normalize(lang, text) {
  return stripComment(lang, stripStrings(text, lang));
}
function normalizeFile(lang, text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  let out3 = text.split("\n").map((l) => stripStrings(l, lang)).join("\n");
  if (lang === "py") {
    out3 = out3.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, blank);
    out3 = out3.replace(/#.*$/gm, blank);
  } else {
    out3 = out3.replace(/\/\*[\s\S]*?\*\//g, blank);
    out3 = out3.replace(/\/\/.*$/gm, blank);
  }
  return out3;
}
function insideBlockComment(lang, lines) {
  const out3 = [];
  let open = false;
  for (const l of lines) {
    if (l.kind === "-") {
      out3.push(false);
      continue;
    }
    const startsInside = open;
    let rest = lang === "py" ? l.text : stripStrings(l.text, lang);
    let codeOutside = false;
    let sawToken = false;
    for (; ; ) {
      if (open) {
        const close = lang === "py" ? firstOf(rest, ['"""', "'''"]) : rest.indexOf("*/");
        if (close < 0) {
          rest = "";
          break;
        }
        sawToken = true;
        rest = rest.slice(close + (lang === "py" ? 3 : 2));
        open = false;
      } else {
        const start = lang === "py" ? firstOf(rest, ['"""', "'''"]) : rest.indexOf("/*");
        if (start < 0) {
          if (rest.trim() !== "") codeOutside = true;
          break;
        }
        sawToken = true;
        if (rest.slice(0, start).trim() !== "") codeOutside = true;
        rest = rest.slice(start + (lang === "py" ? 3 : 2));
        open = true;
      }
    }
    out3.push((startsInside || sawToken) && !codeOutside);
  }
  return out3;
}
function firstOf(text, tokens) {
  let best = -1;
  for (const t of tokens) {
    const i = text.indexOf(t);
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  return best;
}
var COUNTERS = {
  js: {
    test: /\b(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|failing|sequential))*\s*(?:\(|`)/g,
    assertion: /\b(?:expect|assert(?:\.\w+)?|should|chai\.expect|t\.(?:equal|deepEqual|strictEqual|ok|is|true|false|throws|notThrows|not|match|snapshot|like|pass)|expectTypeOf)\s*\(/g,
    skip: /\b(?:it|test|describe|context|suite|specify)\.skip\s*\(|\b(?:xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g
  },
  py: {
    test: /^\s*(?:async\s+)?def\s+test[\p{L}\p{N}_]*\s*\(/gmu,
    assertion: /^\s*assert\b|\bself\.assert\w+\s*\(|\bpytest\.raises\s*\(|\bassertpy\b|\bexpect\s*\(/gm,
    skip: /@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/g
  },
  go: {
    test: /^func\s+(?:Test|Example|Benchmark|Fuzz)\w*\s*\(/gm,
    assertion: /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(|\bis\.\w+\s*\(/g,
    skip: /\bt\.(?:Skip|SkipNow|Skipf)\s*\(|\btesting\.Short\s*\(/g
  },
  rust: {
    // #[test], #[tokio::test(...)] ("expands to #[test]", verified: https://docs.rs/tokio/latest/tokio/attr.test.html), #[rstest] with
    // #[case(..)] rows, #[test_case(..)] rows (each attribute is one test, verified: https://docs.rs/test-case/latest/test_case/).
    test: /^\s*#\[\s*(?:(?:[\w:]+::)?(?:test|rstest|quickcheck|wasm_bindgen_test)\b|test_case\s*\(|test_matrix\s*\(|case\s*[(:])/gm,
    // std assert macros (+debug_), approx/claims/insta/proptest macros, panic!/unreachable!; .unwrap()/.expect() are the idiomatic
    // "this must succeed" in a test and `?` in a test returning Result fails it on Err (verified: Book 11.1).
    assertion: /\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*\(|\b(?:assert_relative_eq|assert_abs_diff_eq|assert_ulps_eq|assert_relative_ne|assert_abs_diff_ne|assert_ulps_ne|prop_assert(?:_eq|_ne)?|assert_(?:debug_|display_|json_|yaml_|ron_|toml_|csv_|binary_)?snapshot|assert_ok|assert_err|assert_some|assert_none|assert_gt|assert_ge|assert_lt|assert_le|panic|unreachable)!\s*\(|\.(?:unwrap|expect|unwrap_err|expect_err)\s*\(|\?(?=\s*[;.),\]}])/g,
    // #[ignore], #[ignore = "reason"], #[cfg_attr(<pred>, ignore)], test-case `=> ignore` (verified: https://doc.rust-lang.org/reference/attributes/testing.html)
    skip: /#\[\s*ignore\b|#\[\s*cfg_attr\s*\(.*?\bignore\s*\)|=>\s*ignore\b/g
  },
  java: {
    // JUnit 5 (verified: docs.junit.org Assertions/Disabled/condition pages), JUnit 4 and TestNG all spell the method annotation @Test.
    test: /^\s*@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|ParameterizedClass)\b/gm,
    // JUnit Assertions, AssertJ/Hamcrest/Truth assertThat*, Mockito verify*, TestNG expectThrows, kotlin.test assertFails*/assertIs/assertContains,
    // JUnit 4 @Test(expected = X.class) and TestNG @Test(expectedExceptions = ...) count as one assertion each.
    assertion: /\b(?:assert(?:Equals|NotEquals|True|False|Null|NotNull|Same|NotSame|ArrayEquals|IterableEquals|LinesMatch|Throws|ThrowsExactly|DoesNotThrow|Timeout|TimeoutPreemptively|All|InstanceOf|That|ThatThrownBy|ThatCode|ThatExceptionOfType|ThatNoException|ThatIllegalArgumentException|ThatIllegalStateException|ThatNullPointerException|ThatIOException|WithMessage|Fails|FailsWith|Contains|Is|IsNot|ContentEquals|Soft\w*)|fail|verify|verifyNoMoreInteractions|verifyNoInteractions|expectThrows|inOrder)\s*(?:<[^>\n]*>\s*)?[({]|@Test\s*\([^)]*\bexpected(?:Exceptions)?\s*=/g,
    // @Disabled/@Ignore, the org.junit.jupiter.api.condition annotations, Assumptions (a failed assumption aborts the test), TestNG enabled=false.
    skip: /@(?:Disabled|Ignore)\b|@(?:Disabled|Enabled)(?:If|OnOs|OnJre|ForJreRange|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables|InNativeImage)\b|\b(?:Assumptions\.)?assum(?:eTrue|eFalse|eThat|eNotNull|eNoException|ingThat)\s*\(|\bAssumptions\.abort\s*\(|@Test\s*\([^)]*\benabled\s*=\s*false/g
  },
  csharp: {
    // xUnit [Fact]/[Theory] + [InlineData] rows, NUnit [Test]/[TestCase] rows, MSTest [TestMethod] + [DataRow] rows (each attribute is one
    // test or one row); attribute lists ([Fact, Trait(...)]) match through the `,` alternative. unverified: MSTest [DataTestMethod] obsolescence.
    test: /\[\s*(?:(?:Xunit|NUnit\.Framework|Microsoft\.VisualStudio\.TestTools\.UnitTesting)\.)?(?:Fact|Theory|Test|TestMethod|DataTestMethod|InlineData|TestCase|DataRow)(?:Attribute)?\s*(?:\(|,|\])/g,
    // Assert.*/ClassicAssert.*/CollectionAssert.*/StringAssert.* (Ignore/Inconclusive/Skip*/Pass/Warn/Multiple are control flow, not checks),
    // FluentAssertions .Should(), Shouldly .ShouldBe(), Moq .Verify(, NSubstitute .Received(.
    assertion: /\b(?:Classic|Collection|String)?Assert\.(?!(?:Ignore|Inconclusive|Skip\w*|Pass|Warn|Multiple|EnterMultipleScope|Scope)\b)\w+(?:<[^>]*>)?\s*\(|\bAssume\.\w+\s*\(|\.Should\s*\(\s*\)|\.Should\w+\s*\(|\.(?:Verify|VerifyAll|VerifyNoOtherCalls|Received|DidNotReceive|ReceivedWithAnyArgs)\s*\(/g,
    // [Fact(Skip = "...")] / [InlineData(..., Skip = "...")] (verified: xunit v2 FactAttribute.Skip, DataAttribute.Skip), xUnit v3 Assert.Skip*,
    // NUnit [Ignore("...")]/[Explicit]/Assert.Ignore/Inconclusive/Assume.That, MSTest [Ignore]. `Skip =`/`Ignore =` only inside an attribute.
    skip: /\[[^\]\n]*\bSkip\s*=\s*(?!null\b)|\[\s*Ignore\b|\[\s*Explicit\b|\bAssert\.(?:Ignore|Inconclusive|Skip|SkipWhen|SkipUnless)\s*\(|\bAssume\.That\s*\(|\[[^\]\n]*\bSkip(?:When|Unless)\s*=|\[[^\]\n]*\bExplicit\s*=\s*true|\[[^\]\n]*\bIgnore(?:Message|Reason)?\s*=\s*"/g
  }
};
function enclosingArtifact(after, line) {
  const at = after.indexOf(line.trim());
  if (at < 0) return null;
  const k = after.lastIndexOf("<artifactId>", at);
  if (k < 0) return null;
  const m = /<artifactId>\s*([^<]+?)\s*</.exec(after.slice(k));
  return m ? m[1] : null;
}
function rustTestRegions(norm, sniffed = false) {
  const gated = rustGatedRegions(norm);
  if (gated || !sniffed) return gated;
  const regions = [];
  const attr = /^[ \t]*#\[\s*(?:test|tokio::test|async_std::test|rstest|test_case|test_log::test|quickcheck|proptest)\b[^\n]*/gm;
  let m;
  while (m = attr.exec(norm)) {
    const end = blockEnd(norm, m.index + m[0].length);
    if (end > m.index) regions.push([m.index, end]);
    attr.lastIndex = Math.max(attr.lastIndex, end);
  }
  return regions.length ? regions : null;
}
function blockEnd(norm, from) {
  let depth = 0;
  for (let i = from; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    } else if (ch === ";" && depth === 0) return i + 1;
  }
  return norm.length;
}
function rustGatedRegions(norm) {
  const gate = /^[ \t]*#\[\s*cfg\s*\((?:all|any)?\(?\s*test\b[^\n]*/gm;
  const regions = [];
  let m;
  while (m = gate.exec(norm)) {
    const start = m.index;
    let i = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    for (; i < norm.length; i++) {
      const ch = norm[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      } else if (ch === ";" && depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) end = norm.length;
    regions.push([start, end]);
    gate.lastIndex = end;
  }
  return regions.length > 0 ? regions : null;
}
function regionLines(text, regions) {
  if (!regions) return null;
  const lines = /* @__PURE__ */ new Set();
  let lineNo = 1;
  let r = 0;
  for (let i = 0; i < text.length; i++) {
    while (r < regions.length && i >= regions[r][1]) r++;
    if (r < regions.length && i >= regions[r][0]) lines.add(lineNo);
    if (text[i] === "\n") lineNo++;
  }
  return lines;
}
function blockAfter(text, from) {
  const open = text.indexOf("{", from);
  if (open < 0 || open - from > 2e3) return "";
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, j + 1);
    }
  }
  return "";
}
var ROW_ATTR = {
  rust: /^[ \t]*#\[\s*(?:case\s*[(:]|test_case\s*\()/gm,
  java: /(?!)/g,
  // Java rows are @CsvSource strings, credited by javaSourceRows
  csharp: /^[ \t]*\[\s*(?:InlineData|TestCase|DataRow)\b/gm
};
var UNKNOWN_ROWS = {
  rust: /#\[\s*(?:values|test_matrix)\b|\bproptest!\s*\{|#\[\s*quickcheck\b/,
  java: /@(?:MethodSource|EnumSource|FieldSource|ArgumentsSource|CsvFileSource|TestFactory)\b|@CsvSource\s*\([^)]*\btextBlock\s*=|^[ \t]*@Test(?:\([^)]*\))?[ \t]*(?:\r?\n[ \t]*)*(?:(?:public|abstract|final)\s+)*class\b/m,
  csharp: /\[\s*(?:MemberData|ClassData|TestCaseSource|DynamicData|Values|Combinatorial\w*|Pairwise|Sequential)\b/
};
function rowAssertionCredit(lang, norm, assertion) {
  const re = new RegExp(ROW_ATTR[lang].source, "gm");
  let credit = 0;
  let m;
  let groupEnd = -1;
  while (m = re.exec(norm)) {
    if (m[0] === "") re.lastIndex++;
    if (m.index < groupEnd) continue;
    let rows = 0;
    let headed = false;
    let pos = m.index;
    const lineRe = /[^\n]*\n?/y;
    for (; ; ) {
      lineRe.lastIndex = pos;
      const l = lineRe.exec(norm);
      if (!l || l[0] === "") break;
      const t = l[0].trim();
      if (t === "") {
        pos += l[0].length;
        continue;
      }
      const isAttr = lang === "rust" ? /^#\[/.test(t) : /^\[/.test(t);
      if (!isAttr) break;
      if (new RegExp(ROW_ATTR[lang].source).test(t)) rows++;
      else if (new RegExp(COUNTERS[lang].test.source).test(t)) headed = true;
      pos += l[0].length;
    }
    const before = norm.slice(Math.max(0, norm.lastIndexOf("\n", m.index - 2)), m.index).trim();
    if (before !== "" && new RegExp(COUNTERS[lang].test.source).test(before) && !new RegExp(ROW_ATTR[lang].source).test(before)) headed = true;
    groupEnd = pos;
    const n = count(assertion, blockAfter(norm, pos));
    credit += Math.max(0, rows - (headed ? 0 : 1)) * n;
  }
  return credit;
}
function javaSourceRows(text, norm, assertion) {
  const re = /@(?:CsvSource|ValueSource)\s*\(/g;
  let tests = 0;
  let assertions = 0;
  let m;
  while (m = re.exec(norm)) {
    const open = norm.indexOf("{", m.index);
    if (open < 0 || open - m.index > 200) continue;
    let depth = 0;
    let close = -1;
    for (let j = open; j < norm.length; j++) {
      if (norm[j] === "{") depth++;
      else if (norm[j] === "}") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
      }
    }
    if (close < 0) continue;
    const inner = text.slice(open + 1, close);
    const rows = /"/.test(inner) ? (inner.match(/"(?:[^"\\]|\\.)*"/g) ?? []).length : splitTopLevel(inner).length;
    if (rows <= 1) continue;
    tests += rows - 1;
    assertions += (rows - 1) * count(assertion, blockAfter(norm, close));
  }
  return { tests, assertions };
}
function count(re, text) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  return n;
}
var EACH_CALL = /\b(?:it|test|specify|describe)(?:\.(?:concurrent|only|skip|failing|sequential))*\.each\s*(\(|`)/g;
function eachRows(text, afterMatch, opener) {
  if (opener === "`") {
    const end = text.indexOf("`", afterMatch);
    if (end < 0) return { rows: 1, end: afterMatch };
    const rows2 = text.slice(afterMatch, end).split("\n").map((r) => r.trim()).filter((r) => r.includes("|"));
    return { rows: Math.max(1, rows2.length - 1), end: end + 1 };
  }
  let i = afterMatch;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "[") return { rows: 1, end: afterMatch };
  let depth = 0;
  let rows = 0;
  let sawElement = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === "[" || ch === "(" || ch === "{") {
      depth++;
      if (depth === 2 && ch !== "(") sawElement = true;
    } else if (ch === "]" || ch === ")" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (sawElement) rows++;
        return { rows: Math.max(1, rows), end: j + 1 };
      }
    } else if (ch === "," && depth === 1) {
      if (sawElement) rows++;
      sawElement = false;
    } else if (depth === 1 && !/\s/.test(ch)) {
      sawElement = true;
    }
  }
  return { rows: 1, end: afterMatch };
}
function eachBody(text, from) {
  const open = text.indexOf("(", from);
  if (open < 0 || open - from > 40) return "";
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    const ch = text[j];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, j + 1);
    }
  }
  return "";
}
function countTests(lang, text, sniffed = false) {
  if (!text || lang === "other") return { tests: 0, assertions: 0, skipped: 0, unknownEach: false };
  const c = COUNTERS[lang];
  let norm = normalizeFile(lang, text);
  if (lang === "rust") {
    const regions = rustTestRegions(norm, sniffed);
    if (regions) {
      let out3 = "";
      let at = 0;
      for (const [s, e] of regions) {
        out3 += norm.slice(at, s).replace(/[^\n]/g, " ") + norm.slice(s, e);
        at = e;
      }
      norm = out3 + norm.slice(at).replace(/[^\n]/g, " ");
    }
  }
  let tests = count(c.test, norm);
  let assertions = count(c.assertion, norm);
  let unknownEach = false;
  if (isAttrLang(lang)) {
    assertions += rowAssertionCredit(lang, norm, c.assertion);
    if (lang === "java") {
      const rows = javaSourceRows(text, norm, c.assertion);
      tests += rows.tests;
      assertions += rows.assertions;
    }
    if (UNKNOWN_ROWS[lang].test(norm)) unknownEach = true;
  }
  if (lang === "js") {
    EACH_CALL.lastIndex = 0;
    let m;
    while (m = EACH_CALL.exec(norm)) {
      const opener = m[1];
      const afterMatch = m.index + m[0].length;
      const literal = opener === "`" || /^\s*\[/.test(norm.slice(afterMatch, afterMatch + 20));
      if (m[0].startsWith("describe") || !literal) {
        unknownEach = true;
        continue;
      }
      const { rows, end } = eachRows(opener === "`" ? text : norm, afterMatch, opener);
      tests += rows - 1;
      assertions += (rows - 1) * count(c.assertion, eachBody(norm, end));
    }
  }
  if (lang === "go") tests += count(/\bt\.Run\s*\(/g, norm);
  return { tests, assertions, skipped: count(c.skip, norm), unknownEach };
}
function suppression(lines, idx) {
  const here = lines[idx];
  if (!here) return null;
  const m = SUPPRESS_RE.exec(here.text);
  if (m) return (m[1] ?? "").trim() || "no reason given";
  const prev = lines[idx - 1];
  if (prev && prev.kind !== "-") {
    const pm = SUPPRESS_RE.exec(prev.text);
    if (pm && /^\s*(?:\/\/|#|\/\*|--|<!--)/.test(prev.text)) return (pm[1] ?? "").trim() || "no reason given";
  }
  return null;
}
function trimEvidence(s) {
  const t = s.trim();
  return t.length > 160 ? t.slice(0, 157) + "..." : t;
}
function indentOf(text) {
  return /^\s*/.exec(text)?.[0].length ?? 0;
}
function titleOf(text) {
  const m = /['"`]([^'"`]{1,200})['"`]/.exec(text);
  return m ? m[1] : null;
}
function add(ctx, id2, severity, line, message, evidence, suppressed) {
  ctx.findings.push({ id: id2, severity, file: ctx.file.path, line: line ? line.newNo ?? line.oldNo : null, message, evidence: trimEvidence(evidence), suppressed });
  if (suppressed && ctx.ci) {
    ctx.findings.push({ id: "suppression-added", severity: "high", file: ctx.file.path, line: line ? line.newNo ?? line.oldNo : null, message: `suppression added in CI mode (${suppressed})`, evidence: trimEvidence(evidence), suppressed: null });
  }
}
var JS_ONLY = /\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe|ftest)\s*\(/;
var JS_TODO = /\b(?:it|test|specify)\.todo\s*\(/;
var STRONG_MATCHER = {
  js: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  py: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  go: /\.(?:toBe|toEqual|toStrictEqual|toMatchObject|toHaveLength|toContain|toContainEqual|toHaveProperty|toMatch|toThrow|toHaveBeenCalledWith|toHaveBeenCalledTimes|toBeCloseTo|toBeGreaterThan|toBeLessThan|toMatchSnapshot|toMatchInlineSnapshot)\s*\(/,
  rust: /\bassert_(?:eq|ne|matches)!\s*\(|\bassert!\s*\([^;]*(?:==|!=|<|>|\.contains\(|\.starts_with\(|\.ends_with\()|\bassert_(?:relative|abs_diff|ulps)_eq!/,
  java: /\bassert(?:Equals|ArrayEquals|IterableEquals|Same|LinesMatch|Throws|ThrowsExactly)\s*\(|\.(?:isEqualTo|isSameAs|containsExactly|containsExactlyInAnyOrder|hasSize|isInstanceOf|contains|startsWith|endsWith|hasMessage)\s*\(/,
  csharp: /\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|StrictEqual|Contains|Throws|ThrowsExactly|That\s*\([^,]+,\s*Is\.(?:EqualTo|SameAs))|\.Should\(\)\.(?:Be|BeEquivalentTo|Equal|Contain|HaveCount|Throw|StartWith|EndWith)\s*\(/,
  other: /$^/
};
var LOOP_ONLY = /\bfor\s*\(|\.forEach\s*\(|\.map\s*\(|\bwhile\s*\(|@pytest\.mark\.parametrize|^\s*for\s+[\p{L}\p{N}_,\s]+\s+in\b|\bt\.Run\s*\(|\brange\s+\w+|\bfor\s+[\w(),&\s]+\s+in\b|\.for_each\s*\(|#\[\s*(?:rstest|values|test_matrix)\b|\bforeach\s*\(|\bAssert\.(?:Multiple|All)\s*\(|\bassertAll\s*\(|DynamicTest\.dynamicTest\s*\(/mu;
var TAUTOLOGY = {
  js: /\bexpect\s*\(\s*(?:true|false|null|undefined|\d+|'\s*'|"\s*"|`\s*`)\s*\)\s*\.(?:not\.)?(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeDefined|toBeNull|toBeUndefined)\s*\(/,
  py: /^\s*assert\s+(?:True|1|"\s*"|'\s*')\s*(?:#.*)?$|\bself\.assertTrue\s*\(\s*True\s*\)|\bself\.assertEqual\s*\(\s*(\w+)\s*,\s*\1\s*\)/,
  go: /\b(?:assert|require)\.True\s*\(\s*t\s*,\s*true\s*\)|\b(?:assert|require)\.Equal\s*\(\s*t\s*,\s*(\w+)\s*,\s*\1\s*\)/,
  rust: /\b(?:debug_)?assert!\s*\(\s*(?:true|!false|1\s*==\s*1)\s*[,)]|\bassert_eq!\s*\(\s*([A-Za-z_][\w.:()]*)\s*,\s*\1\s*[,)]|\bassert_ne!\s*\(\s*true\s*,\s*false\s*[,)]|\bassert!\s*\(\s*matches!\s*\([^,]+,\s*_\s*\)\s*\)|\bassert!\s*\(\s*(\w+)\.is_ok\(\)\s*\|\|\s*\2\.is_err\(\)/,
  java: /\bassertTrue\s*\(\s*(?:"[^"]*"\s*,\s*)?(?:true|Boolean\.TRUE|!false)\s*[,)]|\bassertFalse\s*\(\s*(?:"[^"]*"\s*,\s*)?(?:false|Boolean\.FALSE|!true)\s*[,)]|\bassert(?:Equals|Same)\s*\(\s*(?:"[^"]*"\s*,\s*)?([A-Za-z_][\w.()]*)\s*,\s*\1\s*[,)]|\bassertNotNull\s*\(\s*(?:new\s+\w+|"|\d|List\.of|Map\.of|Optional\.of)|\bassertNull\s*\(\s*null\s*[,)]|\bassertThat\s*\(\s*true\s*\)\s*\.isTrue\(\)|\bassertThat\s*\(\s*([A-Za-z_][\w.()]*)\s*\)\s*\.is(?:EqualTo|SameAs)\(\s*\2\s*\)|\bassertThat\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*(?:is\s*\(\s*)?(?:equalTo|sameInstance)\s*\(\s*\3\s*\)|\bassertDoesNotThrow\s*\(\s*\(\)\s*->\s*\{\s*\}\s*\)/,
  csharp: /\bAssert\.(?:True|IsTrue)\s*\(\s*true\s*[,)]|\bAssert\.(?:False|IsFalse)\s*\(\s*false\s*[,)]|\bAssert\.That\s*\(\s*true\s*(?:,\s*Is\.True\s*)?\)|\bAssert\.That\s*\(\s*\(\)\s*=>\s*true\s*\)|\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|AreEquivalent)\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*\1\s*[,)]|\bAssert\.(?:NotNull|IsNotNull)\s*\(\s*(?:new\s|"|\d|\[\s*\])|\bAssert\.That\s*\(\s*([A-Za-z_][\w.()]*)\s*,\s*Is\.EqualTo\s*\(\s*\2\s*\)|\btrue\.Should\(\)\.BeTrue\(\)|\b([A-Za-z_][\w.()]*)\.Should\(\)\.Be\(\s*\3\s*\)/
};
var TAUTOLOGY_RAW = {
  rust: /\bassert_eq!\s*\(\s*(-?\d+(?:\.\d+)?|true|false|"[^"]*")\s*,\s*\1\s*[,)]/,
  java: /\bassert(?:Equals|Same)\s*\(\s*(?:"[^"]*"\s*,\s*)?(-?\d+(?:\.\d+)?[LlFfDd]?|"[^"]*"|true|false|null)\s*,\s*\1\s*[,)]/,
  csharp: /\bAssert\.(?:Equal|AreEqual)\s*\(\s*(-?\d+(?:\.\d+)?[mMfFdDL]?|"[^"]*"|true|false|null)\s*,\s*\1\s*[,)]/
};
var EARLY_RETURN = /^\s*(?:if\b[^{]*\{\s*)?return;?\s*\}?\s*$|^\s*if\s*\(.*\)\s*return;\s*$|^\s*Assert\.Pass\s*\(.*\)\s*;\s*$/;
var DOWNGRADES = [
  { from: /\.toStrictEqual\s*\(/, to: /\.toEqual\s*\(/, what: "toStrictEqual -> toEqual" },
  { from: /\.toEqual\s*\(/, to: /\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined)\s*\(/, what: "toEqual -> existence check", existence: true },
  { from: /\.toBe\s*\((?!true|false)/, to: /\.(?:toBeTruthy|toBeDefined|not\.toBeNull|not\.toBeUndefined|toBeFalsy)\s*\(/, what: "toBe(value) -> truthiness check", existence: true },
  { from: /\.toHaveBeenCalledWith\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: "toHaveBeenCalledWith -> toHaveBeenCalled" },
  { from: /\.toHaveBeenCalledTimes\s*\(/, to: /\.toHaveBeenCalled\s*\(\s*\)/, what: "toHaveBeenCalledTimes -> toHaveBeenCalled" },
  { from: /\.toThrow(?:Error)?\s*\(\s*(?:['"`\/]|new\s|\w)/, to: /\.toThrow(?:Error)?\s*\(\s*\)/, what: "toThrow(message) -> toThrow()" },
  { from: /\.toHaveLength\s*\(\s*\d+/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: "toHaveLength(n) -> existence check", existence: true },
  { from: /\.toMatchObject\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: "toMatchObject -> existence check", existence: true },
  { from: /\.toMatchSnapshot\s*\(|\.toMatchInlineSnapshot\s*\(/, to: /\.(?:toBeDefined|toBeTruthy)\s*\(/, what: "snapshot -> existence check", existence: true },
  { from: /\bassertEqual\s*\(/, to: /\bassert(?:True|IsNotNone|In)\s*\(/, what: "assertEqual -> weaker assert" },
  { from: /^\s*assert\s+\S.*?(?:==|!=|<=|>=|<|>)\s*\S/, to: /^\s*assert\s+(?:[\w.()\[\]'"]+)\s+is\s+not\s+None\s*$|^\s*assert\s+[\w.()\[\]'"]+\s*$|^\s*assert\s+len\s*\([^)]*\)\s*$|^\s*assert\s+\S+\s*!=\s*None\s*$/, what: "assert x == value -> existence/truthiness check", existence: true },
  { from: /\bassertRaises\s*\(\s*\w+/, to: /\bassertRaises\s*\(\s*Exception\b/, what: "assertRaises(Specific) -> assertRaises(Exception)" },
  { from: /\bpytest\.raises\s*\(\s*(?!Exception\b)\w+/, to: /\bpytest\.raises\s*\(\s*(?:Exception|BaseException)\b/, what: "pytest.raises(Specific) -> raises(Exception)" },
  { from: /\b(?:assert|require)\.(?:Equal|EqualValues|Exactly|Same|ElementsMatch|Len)\s*\(/, to: /\b(?:assert|require)\.(?:NotNil|NotEmpty|True|NoError)\s*\(/, what: "Equal -> NotNil/NotEmpty/True" },
  // Rust
  { lang: "rust", from: /\bassert_eq!\s*\(/, to: /\bassert!\s*\([^;]*?\.(?:is_ok|is_some|is_err|is_none)\(\)\s*[,)]|\bassert!\s*\(\s*![^;]*?\.is_empty\(\)|\bassert!\s*\([^;]*?\.len\(\)\s*[>!]=?\s*0/, what: "assert_eq! -> variant/existence check (is_ok/is_some/!is_empty)", existence: true },
  { lang: "rust", from: /\bassert_eq!\s*\(/, to: /\bmatches!\s*\([^,]+,\s*(?:Some|Ok|Err)\(\s*_\s*\)|\bmatches!\s*\([^,]+,\s*[\w:]+\s*\{\s*\.\.\s*\}/, what: "assert_eq!(x, Some(v)) -> matches!(x, Some(_))", existence: true },
  { lang: "rust", from: /\bmatches!\s*\(/, to: /\.is_(?:ok|err|some|none)\(\)/, what: "matches!(err, Error::Specific) -> is_err()" },
  { lang: "rust", from: /\.(?:unwrap|expect)\s*\(/, to: /\.(?:unwrap_or_default|unwrap_or|unwrap_or_else|ok|unwrap_unchecked)\s*\(/, what: ".unwrap() -> .unwrap_or_default()/.ok(): a failure no longer panics", existence: true },
  { lang: "rust", from: /\bassert_eq!\s*\([^,]*\.len\(\)\s*,\s*\d+/, to: /\bassert!\s*\(\s*![^)]*\.is_empty\(\)/, what: "assert_eq!(v.len(), n) -> !v.is_empty()", existence: true },
  { lang: "rust", from: /\bassert_(?:relative|abs_diff|ulps)_eq!\s*\(/, to: /\bassert!\s*\(\s*\([^)]*\)\.abs\(\)\s*</, what: "approx assertion -> hand-rolled abs() < eps" },
  // verified: the bare form passes on any panic, `expected` requires the message substring (https://doc.rust-lang.org/reference/attributes/testing.html)
  { lang: "rust", from: /^\s*#\[\s*should_panic\s*(?:\(\s*expected\s*=|=)/, to: /^\s*#\[\s*should_panic\s*\]/, what: '#[should_panic(expected = "...")] -> #[should_panic]: any panic now passes', attr: true },
  // Java
  { lang: "java", from: /\bassert(?:Equals|ArrayEquals|IterableEquals|Same|LinesMatch)\s*\(/, to: /\bassertNotNull\s*\(|\bassertTrue\s*\(\s*(?:[^)]*!=\s*null|[^)]*\.isPresent\(\)|![^)]*\.isEmpty\(\)|[^)]*\.(?:size|length)\(\)\s*>\s*0|[^)]*\.(?:contains|startsWith|endsWith|containsKey)\s*\(|[^)]*\binstanceof\b)/, what: "assertEquals -> existence/containment check", existence: true },
  // verified: assertThrows accepts "a given type or a subclass thereof" (docs.junit.org Assertions)
  { lang: "java", from: /\bassertThrows(?:Exactly)?\s*\(\s*(?!(?:Exception|RuntimeException|Throwable|Error)\b)[\w.]+\.class/, to: /\bassertThrows\s*\(\s*(?:Exception|RuntimeException|Throwable|Error)\.class/, what: "assertThrows(Specific.class) -> assertThrows(Exception.class)" },
  { lang: "java", from: /\bassertThrowsExactly\s*\(/, to: /\bassertThrows\s*\(/, what: "assertThrowsExactly -> assertThrows (subclasses accepted)" },
  { lang: "java", from: /\bexpected(?:Exceptions)?\s*=\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class/, to: /\bexpected(?:Exceptions)?\s*=\s*(?:Exception|RuntimeException|Throwable)\.class/, what: "@Test(expected = Specific) -> Exception", attr: true },
  { lang: "java", from: /\.is(?:EqualTo|SameAs|EqualToComparingFieldByField)\s*\(|\.usingRecursiveComparison\(\)/, to: /\.(?:isNotNull|isNotEmpty|isPresent|isNotBlank|isInstanceOf|isNotEqualTo)\s*\(|\.hasSizeGreaterThan\s*\(\s*0\s*\)/, what: "AssertJ isEqualTo -> existence check", existence: true },
  { lang: "java", from: /\.containsExactly(?:InAnyOrder)?\s*\(|\.containsOnly\s*\(/, to: /\.(?:contains|containsAnyOf|isNotEmpty|hasSizeGreaterThan)\s*\(/, what: "containsExactly -> contains/isNotEmpty" },
  { lang: "java", from: /\.hasSize\s*\(\s*\d+/, to: /\.(?:isNotEmpty|isNotNull)\s*\(/, what: "hasSize(n) -> isNotEmpty", existence: true },
  { lang: "java", from: /\.isInstanceOf\s*\(\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class|\bassertThatExceptionOfType\s*\(\s*(?!(?:Exception|RuntimeException|Throwable)\b)[\w.]+\.class/, to: /\.isInstanceOf\s*\(\s*(?:Exception|RuntimeException|Throwable)\.class|\bassertThatExceptionOfType\s*\(\s*(?:Exception|RuntimeException|Throwable)\.class/, what: "AssertJ exception type widened to Exception" },
  { lang: "java", from: /\bassertThat\s*\([^,]+,\s*(?:is\s*\(\s*)?(?:equalTo|sameInstance|contains|containsInAnyOrder)\s*\(/, to: /\bassertThat\s*\([^,]+,\s*(?:is\s*\(\s*)?(?:notNullValue|not\s*\(\s*nullValue|hasItem|not\s*\(\s*empty)\s*\(/, what: "Hamcrest equalTo -> notNullValue/hasItem", existence: true },
  { lang: "java", from: /\bverify\s*\([^)]*\)\s*\.\s*\w+\s*\((?![^)]*\bany\w*\s*\()/, to: /\bverify\s*\([^)]*\)\s*\.\s*\w+\s*\([^)]*\bany(?:String|Int|Long|Boolean|List|Map|Set|Collection|Iterable|Object)?\s*\(\s*\)/, what: "verify(...).method(exact args) -> any()" },
  { lang: "java", from: /\bverify\s*\([^,)]+,\s*times\s*\(\s*\d+\s*\)/, to: /\bverify\s*\([^,)]+,\s*(?:atLeastOnce|atLeast|atMost)\s*\(/, what: "verify(times(n)) -> atLeast/atMost" },
  // C#
  { lang: "csharp", from: /\bAssert\.(?:Equal|AreEqual|Same|AreSame|Equivalent|AreEquivalent|StrictEqual|Contains|HasCount|AreSequenceEqual)\s*\(/, to: /\bAssert\.(?:NotNull|IsNotNull|NotEmpty|IsNotEmpty|True\s*\(\s*[^)]*!=\s*null|IsTrue\s*\(\s*[^)]*!=\s*null|True\s*\(\s*[^)]*\.Any\(\))/, what: "Assert.Equal -> NotNull/NotEmpty", existence: true },
  { lang: "csharp", from: /\bAssert\.That\s*\([^,]+,\s*Is\.(?:EqualTo|EquivalentTo|SameAs|SupersetOf|SubsetOf)\s*\(|\bAssert\.That\s*\([^,]+,\s*Has\.(?:Count|Length|Exactly)/, to: /\bAssert\.That\s*\([^,]+,\s*Is\.Not\.(?:Null|Empty)\b/, what: "Is.EqualTo -> Is.Not.Null/Empty", existence: true },
  // verified: xUnit Assert.ThrowsAny accepts derived types; NUnit "Throws.TypeOf requires an exact type match" (docs.nunit.org Throws constraint)
  { lang: "csharp", from: /\bAssert\.Throws<(?!(?:Exception|SystemException|ApplicationException)>)[\w.]+>|\bAssert\.ThrowsExactly(?:Async)?<(?!(?:Exception)>)[\w.]+>|\bAssert\.ThrowsException<(?!(?:Exception)>)[\w.]+>/, to: /\bAssert\.ThrowsAny(?:Async)?<[\w.]+>|\bAssert\.Throws(?:Async|Exception|ExceptionAsync)?<(?:Exception|SystemException|ApplicationException)>/, what: "Assert.Throws<Specific> -> ThrowsAny/Throws<Exception>" },
  { lang: "csharp", from: /\bAssert\.ThrowsExactly(?:Async)?</, to: /\bAssert\.Throws(?:Async)?</, what: "ThrowsExactly -> Throws (derived types accepted)" },
  { lang: "csharp", from: /\bThrows\.TypeOf<(?!(?:Exception)>)[\w.]+>/, to: /\bThrows\.(?:InstanceOf<(?:Exception|SystemException)>|Exception\b(?!\.)|InstanceOf<[\w.]+>)/, what: "Throws.TypeOf<T> -> Throws.InstanceOf/Throws.Exception" },
  { lang: "csharp", from: /\.Should\(\)\.(?:Be|BeEquivalentTo|BeSameAs|HaveCount|ContainSingle|Equal|ContainInOrder)\s*\(/, to: /\.Should\(\)\.(?:NotBeNull|NotBeEmpty|BeOfType|NotBeNullOrEmpty|NotBeNullOrWhiteSpace|HaveCountGreaterThan\s*\(\s*0)\s*\(?/, what: "Should().Be -> Should().NotBeNull", existence: true },
  { lang: "csharp", from: /\.Should\(\)\.(?:Throw|ThrowExactly)(?:Async)?<(?!(?:Exception)>)[\w.]+>/, to: /\.Should\(\)\.Throw(?:Async)?<(?:Exception|SystemException)>|\.Should\(\)\.Throw(?:Async)?\s*\(\s*\)/, what: "Should().Throw<Specific> -> Throw<Exception>" },
  { lang: "csharp", from: /\.Verify\s*\([^)]*\bIt\.Is(?:<[^>]*>)?\s*\(/, to: /\.Verify\s*\([^)]*\bIt\.IsAny<[^>]*>\s*\(\s*\)/, what: "Moq It.Is(...) -> It.IsAny<T>()" },
  { lang: "csharp", from: /\.Verify\s*\([^;]*,\s*Times\.(?:Once|Exactly)\s*\(/, to: /\.Verify\s*\([^;]*,\s*Times\.(?:AtLeastOnce|AtLeast|AtMost|AtMostOnce)\s*\(/, what: "Times.Once -> Times.AtLeastOnce" }
];
var TOLERANCES = [
  { lang: "rust", re: /\b(?:epsilon|max_relative)\s*=\s*([\d.eE+-]+)/, kind: "factor", what: "approx epsilon/max_relative widened" },
  { lang: "rust", re: /\bmax_ulps\s*=\s*(\d+)/, kind: "factor", what: "approx max_ulps widened" },
  { lang: "rust", re: /\)\.abs\(\)\s*<=?\s*([\d.eE+-]+)/, kind: "factor", what: "hand-rolled abs() tolerance widened" },
  { lang: "java", re: /\bassertEquals\s*\(/, kind: "factor", what: "assertEquals delta widened", delta: true },
  { lang: "java", re: /\b(?:within|offset|withPrecision|byLessThan)\s*\(\s*([\d.eE+-]+)/, kind: "factor", what: "AssertJ tolerance widened" },
  { lang: "java", re: /\bcloseTo\s*\([^,]+,\s*([\d.eE+-]+)/, kind: "factor", what: "Hamcrest closeTo tolerance widened" },
  { lang: "csharp", re: /\bAssert\.Equal\s*\((?:[^,;]*,){2}\s*(?:precision:\s*)?(\d+)\s*\)\s*;/, kind: "digits", what: "Assert.Equal precision lowered" },
  { lang: "csharp", re: /\.Within\s*\(\s*([\d.eE+-]+)/, kind: "factor", what: "NUnit Within tolerance widened" },
  { lang: "csharp", re: /\bBeApproximately\s*\([^,]+,\s*([\d.eE+-]+)/, kind: "factor", what: "BeApproximately tolerance widened" },
  { lang: "csharp", re: /\bAssert\.AreEqual\s*\(/, kind: "factor", what: "AreEqual delta widened", delta: true }
];
function toleranceOf(t, code) {
  const m = t.re.exec(code);
  if (!m) return null;
  if (!t.delta) return Number(m[1]);
  const args = splitArgs(code, m.index + m[0].length - 1);
  const last = (args[args.length - 1] ?? "").trim();
  return args.length >= 3 && /^[\d.eE+-]*\d[\d.eE+-]*[fFdDmM]?$/.test(last) ? Number(last.replace(/[fFdDmM]$/, "")) : null;
}
function subjectOf(lang, text) {
  const squash = (s) => s.replace(/\s+/g, "").slice(-60);
  if (lang === "go") {
    const m2 = /\b(?:assert|require)\.\w+\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
    if (m2) {
      const args = splitTopLevel(m2[1]);
      return squash(args[args.length - 1] ?? "");
    }
  }
  if (lang === "py") {
    const u = /\bself\.assert\w+\s*\(([\s\S]*)\)\s*$/.exec(text.trim());
    if (u) return squash(splitTopLevel(u[1])[0] ?? "");
    const plain2 = /^\s*assert\s+(.+?)\s*(?:==|!=|<=|>=|<|>|\bis\b|\bin\b|\bnot\b|$)/.exec(text);
    if (plain2) return squash(plain2[1]);
  }
  const m = /^(.*?)\.(?:to[A-Z]\w*|not)\b/.exec(text) ?? /^(.*?)\b(?:pytest\.raises|assertRaises)\s*\(/.exec(text) ?? /^(.*?)\b(?:assert\w*|require\.\w+)\s*\(/.exec(text);
  return squash(m?.[1] ?? text);
}
function splitTopLevel(s) {
  const out3 = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out3.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out3.push(cur);
  return out3;
}
function splitArgs(text, open) {
  if (text[open] !== "(") return [];
  const out3 = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        cur += text[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim() !== "") out3.push(cur);
        return out3;
      }
    }
    if (ch === "," && depth === 1) {
      out3.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") out3.push(cur);
  return out3;
}
var LITERAL_ARG = /^(?:-?\d[\w.]*|b?["'].*|true|false|null|None|Boolean\.(?:TRUE|FALSE))$/;
var WEAK_SUFFIX = /(?:\.(?:unwrap|expect|unwrap_err|expect_err|clone|as_str|to_string|as_ref|is_ok|is_some|is_err|is_none|is_empty|isPresent|isEmpty|size|len|length|Any|Count|ToString|ToList|ToArray)\s*\([^()]*\)|\?|\.(?:length|Count|Length)|\s*[!=]=\s*null)\s*$/;
function subjectsOf(lang, text) {
  if (!isAttrLang(lang)) return [subjectOf(lang, text)];
  const squash = (s) => s.replace(/\s+/g, "").slice(-60);
  const clean = (arg) => {
    let a2 = arg.trim().replace(/^(?:&mut\s+|[&!*]\s*)+/, "");
    if (/^matches!\s*\(/.test(a2)) a2 = (splitArgs(a2, a2.indexOf("("))[0] ?? a2).trim();
    for (let n = 0; n < 4; n++) a2 = a2.replace(WEAK_SUFFIX, "");
    return squash(a2);
  };
  const t = text.trim().replace(/^\s*(?:let\s+(?:mut\s+)?|final\s+|var\s+)?(?:[\w:<>\[\],?()]+\s+)?[A-Za-z_]\w*\s*=\s*(?=[^=])/, "");
  let m;
  if (lang === "java" && (m = /\bverify\s*\(([^)]*)\)\s*\.\s*(\w+)/.exec(t))) return [squash(`verify(${m[1]}).${m[2]}`)];
  if (lang === "csharp" && (m = /^(.*?)\.(?:Verify|Received|DidNotReceive)\s*\(\s*(\w+\s*=>\s*\w+\.\w+)/.exec(t))) return [squash(`${m[1]}.${m[2]}`)];
  if (lang === "csharp" && (m = /^(.*?)\.Should\s*\(/.exec(t))) return [clean(m[1])];
  if (lang === "rust" && !/\b(?:assert\w*|panic|matches)!/.test(t) && (m = /^(.*?)\.(?:unwrap\w*|expect\w*|ok)\s*\(/.exec(t))) return [clean(m[1])];
  const re = new RegExp(COUNTERS[lang].assertion.source);
  const a = re.exec(t);
  if (!a || a[0].startsWith("@") || t[a.index + a[0].length - 1] !== "(") return [squash(t)];
  const open = a.index + a[0].length - 1;
  if (a[0].startsWith(".")) return [clean(t.slice(0, a.index))];
  const args = splitArgs(t, open);
  const fluent = /\b(?:assertThat|assertThatThrownBy|assertThatCode|assertThatExceptionOfType|Assert\.That)\s*\($/.test(t.slice(0, open + 1));
  const subjects = (fluent ? args.slice(0, 1) : args).map(clean).filter((s) => s !== "" && !LITERAL_ARG.test(s));
  return subjects.length > 0 ? subjects : [squash(t)];
}
function intersects(a, b) {
  return a.some((x) => b.includes(x));
}
function subjectRoot(lang, subject) {
  if (isAttrLang(lang)) return subject;
  const m = /^(expect\([^.)\[]*)/.exec(subject);
  return m ? m[1] : subject;
}
var SIGNATURE = {
  rust: /\bfn\s+([A-Za-z_]\w*)/,
  java: /^(?:(?:public|private|protected|static|final|synchronized|default|abstract|native|strictfp|open|internal|suspend|override)\s+)*(?:fun\s+(?:`([^`]+)`|([A-Za-z_]\w*))|(?:<[^>]+>\s*)?[\w.<>\[\],?]+\s+([A-Za-z_]\w*)\s*\(|(?:class|interface|object)\s+([A-Za-z_]\w*))/,
  csharp: /^(?:(?:public|private|protected|internal|static|async|override|virtual|new|unsafe|extern|partial|sealed)\s+)*(?:[\w.<>\[\],?()]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(|(?:class|record|struct)\s+([A-Za-z_]\w*))/
};
var ATTR_LINE = { rust: /^#\[/, java: /^@/, csharp: /^\[/ };
function signatureOf(lang, t) {
  const m = SIGNATURE[lang].exec(t.trim());
  if (!m) return null;
  return m.slice(1).find(Boolean) ?? null;
}
function attrHead(lang, t) {
  const m = lang === "rust" ? /^#\[\s*([\w:]+)/.exec(t) : lang === "java" ? /^@(\w+)/.exec(t) : /^\[\s*(?:[\w.]+\.)?(\w+)/.exec(t);
  const name = m?.[1] ?? t;
  return lang === "rust" ? `#[${name}]` : lang === "java" ? `@${name}` : `[${name}]`;
}
function declSignature(lang, lines, idx, kind) {
  const own = normalize(lang, lines[idx].text).trim();
  const rest = own.replace(/^(?:#\[[^\]]*\]|@\w+(?:\([^)]*\))?|\[[^\]]*\])\s*/, "");
  const intact = stripComment(lang, lines[idx].text).trim().replace(/^(?:#\[[^\]]*\]|@\w+(?:\([^)]*\))?|\[[^\]]*\])\s*/, "");
  const same = rest !== "" && !ATTR_LINE[lang].test(rest) ? signatureOf(lang, intact) : null;
  if (same) return same;
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 8; j++) {
    const l = lines[j];
    if (l.kind !== kind && l.kind !== " ") continue;
    const t = normalize(lang, l.text).trim();
    if (t === "") continue;
    seen++;
    if (ATTR_LINE[lang].test(t)) continue;
    return signatureOf(lang, stripComment(lang, l.text).trim());
  }
  return null;
}
function declKey(lang, lines, idx, kind) {
  const own = normalize(lang, lines[idx].text).trim();
  const sig = declSignature(lang, lines, idx, kind);
  return sig ? `${attrHead(lang, own)} ${sig}` : attrHead(lang, own);
}
function skipKey(lang, lines, idx, kind) {
  const own = normalize(lang, lines[idx].text).replace(/\s*=\s*"[^"]*"/g, "").replace(/\(\s*"[^"]*"\s*\)/g, "").replace(/\s+/g, "");
  const sig = declSignature(lang, lines, idx, kind);
  return sig ? `${own} ${sig}` : own;
}
function toleranceSeverity(kind, before, after) {
  if (kind === "digits") {
    if (after <= 0) return "high";
    return before - after >= 2 ? "medium" : "low";
  }
  const factor = after / Math.max(before, 1e-300);
  return factor >= 100 ? "high" : factor >= 10 ? "medium" : "low";
}
function takeMoved(cross, fromPath, decl) {
  for (const [path, titles] of cross.addedByFile) {
    if (path === fromPath) continue;
    const n = titles.get(decl) ?? 0;
    if (n > 0) {
      titles.set(decl, n - 1);
      return true;
    }
  }
  return false;
}
function declarationLines(lang, lines, kind, inRegion = () => true) {
  if (lang === "other") return [];
  const re = new RegExp(COUNTERS[lang].test.source, COUNTERS[lang].test.flags.replace("g", ""));
  if (isAttrLang(lang)) {
    const out3 = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind !== kind || !inRegion(l)) continue;
      if (re.test(normalize(lang, l.text).trim())) out3.push(declKey(lang, lines, i, kind));
    }
    return out3;
  }
  return lines.filter((l) => l.kind === kind).map((l) => normalize(lang, l.text).trim()).filter((t) => re.test(t) && !/\.skip\s*\(|\.only\s*\(/.test(t));
}
function nextCodeLine(lang, lines, idx, kind) {
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 8; j++) {
    const l = lines[j];
    if (l.kind !== kind && l.kind !== " ") continue;
    const t = normalize(lang, l.text).trim();
    if (t === "") continue;
    seen++;
    if (ATTR_LINE[lang].test(t)) continue;
    return t;
  }
  return "";
}
var RUST_PLATFORM_PRED = /^(?:not\(\s*)?(?:miri|debug_assertions|windows|unix|loom|fuzzing|coverage|sanitize|target_(?:os|arch|family|env|pointer_width|vendor|endian|has_atomic|feature)\s*=|panic\s*=)/;
var RUST_ALWAYS_TRUE = /^(?:all\(\s*\)|true|not\(\s*any\(\s*\)\s*\))$/;
var RUST_NEVER_TRUE = /^(?:any\(\s*\)|false|not\(\s*all\(\s*\)\s*\))$/;
function skipSeverity(lang, code, lines, idx, beforeText) {
  const gatesClass = /\b(?:class|interface|object|record)\s+[A-Za-z_]\w*/.test(nextCodeLine(lang, lines, idx, "+"));
  if (lang === "rust") {
    const ca = /#\[\s*cfg_attr\s*\((.*?),\s*ignore\s*\)/.exec(code);
    if (ca) {
      const pred = ca[1].trim();
      if (RUST_ALWAYS_TRUE.test(pred)) return ["critical", `#[cfg_attr(${pred}, ignore)]: the predicate is always true, the test is always ignored`];
      if (RUST_PLATFORM_PRED.test(pred)) return ["low", `test ignored under a platform/tool predicate (${pred}); it still runs under plain cargo test`];
      return ["high", `test ignored when cfg(${pred}) holds`];
    }
    return ["high", "#[ignore] added: cargo test reports the test as ignored, not failed"];
  }
  if (lang === "java") {
    if (/@(?:Disabled|Ignore)\b(?!(?:If|On|For|In))/.test(code) || /@Test\s*\([^)]*\benabled\s*=\s*false/.test(code) || /\bAssumptions\.abort\s*\(|\bassumeTrue\s*\(\s*false\s*\)|\bassumeFalse\s*\(\s*true\s*\)/.test(code)) {
      return gatesClass ? ["critical", "whole test class disabled"] : ["high", "test disabled: the runner reports it as skipped, not failed"];
    }
    if (/\bassum(?:eTrue|eFalse|eThat|eNotNull|eNoException|ingThat)\s*\(/.test(code)) {
      if (/System\.getenv|System\.getProperty|Boolean\.getBoolean|\bgetenv\s*\(/.test(code)) return ["high", "assumption on an environment variable/system property: the test is aborted (reported skipped) wherever it is not set"];
      return ["medium", "assumption added: the test is aborted (reported skipped) when it does not hold"];
    }
    if (/@Enabled(?:If|OnOs|OnJre|ForJreRange|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables|InNativeImage)\b/.test(code)) {
      const sig = declSignature(lang, lines, idx, "+");
      const isNew = sig !== null && (beforeText === null || !new RegExp(`\\b${sig}\\s*\\(`).test(beforeText));
      if (isNew) return ["low", "new test gated behind a positive condition"];
      return ["high", "positive gate added to an existing test: it only runs when the condition holds (on CI usually never)"];
    }
    if (/@Disabled(?:OnOs|OnJre|ForJreRange|InNativeImage)\b/.test(code)) return ["low", "test disabled on a platform/JRE; it still runs elsewhere"];
    if (/@Disabled(?:If|IfSystemProperty|IfSystemProperties|IfEnvironmentVariable|IfEnvironmentVariables)\b/.test(code)) return ["medium", "test disabled behind a condition"];
    return ["high", "test skipped"];
  }
  if (/\bAssume\.That\s*\(|\bAssert\.Skip(?:When|Unless)\s*\(|\bSkip(?:When|Unless)\s*=/.test(code)) return ["medium", "conditional skip added: the test is skipped when the condition holds"];
  if (/\[\s*Explicit\b|\bExplicit\s*=\s*true/.test(code)) return ["high", "[Explicit] added: the test does not run unless explicitly selected"];
  return gatesClass ? ["critical", "whole test class ignored"] : ["high", "test skipped or ignored: the runner reports it as skipped, not failed"];
}
var OWN_FAILURE = {
  rust: /^\s*#\[\s*should_panic\s*\]/,
  java: /\bassertThrows(?:Exactly)?\s*\(\s*(?:AssertionError|AssertionFailedError|Throwable|Error)\.class|@Test\s*\([^)]*\bexpected\s*=\s*(?:AssertionError|Throwable|Error)\.class/,
  csharp: /\bAssert\.(?:Throws|ThrowsAny|ThrowsAsync|ThrowsAnyAsync|ThrowsException|ThrowsExactly)<(?:XunitException|AssertionException|AssertFailedException|Exception|SystemException)>\s*\(|\bThrows\.(?:InstanceOf|TypeOf)<(?:Exception|AssertionException|XunitException)>|\bThrows\.Exception\b/
};
var STRICT_ASSERT = {
  rust: /\b(?:debug_)?assert(?:_eq|_ne|_matches)?!\s*\(/g,
  java: /\bassert(?!Throws|ThatThrownBy|ThatExceptionOfType|ThatCode)\w*\s*\(|\bfail\s*\(/g,
  csharp: /\bAssert\.(?!Throws|ThrowsAny|ThrowsAsync|ThrowsException|ThrowsExactly|That\s*\([^,]*,\s*Throws)\w+|\.Should\s*\(\s*\)\.(?!Throw)/g
};
function wrappedBody(lang, lines, idx, attribute2) {
  const out3 = [];
  if (attribute2) {
    let sigIndent = -1;
    for (let j = idx + 1, seen = 0; j < lines.length && seen < 60; j++) {
      const l = lines[j];
      if (l.kind === "-") continue;
      const t = normalize(lang, l.text);
      if (t.trim() === "") continue;
      seen++;
      if (sigIndent < 0) {
        if (ATTR_LINE[lang].test(t.trim())) continue;
        sigIndent = indentOf(l.text);
        continue;
      }
      if (/^\s*\}/.test(t) && indentOf(l.text) <= sigIndent) break;
      out3.push(t);
    }
    return out3.join("\n");
  }
  const own = normalize(lang, lines[idx].text);
  const m = OWN_FAILURE[lang].exec(own);
  out3.push(own.slice(m ? m.index + m[0].length : 0));
  if (!/\{\s*$/.test(own)) return out3.join("\n");
  for (let j = idx + 1, seen = 0; j < lines.length && seen < 16; j++) {
    const l = lines[j];
    if (l.kind === "-") continue;
    const t = normalize(lang, l.text);
    seen++;
    if (/^\s*\}\s*\)/.test(t)) break;
    out3.push(t);
  }
  return out3.join("\n");
}
var CONST_DECL = {
  rust: (n) => new RegExp(`\\blet\\s+(?:mut\\s+)?${n}(?:\\s*:\\s*[^=]+)?\\s*=\\s*(?:-?[\\d.]+(?:_?[iuf]\\d+)?|true|false|"|vec!\\[\\s*\\]|Vec::new\\(\\)|None|String::new\\(\\))\\s*;`),
  java: (n) => new RegExp(`\\b(?:int|long|short|byte|double|float|boolean|char|String|var|val|Integer|Long|Double|Boolean|final\\s+\\w+)\\s+${n}\\s*(?::\\s*\\w+\\s*)?=\\s*(?:-?[\\d.]+[LlFfDd]?|true|false|null|"|List\\.of\\(\\)|Map\\.of\\(\\)|Set\\.of\\(\\))\\s*;?\\s*$`),
  csharp: (n) => new RegExp(`\\b(?:var|int|long|short|byte|double|float|bool|string|decimal|char)\\s+${n}\\s*=\\s*(?:-?[\\d.]+[mMfFdDL]?|true|false|null|"|\\[\\s*\\]|new\\s*\\(\\s*\\))\\s*;`)
};
var HELPER_DECL = {
  rust: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*[<(]/,
  java: /^\s*(?:(?:public|private|protected|static|final|synchronized|default|internal|open)\s+)*(?:<[^>]+>\s*)?(?:fun\s+([A-Za-z_]\w*)\s*\(|[\w.<>\[\],?]+\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[\w.,\s]+)?\{?\s*$)/,
  csharp: /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual)\s+)*[\w.<>\[\],?()]+\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*\{?\s*$/
};
var KEYWORD_NAME = /^(?:if|for|while|switch|catch|return|new|else|using|lock|foreach|throw|do|try|match|loop)$/;
function scanTestFile(ctx, opts, cross, movedPair) {
  const { file, lang } = ctx;
  if (file.status === "deleted") {
    if (!movedPair) add(ctx, "test-file-deleted", "high", null, "test file deleted", file.path, null);
    return;
  }
  if (file.oldPath && isTestFile(file.oldPath) && !isTestFile(file.path)) {
    add(ctx, "test-file-deleted", "high", null, `test file moved out of the test locations (${file.oldPath} -> ${file.path}); the runner will no longer collect it`, file.path, null);
    return;
  }
  if (lang === "java" && file.oldPath && /\.java$/.test(file.path)) {
    const name = (p) => p.replace(/\\/g, "/").split("/").pop() ?? p;
    if (MAVEN_TEST_NAME.test(name(file.oldPath)) && !MAVEN_TEST_NAME.test(name(file.path))) {
      const maven = opts.readAfter("pom.xml") !== null;
      add(ctx, "test-file-deleted", maven ? "high" : "medium", null, `renamed to a name Surefire/Failsafe do not collect by default (${file.oldPath} -> ${file.path}); Maven compiles it but never runs it`, file.path, null);
    }
  }
  const beforeText = file.status === "added" ? null : opts.readBefore(file.oldPath ?? file.path);
  const afterText = opts.readAfter(file.path);
  const sniffed = lang === "rust" && !isTestFile(file.path);
  const before = countTests(lang, beforeText, sniffed);
  const after = countTests(lang, afterText, sniffed);
  const beforeLines = lang === "rust" && beforeText ? regionLines(beforeText, rustTestRegions(normalizeFile(lang, beforeText), sniffed)) : null;
  const afterLines = lang === "rust" && afterText ? regionLines(afterText, rustTestRegions(normalizeFile(lang, afterText), sniffed)) : null;
  const inRegion = (l) => l.kind === "-" ? beforeLines === null || l.oldNo !== null && beforeLines.has(l.oldNo) : afterLines === null || l.newNo !== null && afterLines.has(l.newNo);
  const allLines = file.hunks.flatMap((h) => h.lines);
  const allRemoved = allLines.filter((l) => l.kind === "-" && inRegion(l));
  const allAdded = allLines.filter((l) => l.kind === "+" && inRegion(l));
  const addedNorm = allAdded.map((l) => normalize(lang, l.text));
  const addedText = addedNorm.join("\n");
  const assertRe = lang === "other" ? null : COUNTERS[lang].assertion;
  for (const hunk of file.hunks) {
    const removed = hunk.lines.filter((l) => l.kind === "-" && inRegion(l));
    const added = hunk.lines.filter((l) => l.kind === "+" && inRegion(l));
    const inComment = insideBlockComment(lang, hunk.lines);
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (line.kind !== "+") continue;
      if (inComment[i] || !inRegion(line)) continue;
      const code = normalize(lang, line.text);
      if (code.trim() === "") continue;
      const sup = suppression(hunk.lines, i);
      if (lang === "js" && JS_ONLY.test(code)) add(ctx, "only-added", "critical", line, "`.only` added: every other test in the file is silently skipped", line.text, sup);
      const skipRe = lang === "other" ? null : COUNTERS[lang].skip;
      if (skipRe && count(skipRe, code) > 0) {
        const moved2 = isAttrLang(lang) ? (() => {
          const key = skipKey(lang, hunk.lines, i, "+");
          return allLines.some((r, ri) => r.kind === "-" && count(skipRe, normalize(lang, r.text)) > 0 && skipKey(lang, allLines, ri, "-") === key);
        })() : allRemoved.some((r) => stripComment(lang, r.text).trim() === stripComment(lang, line.text).trim());
        if (!moved2) {
          const [severity, why] = isAttrLang(lang) ? skipSeverity(lang, code, hunk.lines, i, beforeText) : ["high", "test skipped or marked expected-failure"];
          add(ctx, "skip-added", severity, line, why, line.text, sup);
        }
      }
      if (lang === "rust") {
        const cfg = /^\s*#\[\s*cfg\s*\((.*)\)\s*\]\s*$/.exec(code);
        const next = cfg ? nextCodeLine(lang, hunk.lines, i, "+") : "";
        if (cfg && /^\s*(?:pub\s+)?(?:async\s+)?fn\s+/.test(next) && !/^\s*(?:all|any)?\(?\s*test\b/.test(cfg[1])) {
          const key = skipKey(lang, hunk.lines, i, "+");
          const moved2 = allLines.some((r, ri) => r.kind === "-" && /^\s*#\[\s*cfg\s*\(/.test(normalize(lang, r.text)) && skipKey(lang, allLines, ri, "-") === key);
          const pred = cfg[1].trim();
          if (!moved2) {
            const severity = RUST_NEVER_TRUE.test(pred) ? "critical" : RUST_PLATFORM_PRED.test(pred) ? "low" : "high";
            add(ctx, "skip-added", severity, line, severity === "critical" ? `#[cfg(${pred})] never compiles the test below it` : `test compiled only when cfg(${pred})`, line.text, sup);
          }
        }
      }
      if (lang === "js" && JS_TODO.test(code)) {
        const title = titleOf(line.text);
        const wasReal = title !== null && removed.some((r) => /\b(?:it|test|specify)\s*\(/.test(normalize("js", r.text)) && titleOf(r.text) === title);
        if (wasReal) add(ctx, "skip-added", "high", line, "existing test turned into a todo placeholder", line.text, sup);
        else add(ctx, "todo-added", "low", line, "todo placeholder added (not a real test)", line.text, sup);
      }
      const taut = lang === "other" ? null : TAUTOLOGY[lang];
      const tautRaw = TAUTOLOGY_RAW[lang];
      const interpolated = lang === "js" && /\bexpect\s*\(\s*`[^`]*\$\{/.test(line.text);
      if (taut && taut.test(code) && !interpolated || tautRaw && tautRaw.test(stripComment(lang, line.text))) add(ctx, "tautology-added", "high", line, "assertion that can never fail", line.text, sup);
      if (lang === "js") {
        const ea = /\bexpect\.assertions\s*\(\s*(\d+)\s*\)/.exec(code);
        if (ea) {
          const prev = removed.map((r) => /\bexpect\.assertions\s*\(\s*(\d+)\s*\)/.exec(normalize("js", r.text))).find(Boolean);
          const n = Number(ea[1]);
          if (n === 0) add(ctx, "assertion-weakened", "high", line, "expect.assertions(0): the test passes even if no assertion runs", line.text, sup);
          else if (prev && n < Number(prev[1])) add(ctx, "assertion-weakened", "medium", line, `expect.assertions lowered ${prev[1]} -> ${n}`, line.text, sup);
        }
        const subj = /\bexpect\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\.(?:not\.)?to\w+\s*\(/.exec(code)?.[1];
        if (subj) {
          const esc = subj.replace(/\$/g, "\\$");
          const constRe = new RegExp(`\\b(?:const|let|var)\\s+${esc}\\s*=\\s*(?:-?[\\d.]+|true|false|null|["'\`]|\\[\\s*\\]|\\{\\s*\\})`);
          const mutRe = new RegExp(`\\b${esc}\\s*(?:\\+\\+|--|[-+*/%]=)|\\b${esc}\\.(?:push|add|set|splice|unshift)\\s*\\(`);
          const isConst = added.some((a) => a !== line && constRe.test(normalize("js", a.text))) && !added.some((a) => mutRe.test(normalize("js", a.text)));
          if (isConst) add(ctx, "tautology-added", "high", line, `expect(${subj}) tests a constant assigned in the same change, not the code under test`, line.text, sup);
        }
      }
      if (isAttrLang(lang) && assertRe && count(assertRe, code) > 0 && !skipRe?.test(code)) {
        const subs = subjectsOf(lang, stripComment(lang, line.text));
        if (subs.length > 0 && subs.every((s) => /^[A-Za-z_]\w*$/.test(s))) {
          const isConst = subs.every((name) => {
            const constRe = CONST_DECL[lang](name);
            const mutRe = new RegExp(`(?:^|[^\\w.])${name}\\s*(?:\\+\\+|--|[-+*/%]=|=(?!=))|\\b${name}\\.(?:push|push_str|insert|extend|add|set|Add|Insert|Append|put)\\s*\\(`);
            return added.some((a) => a !== line && constRe.test(normalize(lang, a.text))) && !added.some((a) => a !== line && !constRe.test(normalize(lang, a.text)) && mutRe.test(normalize(lang, a.text)));
          });
          if (isConst) add(ctx, "tautology-added", "high", line, `assertion on ${subs.join(", ")}: a constant assigned in the same change, not the code under test`, line.text, sup);
        }
      }
      if (isAttrLang(lang)) {
        const own = OWN_FAILURE[lang].exec(code);
        if (own) {
          const attribute2 = lang === "rust" || own[0].startsWith("@");
          const moved2 = attribute2 && allLines.some((r, ri) => r.kind === "-" && OWN_FAILURE[lang].test(normalize(lang, r.text)) && skipKey(lang, allLines, ri, "-") === skipKey(lang, hunk.lines, i, "+"));
          if (!moved2 && count(STRICT_ASSERT[lang], wrappedBody(lang, hunk.lines, i, attribute2)) > 0) {
            add(ctx, "assertion-weakened", "high", line, lang === "rust" ? "#[should_panic] added over a body that asserts: the assertion failure now satisfies the attribute" : "the test expects the assertion exception itself: a failing assertion now passes", line.text, sup);
          }
        }
      }
      if (EARLY_RETURN.test(code)) {
        let indent = indentOf(line.text);
        let prevIdx = i - 1;
        while (prevIdx >= 0 && (hunk.lines[prevIdx].kind === "-" || normalize(lang, hunk.lines[prevIdx].text).trim() === "")) prevIdx--;
        const prev = prevIdx >= 0 ? hunk.lines[prevIdx] : null;
        const guarded = !/\bif\b/.test(code) && prev !== null && prev.kind === "+" && /^\s*(?:if|elif|else if)\b.*(?:\{|:)\s*$/.test(normalize(lang, prev.text)) && indentOf(prev.text) < indent;
        if (guarded && prev) indent = indentOf(prev.text);
        let shadowed = false;
        for (let j = i + 1; j < Math.min(hunk.lines.length, i + 24); j++) {
          const next = hunk.lines[j];
          if (next.kind === "-") continue;
          const t = normalize(lang, next.text);
          if (t.trim() === "") continue;
          if (guarded && /^\s*\}\s*$/.test(t) && indentOf(next.text) === indent) continue;
          if (indentOf(next.text) < indent || lang !== "py" && /^\s*\}/.test(t) && indentOf(next.text) <= indent) break;
          if (assertRe && count(assertRe, t) > 0) {
            shadowed = true;
            break;
          }
        }
        if (shadowed) {
          const what = /\bAssert\.Pass\b/.test(code) ? "Assert.Pass() added before the assertions; the test ends there as a success" : `return added before the assertions${guarded ? " (behind a condition)" : ""}; the rest of the test never runs`;
          add(ctx, "early-return-added", "high", line, what, line.text, sup);
        }
      }
      for (const d of DOWNGRADES) {
        if (d.lang ? d.lang !== lang : isAttrLang(lang)) continue;
        if (!d.to.test(code)) continue;
        if (d.attr && isAttrLang(lang)) {
          const sig = declSignature(lang, hunk.lines, i, "+");
          const strongIdx = sig === null ? -1 : hunk.lines.findIndex((r, ri) => r.kind === "-" && d.from.test(normalize(lang, r.text)) && declSignature(lang, hunk.lines, ri, "-") === sig);
          if (strongIdx < 0) continue;
          if (hunk.lines.some((a, ai) => a.kind === "+" && a !== line && d.from.test(normalize(lang, a.text)) && declSignature(lang, hunk.lines, ai, "+") === sig)) continue;
          add(ctx, "assertion-weakened", "medium", line, `assertion weakened: ${d.what}`, `- ${hunk.lines[strongIdx].text.trim()}
+ ${line.text.trim()}`, sup);
          continue;
        }
        const rawSubject = (t) => subjectsOf(lang, stripComment(lang, t));
        const subj = rawSubject(line.text);
        const strong = removed.find((r) => d.from.test(normalize(lang, r.text)) && intersects(rawSubject(r.text), subj));
        if (!strong) continue;
        if (d.from.test(normalize(lang, line.text))) continue;
        if (added.some((a) => a !== line && d.from.test(normalize(lang, a.text)) && intersects(rawSubject(a.text), subj))) continue;
        if (d.existence) {
          const roots = subj.map((s) => subjectRoot(lang, s));
          const stronger = added.filter((a) => STRONG_MATCHER[lang].test(normalize(lang, a.text)) && intersects(rawSubject(a.text).map((s) => subjectRoot(lang, s)), roots));
          if (stronger.length > 0) continue;
        }
        add(ctx, "assertion-weakened", "medium", line, `assertion weakened: ${d.what}`, `- ${strong.text.trim()}
+ ${line.text.trim()}`, sup);
      }
      const closeTo = /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(code);
      if (closeTo) {
        const prev = removed.map((r) => /\.toBeCloseTo\s*\([^,)]+,\s*(\d+)\s*\)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(closeTo[1]) < Number(prev[1])) add(ctx, "tolerance-widened", toleranceSeverity("digits", Number(prev[1]), Number(closeTo[1])), line, `toBeCloseTo precision lowered ${prev[1]} -> ${closeTo[1]}`, line.text, sup);
      }
      const approx = /pytest\.approx\s*\(.*?(?:rel|abs)\s*=\s*([\d.eE+-]+)/.exec(code);
      if (approx) {
        const prev = removed.map((r) => /pytest\.approx\s*\(.*?(?:rel|abs)\s*=\s*([\d.eE+-]+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(approx[1]) > Number(prev[1])) add(ctx, "tolerance-widened", toleranceSeverity("factor", Number(prev[1]), Number(approx[1])), line, `pytest.approx tolerance widened ${prev[1]} -> ${approx[1]}`, line.text, sup);
      }
      const places = /assertAlmostEqual\s*\(.*?places\s*=\s*(\d+)/.exec(code);
      if (places) {
        const prev = removed.map((r) => /assertAlmostEqual\s*\(.*?places\s*=\s*(\d+)/.exec(normalize(lang, r.text))).find(Boolean);
        if (prev && Number(places[1]) < Number(prev[1])) add(ctx, "tolerance-widened", toleranceSeverity("digits", Number(prev[1]), Number(places[1])), line, `assertAlmostEqual places lowered ${prev[1]} -> ${places[1]}`, line.text, sup);
      }
      if (isAttrLang(lang)) {
        for (const t of TOLERANCES) {
          if (t.lang !== lang) continue;
          const now = toleranceOf(t, code);
          if (now === null) continue;
          const prev = removed.map((r) => toleranceOf(t, normalize(lang, r.text))).find((v) => v !== null);
          if (prev === null || prev === void 0) continue;
          if (t.kind === "digits" ? now < prev : now > prev) add(ctx, "tolerance-widened", toleranceSeverity(t.kind, prev, now), line, `${t.what} ${prev} -> ${now}`, line.text, sup);
        }
      }
      if ((lang === "js" || lang === "java" || lang === "csharp") && /\bcatch\b/.test(code)) {
        const body = hunk.lines.slice(i + 1, i + 4).filter((l) => l.kind === "+").map((l) => normalize(lang, l.text).trim());
        const allman = lang !== "js" && body[0] === "{" && body[1] === "}";
        if (/\bcatch\b[^{]*\{\s*\}\s*$/.test(code) || body.length > 0 && body[0] === "}" || allman) {
          const assertion = lang === "java" ? /\bcatch\s*\(\s*(?:final\s+)?(?:AssertionError|AssertionFailedError|Throwable|Error)\b/.test(code) : lang === "csharp" ? /\bcatch\s*\(\s*(?:XunitException|AssertionException|AssertFailedException|Exception)\b/.test(code) : false;
          if (assertion) add(ctx, "error-swallowed", "high", line, "empty catch of the assertion exception: a failing assertion is discarded and the test passes", line.text, sup);
          else add(ctx, "error-swallowed", "medium", line, "empty catch block added in a test", line.text, sup);
        }
      }
      if (lang === "py" && /^\s*except\b[^:]*:\s*(?:pass|\.\.\.)?\s*$/.test(code)) {
        const next = hunk.lines.slice(i + 1, i + 3).filter((l) => l.kind === "+").map((l) => normalize("py", l.text).trim())[0];
        if (/^\s*except\b[^:]*:\s*(?:pass|\.\.\.)\s*$/.test(code) || next === "pass" || next === "...") add(ctx, "error-swallowed", "medium", line, "except ... pass added in a test", line.text, sup);
      }
      if (lang === "go" && /\bdefer\s+func\s*\(\s*\)\s*\{[^}]*\brecover\s*\(\s*\)/.test(code)) add(ctx, "error-swallowed", "medium", line, "recover() added in a test; panics are hidden", line.text, sup);
      if (lang === "rust") {
        if (/^\s*let\s+_\s*=\s*(?:std::)?panic::catch_unwind\s*\(|^\s*(?:std::)?panic::catch_unwind\s*\(.*\)\s*;\s*$/.test(code)) add(ctx, "error-swallowed", "high", line, "catch_unwind with the result discarded: a panic (a failed assertion) no longer fails the test", line.text, sup);
        else if (/\b(?:Err\(\s*_?\w*\s*\)|None)\s*=>\s*(?:\{\s*\}|\(\))\s*,?\s*$/.test(code)) add(ctx, "error-swallowed", "medium", line, "Err/None match arm that does nothing: that path passes silently", line.text, sup);
      }
    }
  }
  if (file.status === "added") return;
  if (lang === "rust") {
    const isGate = (t) => /^\s*#\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*$/.test(t);
    let spare = allLines.filter((l) => l.kind === "+" && isGate(normalize(lang, l.text))).length;
    for (const hunk of file.hunks) {
      const replacements = hunk.lines.filter((l) => l.kind === "+" && /^\s*#\[\s*cfg\s*\(/.test(normalize(lang, l.text)) && !isGate(normalize(lang, l.text)));
      for (let i = 0; i < hunk.lines.length; i++) {
        const l = hunk.lines[i];
        if (l.kind !== "-" || !isGate(normalize(lang, l.text))) continue;
        if (spare > 0) {
          spare--;
          continue;
        }
        const near = hunk.lines.slice(i + 1, i + 6).find((a) => replacements.includes(a));
        const repl = near ?? replacements.find((a) => /\btest\b|any\(\s*\)|\bfalse\b/.test(normalize(lang, a.text)));
        if (!repl) continue;
        replacements.splice(replacements.indexOf(repl), 1);
        const pred = (/#\[\s*cfg\s*\((.*)\)\s*\]/.exec(normalize(lang, repl.text))?.[1] ?? "").trim();
        const severity = RUST_NEVER_TRUE.test(pred) ? "critical" : "high";
        add(ctx, "skip-added", severity, repl, `test module gate changed: #[cfg(test)] -> ${repl.text.trim()}; a plain cargo test no longer compiles these tests`, `- ${l.text.trim()}
+ ${repl.text.trim()}`, suppression(hunk.lines, hunk.lines.indexOf(repl)));
      }
    }
    for (const l of allLines) {
      if (l.kind !== "-") continue;
      const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(tests?|test_\w+|\w+_tests?)\s*;/.exec(normalize(lang, l.text));
      if (!m) continue;
      const name = m[1];
      if (allLines.some((a) => a.kind === "+" && new RegExp(`\\bmod\\s+${name}\\b`).test(normalize(lang, a.text)))) continue;
      add(ctx, "skip-added", "high", l, `\`mod ${name};\` removed: the test module is no longer compiled or run`, l.text, null);
    }
  }
  const ROW = lang === "go" ? /^\s*\{.*\},?\s*$/ : lang === "py" ? /^\s*\(.*\),?\s*$/ : lang === "rust" ? /^\s*(?:\(.*\)|\[.*\]|\w+\s*\{.*\}|#\[\s*(?:case|test_case)\b.*)\s*,?\s*$/ : lang === "java" ? /^\s*(?:"(?:[^"\\]|\\.)*"|Arguments\.of\s*\(.*\)|arguments\s*\(.*\)|\{.*\})\s*,?\s*$/ : lang === "csharp" ? /^\s*(?:\[\s*(?:InlineData|TestCase|DataRow)\b.*\]|new\s+object\[\]\s*\{.*\}|yield\s+return\s+.*)\s*,?;?\s*$/ : /^\s*\[.*\],?\s*$/;
  const rowKey = (t) => stripComment(lang, t).replace(/\s+/g, "").replace(/,$/, "");
  const removedRows = allRemoved.map((l) => l.text).filter((t) => ROW.test(stripComment(lang, t)) && /["'`]|\d/.test(t));
  const addedRowKeys = new Set(allAdded.map((l) => l.text).filter((t) => ROW.test(stripComment(lang, t))).map(rowKey));
  const droppedRows = removedRows.filter((t) => !addedRowKeys.has(rowKey(t)));
  if (droppedRows.length > 0 && droppedRows.length > allAdded.filter((l) => ROW.test(stripComment(lang, l.text))).length - (removedRows.length - droppedRows.length)) {
    const first = allRemoved.find((l) => l.text === droppedRows[0]);
    add(ctx, "test-case-removed", "medium", first ?? null, `${droppedRows.length} row${droppedRows.length === 1 ? "" : "s"} removed from a table-driven test`, droppedRows.slice(0, 2).map((t) => t.trim()).join("\n"), first ? suppression(allLines, allLines.indexOf(first)) : null);
  }
  const removedDecls = declarationLines(lang, allLines, "-", inRegion);
  let moved = 0;
  for (const d of removedDecls) if (takeMoved(cross, file.path, d)) moved++;
  const tableRefactor = (LOOP_ONLY.test(addedText) || after.unknownEach) && count(lang === "other" ? /$^/ : COUNTERS[lang].assertion, addedText) > 0;
  const dropped = before.tests - after.tests - moved;
  if (dropped > 0) {
    if (tableRefactor) add(ctx, "tests-removed", "low", null, `test count dropped ${before.tests} -> ${after.tests} alongside a loop/table refactor (rows not verifiable)`, `${file.path}: ${dropped} fewer test declaration${dropped === 1 ? "" : "s"}`, null);
    else add(ctx, "tests-removed", dropped >= 2 ? "high" : "medium", null, `test count dropped ${before.tests} -> ${after.tests}${moved ? ` (${moved} moved to another file)` : ""}`, `${file.path}: ${dropped} test${dropped === 1 ? "" : "s"} removed`, null);
  } else if (moved > 0) {
    add(ctx, "tests-moved", "low", null, `${moved} test${moved === 1 ? "" : "s"} moved to another file`, file.path, null);
  }
  let lost = before.assertions - after.assertions;
  if (lost > 0 && before.tests > 0 && after.tests >= before.tests) {
    if (/\basync\b/.test(addedText)) {
      const guards = allRemoved.filter((r) => /\bexpect\s*\(\s*(?:err|error|e)\s*\)\s*\.(?:toBeNull|toBeFalsy|toBeUndefined)\s*\(/.test(normalize(lang, r.text))).length;
      lost -= guards;
    }
    const helper = /^\s*(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|func\s+([A-Za-z_]\w*)\s*\(|def\s+([A-Za-z_]\w*)\s*\()/;
    const testRe = lang === "other" ? null : new RegExp(COUNTERS[lang].test.source, COUNTERS[lang].test.flags.replace("g", ""));
    let helperCalls = 0;
    for (let k = 0; k < addedNorm.length; k++) {
      const m = isAttrLang(lang) ? HELPER_DECL[lang].exec(addedNorm[k]) : helper.exec(addedNorm[k]);
      const name = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (!name || /^(?:test|it|describe)$/i.test(name) || KEYWORD_NAME.test(name) || !assertRe) continue;
      if (isAttrLang(lang) && testRe) {
        let p = k - 1;
        while (p >= 0 && addedNorm[p].trim() === "") p--;
        if (p >= 0 && testRe.test(addedNorm[p].trim())) continue;
      }
      const body = addedNorm.slice(k + 1, k + 40).join("\n");
      if (count(assertRe, body) === 0) continue;
      const calls = count(new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(`, "g"), afterText ? normalizeFile(lang, afterText) : "") - 1;
      if (calls >= 2) helperCalls += calls;
    }
    if (lost > 0) {
      if (tableRefactor) {
        add(ctx, "assertions-removed", "low", null, `assertion count dropped ${before.assertions} -> ${after.assertions} alongside a loop/table refactor`, `${file.path}: ${lost} fewer assertion${lost === 1 ? "" : "s"} in the text`, null);
      } else if (helperCalls > 0) {
        add(ctx, "assertions-removed", "low", null, `assertion count dropped ${before.assertions} -> ${after.assertions}; assertions appear to have moved into a helper called ${helperCalls + 1} times`, `${file.path}: ${lost} fewer assertion${lost === 1 ? "" : "s"} in the text`, null);
      } else {
        const sev = lost >= 3 || lost >= 2 && lost / Math.max(1, before.assertions) > 0.3 ? "high" : "medium";
        add(ctx, "assertions-removed", sev, null, `assertion count dropped ${before.assertions} -> ${after.assertions} with no test removed`, `${file.path}: ${lost} assertion${lost === 1 ? "" : "s"} removed`, null);
      }
    }
  }
}
var TEST_ONLY = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|e2e)\b|\b(?:npx\s+)?(?:vitest|jest|mocha|ava|tap|node\s+--test|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+(?:test|nextest|llvm-cov|miri\s+test)|dotnet\s+test|vstest\.console|make\s+(?:test|tests|check)|tox|nox|rspec|phpunit)\b|\bmvnw?\b(?![^\n]*(?:-DskipTests\b(?!=false)|-Dmaven\.test\.skip=true))[^\n]*\b(?:test|verify|integration-test|install|package|deploy)\b|\bgradlew?\b(?![^\n]*(?:-x\s+(?:test|check)\b|--exclude-task\s+(?:test|check)\b))[^\n]*\b(?:test|check|build|integrationTest|allTests|jvmTest|testDebugUnitTest|connectedAndroidTest)\b/;
var TEST_SCRIPT_KEY = /"(?:test|tests|test:\w+|pretest|posttest|ci|check|verify|e2e)"\s*:/;
var BENIGN_IGNORE = /^\s*['"`]?(?:\*\*\/)?\/?(?:node_modules|dist|build|coverage|\.next|\.nuxt|out|lib|\.git|\.cache|vendor|target|bin|obj|\.gradle|\.idea|__pycache__|\.venv|venv)(?:\/\*\*)?\/?\**['"`]?\s*$/;
var BENIGN_JVM_EXCLUDE = /^\s*['"]?\*\*\/(?:\*IT\.java|IT\*\.java|\*ITCase\.java|\*IT\*|Abstract\*(?:\.java|\.class)?|\*\$\*(?:\.java|\.class)?)['"]?\s*$/;
var BENIGN_PLUGINS = /-p\s+no:(?:cacheprovider|warnings|randomly|cov|faulthandler|logging|xdist)\b/;
var MAVEN_SKIP = /-DskipTests\b(?!=false)|-Dmaven\.test\.skip=true|-DskipITs\b/;
var GRADLE_EXCLUDE = /\bgradlew?\b[^\n]*\s(?:-x|--exclude-task)\s+(?:test|check)\b/;
var GRADLE_FILE = /(?:build|settings)\.gradle(?:\.kts)?$|gradle\.properties$/;
var DOTNET_PROJ = /\.(?:cs|fs|vb)proj$|Directory\.Build\.(?:props|targets)$/;
var CONFIG_SABOTAGE = [
  { re: /testPathIgnorePatterns|testIgnore|ignorePatterns\s*[:=]|modulePathIgnorePatterns/, severity: "critical", message: "test ignore pattern added", id: "ignore" },
  { re: /\b(?:testMatch|testRegex|include|spec)\s*[:=]/, severity: "high", message: "test file selection narrowed or changed", only: /(?:jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config|\.mocharc|jest\.config\.json/, id: "selection" },
  { re: /\b(?:exclude|ignore)\s*[:=]\s*\[/, severity: "high", message: "test exclude list changed", only: /(?:vitest|vite|playwright)\.config|\.mocharc/, id: "ignore" },
  { re: /--passWithNoTests|passWithNoTests\s*[:=]\s*true/, severity: "critical", message: "passWithNoTests: a suite with zero tests is reported green" },
  { re: /--testPathPattern[=\s]|--testNamePattern[=\s]|\s-t\s+\\?["']|\s--grep[=\s]|\s-g\s+\\?["']|go\s+test\b.*(?:\s-run\s+\S+|\s-short\b)|\bpytest\b.*\s-k\s+\\?["']?(?!not\b)\w/, severity: "high", message: "test selection narrowed on the command line" },
  { re: /\|\|\s*true\b|\|\|\s*exit\s+0\b|;\s*true\s*["']?\s*,?\s*$|;\s*exit\s+0\s*["']?\s*,?\s*$/, severity: "critical", message: "exit status forced to success", id: "exit" },
  { re: /continue-on-error\s*:\s*(?:true|\$\{\{[^}]*\}\})/, severity: "critical", message: "CI step failures ignored (continue-on-error)", id: "coe" },
  { re: /^\s*if\s*:\s*(?:['"]?false['"]?|\$\{\{\s*false\s*\}\})\s*(?:#.*)?$/, severity: "critical", message: "CI step disabled with if: false" },
  { re: /--no-verify\b|--no-gpg-sign\b/, severity: "high", message: "git hooks bypassed (--no-verify)" },
  { re: /\bpytest\b.*(?:-p\s+no:|--ignore[=\s]|--deselect[=\s]|-k\s+["']?not\b)|addopts\s*=.*(?:-p\s+no:|--ignore|--deselect|-k\s+["']?not\b)/, severity: "high", message: "pytest collection narrowed (ignore/deselect/-k not/-p no:)", id: "pytest" },
  { re: /\b(?:norecursedirs|python_files|testpaths)\s*=/, severity: "medium", message: "pytest discovery configuration changed" },
  { re: /"test"\s*:\s*"(?:echo\b|true\b|exit 0\b|:\s*")/, severity: "critical", message: "test script neutered" },
  { re: /--updateSnapshot\b|\s-u\b.*(?:jest|vitest)|(?:jest|vitest).*\s-u\b|\bupdateSnapshot\s*[:=]\s*true|SNAPSHOT_UPDATE|--update-snapshots\b/, severity: "medium", message: "snapshots updated automatically" },
  { re: /\bskipLibCheck\b|\bnoEmitOnError\s*:\s*false/, severity: "low", message: "type checking relaxed" },
  { re: /\btimeout\s*[:=]\s*\d{6,}/, severity: "low", message: "very large timeout added" },
  // Cargo.toml (verified: https://doc.rust-lang.org/cargo/reference/cargo-targets.html, /reference/profiles.html)
  { re: /^\s*test\s*=\s*false\b/, severity: "high", message: "target excluded from cargo test (test = false)", only: /Cargo\.toml$/ },
  { re: /^\s*autotests\s*=\s*false\b/, severity: "high", message: "tests/ discovery disabled (autotests = false)", only: /Cargo\.toml$/ },
  { re: /^\s*harness\s*=\s*false\b/, severity: "medium", message: "custom test harness: libtest no longer runs #[test] fns for this target", only: /Cargo\.toml$/ },
  { re: /^\s*doctest\s*=\s*false\b/, severity: "low", message: "doctests disabled", only: /Cargo\.toml$/ },
  { re: /^\s*required-features\s*=/, severity: "medium", message: "target skipped unless the feature is enabled (required-features)", only: /Cargo\.toml$/ },
  { re: /^\s*(?:debug-assertions|overflow-checks)\s*=\s*false\b/, severity: "medium", message: "debug_assert!/overflow panics disabled for tests (the test profile inherits dev)", only: /Cargo\.toml$/ },
  { re: /^\s*(?:exclude|default-members)\s*=\s*\[/, severity: "medium", message: "workspace members excluded from cargo test --workspace", only: /Cargo\.toml$/ },
  // .cargo/config.toml (verified: https://doc.rust-lang.org/cargo/reference/config.html: test binaries are executed by the runner)
  { re: /^\s*runner\s*=\s*["'](?:true|:|echo|\/bin\/true)\b/, severity: "critical", message: 'test runner replaced by a no-op: every test binary "passes" without running', only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*runner\s*=/, severity: "low", message: "cargo test runner changed", only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*\w+\s*=\s*["'[].*\btest\b.*(?:--skip|--ignored|--exact|--no-run)/, severity: "medium", message: "cargo alias narrows or skips tests", only: /\.cargo\/config(?:\.toml)?$/ },
  { re: /^\s*rustflags\s*=.*--cfg\b/, severity: "low", message: "rustflags --cfg changed", only: /\.cargo\/config(?:\.toml)?$/ },
  // nextest (verified: https://nexte.st/docs/running/, /docs/configuration/)
  { re: /^\s*default-filter\s*=/, severity: "high", message: "nextest default-filter restricts which tests run by default", only: /nextest\.toml$/ },
  { re: /^\s*retries\s*=\s*[1-9]/, severity: "medium", message: "nextest retries: flaky tests pass on retry", only: /nextest\.toml$/ },
  // pom.xml (verified: surefire skipping-tests, inclusion-exclusion, test-mojo, rerun-failing-tests pages)
  { re: /<(?:skipTests|maven\.test\.skip|skipITs)>\s*true\s*</, severity: "critical", message: "Maven tests skipped (skipTests/maven.test.skip/skipITs)", only: /pom\.xml$/ },
  { re: /<(?:testFailureIgnore|maven\.test\.failure\.ignore)>\s*true\s*</, severity: "critical", message: "Maven test failures ignored (testFailureIgnore): the build is green with failing tests", only: /pom\.xml$/ },
  { re: /<skip>\s*true\s*</, severity: "medium", message: "a Maven plugin execution is skipped (<skip>true</skip>)", only: /pom\.xml$/ },
  { re: /<exclude>/, severity: "high", message: "Surefire/Failsafe exclude added", only: /pom\.xml$/, id: "xml-exclude" },
  { re: /<include>/, severity: "medium", message: "Surefire/Failsafe include list changed: only matching classes run", only: /pom\.xml$/ },
  { re: /<test>[^<]/, severity: "high", message: "Surefire <test> runs a single test", only: /pom\.xml$/ },
  { re: /<(?:excludedGroups|groups)>/, severity: "medium", message: "test groups filtered", only: /pom\.xml$/ },
  { re: /<rerunFailingTestsCount>\s*[1-9]/, severity: "medium", message: "failing tests re-run: flakes are reported green", only: /pom\.xml$/ },
  { re: /<failIfNoSpecifiedTests>\s*false|<testSourceDirectory>/, severity: "medium", message: "Surefire discovery configuration changed", only: /pom\.xml$/ },
  { re: /<exclude\s+name\s*=/, severity: "high", message: "TestNG exclude added", only: /testng\.xml$/ },
  // Maven command lines (CI, Makefile, .mvn/maven.config: one option per line; verified: https://maven.apache.org/configure.html)
  { re: /-Dmaven\.test\.failure\.ignore=true\b/, severity: "critical", message: "Maven test failures ignored on the command line" },
  { re: MAVEN_SKIP, severity: "high", message: "Maven tests skipped on the command line (-DskipTests/-Dmaven.test.skip)", id: "mvn-skip" },
  { re: /-D(?:it\.)?test=|-Dsurefire\.excludes=|-DexcludedGroups=/, severity: "high", message: "Maven test selection narrowed on the command line" },
  { re: /-Dgroups=|-DfailIfNoTests=false|-Dsurefire\.failIfNoSpecifiedTests=false|-Dsurefire\.rerunFailingTestsCount=[1-9]/, severity: "medium", message: "Maven test filtering/retry option added" },
  // Gradle (verified: Test DSL, controlling_task_execution, java_testing, test-retry plugin README)
  { re: /\bignoreFailures\s*(?:=|\s)\s*true\b/, severity: "critical", message: "Gradle ignoreFailures: the build passes when tests fail", only: GRADLE_FILE },
  { re: /\bcheck\.dependsOn\.remove\s*\(|tasks\.named\(\s*["']test["']\s*\)\s*\{\s*enabled\s*=\s*false|\btest\.enabled\s*=\s*false/, severity: "critical", message: "Gradle test task disabled", only: GRADLE_FILE },
  { re: /\benabled\s*=\s*false\b/, severity: "high", message: "the Gradle test task is disabled (SKIPPED)", only: GRADLE_FILE, id: "gradle-enabled" },
  { re: /\bonlyIf\s*[({]/, severity: "high", message: "Gradle onlyIf predicate: the task is SKIPPED when it is false", only: GRADLE_FILE },
  { re: /\bexcludeTestsMatching\s*\(|\bsetExcludes\s*\(|\bexclude\s*[("']\s*["']?[^"'\n]*(?:\*\*\/|\*\.class|\*\.java|\*\.kt|Test|Spec|IT)\b/, severity: "high", message: "Gradle test exclude added", only: GRADLE_FILE, id: "ignore" },
  { re: /\bincludeTestsMatching\s*\(|\bsetIncludes\s*\(/, severity: "medium", message: "Gradle test include filter narrows what runs", only: GRADLE_FILE },
  { re: /\bexclude(?:Tags|Groups|Engines|Categories)\s*\(/, severity: "medium", message: "Gradle test tags/groups excluded", only: GRADLE_FILE },
  { re: /\bfailOnNoMatchingTests\s*=\s*false|\bscanForTestClasses\s*=\s*false/, severity: "medium", message: "Gradle test discovery relaxed", only: GRADLE_FILE },
  { re: /\bretry\s*\{|\bmaxRetries\s*(?:=|\.set\()\s*[1-9]/, severity: "medium", message: "Gradle test-retry: failed tests passing on retry do not fail the task", only: GRADLE_FILE },
  { re: GRADLE_EXCLUDE, severity: "high", message: "Gradle test task excluded on the command line (-x test)", id: "gradle-x" },
  { re: /\bgradlew?\b[^\n]*(?:\s--tests[=\s]|-Dtest\.single=)/, severity: "high", message: "Gradle test selection narrowed on the command line (--tests)" },
  // .NET project files (verified: Microsoft.NET.Test.Sdk.props sets IsTestProject=true; dotnet test runs every test project)
  { re: /<IsTestProject>\s*false\s*</i, severity: "critical", message: "IsTestProject=false: the project is no longer run by dotnet test", only: DOTNET_PROJ },
  { re: /<Compile\s+Remove\s*=\s*"[^"]*(?:[Tt]est|[Ss]pec)/, severity: "critical", message: "test sources removed from compilation (<Compile Remove>)", only: DOTNET_PROJ },
  { re: /<VSTestTestCaseFilter>/, severity: "high", message: "VSTestTestCaseFilter: only matching tests run", only: DOTNET_PROJ },
  { re: /<TestingPlatformCommandLineArguments>[^<]*(?:--filter|--ignore-exit-code|--minimum-expected-tests\s+0)/, severity: "high", message: "testing platform arguments filter tests or ignore failures", only: DOTNET_PROJ },
  { re: /<IsTestingPlatformApplication>\s*false/i, severity: "medium", message: "IsTestingPlatformApplication=false", only: DOTNET_PROJ },
  { re: /<RunSettingsFilePath>/, severity: "low", message: "run settings file changed", only: DOTNET_PROJ },
  // .runsettings (verified: https://learn.microsoft.com/en-us/visualstudio/test/configure-unit-tests-by-using-a-dot-runsettings-file)
  { re: /<TestCaseFilter>/, severity: "high", message: "runsettings TestCaseFilter: only matching tests run", only: /\.runsettings$/ },
  { re: /<TreatNoTestsAsError>\s*false|<MapNotRunnableToFailed>\s*false/i, severity: "medium", message: "runsettings: zero or not-runnable tests no longer fail the run", only: /\.runsettings$/ },
  { re: /<MapInconclusiveToFailed>\s*false/i, severity: "low", message: "runsettings: inconclusive tests no longer fail the run", only: /\.runsettings$/ },
  // xunit.runner.json (verified: https://xunit.net/docs/config-xunit-runner-json; unverified: the v3 `explicit` key)
  { re: /"failSkips"\s*:\s*false/, severity: "medium", message: "xunit failSkips=false: skipped tests no longer fail the run", only: /xunit\.runner\.json$/ },
  { re: /"explicit"\s*:\s*"only"/, severity: "high", message: "xunit explicit=only: only explicit tests run", only: /xunit\.runner\.json$/ },
  { re: /"failWarns"\s*:\s*false/, severity: "low", message: "xunit failWarns=false", only: /xunit\.runner\.json$/ },
  // dotnet test command lines (verified: dotnet-test, selective-unit-tests, microsoft-testing-platform-troubleshooting pages)
  { re: /--ignore-exit-code\s+\S*\b(?:2|8)\b|TESTINGPLATFORM_EXITCODE_IGNORE/, severity: "critical", message: "test failure exit codes ignored (--ignore-exit-code)" },
  { re: /\bdotnet\s+test\b[^\n]*(?:\s-t\b|--list-tests\b)/, severity: "critical", message: "dotnet test --list-tests lists tests instead of running them" },
  { re: /-p:IsTestProject=false\b/, severity: "critical", message: "IsTestProject=false on the command line" },
  { re: /\bdotnet\s+test\b[^\n]*(?:--filter(?:-[\w-]+)?[=\s]|--treenode-filter\b)|-p:VSTestTestCaseFilter=/, severity: "high", message: "dotnet test selection narrowed (--filter)" },
  { re: /RunConfiguration\.TreatNoTestsAsError=false|MapInconclusiveToFailed=[Ff]alse|--minimum-expected-tests\s+0\b/, severity: "medium", message: "dotnet test failure mapping relaxed" },
  // cargo command lines (verified: cargo-test, rustc tests CLI, nextest filtersets pages)
  { re: /\bcargo\s+test\b[^\n]*--no-run\b/, severity: "critical", message: "cargo test --no-run compiles but does not run the tests", id: "cargo-no-run" },
  { re: /\bcargo\s+test\b[^\n]*\s--\s[^\n]*(?:--skip[=\s]|--exact\b|--ignored\b(?!-))|\bcargo\s+nextest\s+run\b[^\n]*(?:--skip[=\s]|\s-E\s|--filterset\b|--run-ignored\s+only\b)/, severity: "high", message: "cargo test selection narrowed on the command line (--skip/--exact/--ignored/-E)" },
  { re: /\bcargo\s+(?:test|nextest\s+run)\b[^\n]*--exclude\b/, severity: "high", message: "cargo test --exclude: a package is no longer tested" },
  { re: /\bcargo\s+test\s+(?!-)[A-Za-z_][\w:]*\b/, severity: "medium", message: "cargo test <filter>: only tests whose name contains the filter run" }
];
var TEST_RUNNER_DECL = /\buseJUnitPlatform\s*\(|\buseTestNG\s*\(|\buseJUnit\s*\(|Include\s*=\s*"(?:Microsoft\.NET\.Test\.Sdk|Microsoft\.Testing\.Platform|MSTest\.Sdk|xunit\.v3|xunit\.runner\.visualstudio|NUnit3TestAdapter|MSTest\.TestAdapter)"/;
function quoted(text) {
  return [...text.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
}
function scanConfigFile(ctx, movedPair) {
  const { file } = ctx;
  const p = file.path.replace(/\\/g, "/");
  const isWorkflow = /(^|\/)\.github\/workflows\//.test(p);
  const isJson = p.endsWith(".json");
  const isMakefile = /(^|\/)makefile$/i.test(p);
  const isGradle = GRADLE_FILE.test(p);
  const isProj = DOTNET_PROJ.test(p);
  if (file.status === "deleted") {
    if (isWorkflow && !movedPair) add(ctx, "ci-workflow-deleted", "high", null, "CI workflow deleted", file.path, null);
    return;
  }
  const fileAdded = file.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "+").map((l) => l.text)).join("\n");
  const fileAfter = file.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== "-").map((l) => l.text).join("\n");
  for (const hunk of file.hunks) {
    const addedLines = hunk.lines.filter((l) => l.kind === "+");
    const addedText = addedLines.map((l) => l.text).join("\n");
    const removedLines = hunk.lines.filter((l) => l.kind === "-");
    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i];
      if (line.kind === "-") {
        if (TEST_ONLY.test(line.text) && !TEST_ONLY.test(addedText) && !(isJson && !TEST_SCRIPT_KEY.test(line.text) && /"(?:lint|build|start|dev|prepare|format)"\s*:/.test(line.text))) {
          add(ctx, "test-step-removed", "high", line, "a test command was removed from configuration", line.text, null);
        }
        if ((isGradle || isProj) && TEST_RUNNER_DECL.test(line.text) && !TEST_RUNNER_DECL.test(fileAdded)) {
          add(ctx, "test-step-removed", "high", line, isGradle ? "test framework registration removed (useJUnitPlatform/useTestNG): the test task discovers nothing" : "test SDK/adapter package removed: dotnet test no longer runs this project", line.text, null);
        }
        continue;
      }
      if (line.kind !== "+") continue;
      const text = line.text;
      if (!isJson && /^\s*#/.test(text)) continue;
      if (/^\s*\/\//.test(text) || /^\s*<!--/.test(text)) continue;
      if (!isJson && /^\s*-?\s*(?:name|description)\s*:\s/.test(text)) continue;
      const sup = suppression(hunk.lines, i);
      for (const rule of CONFIG_SABOTAGE) {
        if (rule.only && !rule.only.test(p)) continue;
        if (!rule.re.test(text)) continue;
        let severity = rule.severity;
        let message = rule.message;
        if (rule.id === "exit") {
          const testish = TEST_ONLY.test(text) || isJson && TEST_SCRIPT_KEY.test(text) || isMakefile && TEST_ONLY.test(hunk.lines.slice(Math.max(0, i - 3), i).map((l) => l.text).join("\n"));
          if (!testish) continue;
        }
        if (rule.id === "coe") {
          let start = i;
          while (start > 0 && !/^\s*-\s+(?:name|run|uses)\s*:/.test(hunk.lines[start].text)) start--;
          let end = i + 1;
          while (end < hunk.lines.length && !/^\s*-\s+(?:name|run|uses)\s*:/.test(hunk.lines[end].text)) end++;
          const step = hunk.lines.slice(start, end).filter((l) => l.kind !== "-").map((l) => l.text).join("\n");
          if (!TEST_ONLY.test(step)) {
            severity = "low";
            message = "continue-on-error added to a CI step that does not run tests";
          }
        }
        if (rule.id === "ignore") {
          let entries = quoted(text);
          if (entries.length === 0 && /[\[(]\s*$/.test(text)) {
            for (let j = i + 1; j < Math.min(hunk.lines.length, i + 24); j++) {
              const l = hunk.lines[j];
              if (l.kind === "-") continue;
              entries = entries.concat(quoted(l.text));
              if (/[\])]/.test(l.text)) break;
            }
          }
          if (entries.length > 0 && entries.every((e) => BENIGN_IGNORE.test(e) || BENIGN_JVM_EXCLUDE.test(e))) continue;
        }
        if (rule.id === "xml-exclude") {
          const entries = [...text.matchAll(/<exclude>([^<]*)<\/exclude>/g)].map((m) => m[1]);
          if (entries.length > 0 && entries.every((e) => BENIGN_JVM_EXCLUDE.test(e))) continue;
          const plugin = enclosingArtifact(fileAfter, text);
          if (plugin !== null && !/surefire|failsafe/i.test(plugin)) {
            severity = "low";
            message = `${message} (inside ${plugin}, not a test plugin)`;
          }
        }
        if (rule.id === "mvn-skip" || rule.id === "gradle-x" || rule.id === "cargo-no-run") {
          const stillRuns = rule.id === "mvn-skip" ? new RegExp(`\\bmvnw?\\b(?![^\\n]*(?:${MAVEN_SKIP.source}))[^\\n]*\\b(?:test|verify|integration-test)\\b`).test(fileAdded) : rule.id === "gradle-x" ? new RegExp(`\\bgradlew?\\b(?![^\\n]*\\s(?:-x|--exclude-task)\\s+(?:test|check)\\b)[^\\n]*\\b(?:test|check|build)\\b`).test(fileAdded) : /\bcargo\s+(?:test|nextest\s+run|llvm-cov)\b(?![^\n]*--no-run\b)/.test(fileAfter);
          if (stillRuns) {
            severity = "low";
            message = `${message}; another step still runs the tests`;
          }
        }
        if (rule.id === "gradle-enabled") {
          let task = null;
          for (let j = i - 1; j >= Math.max(0, i - 6) && task === null; j--) {
            const l = hunk.lines[j];
            if (l.kind === "-") continue;
            const m = /tasks\.named\s*(?:<[^>]*>)?\s*\(\s*["'](\w+)["']|tasks\.(\w+)\s*\{|^\s*(\w+)\s*\{/.exec(l.text);
            if (m) task = m[1] ?? m[2] ?? m[3] ?? null;
          }
          if (task !== null && !/test|check|verif/i.test(task)) {
            severity = "low";
            message = `Gradle task ${task} disabled (not a test task)`;
          }
        }
        if (rule.id === "selection") {
          const key = /\b(testMatch|testRegex|include|spec)\s*[:=]/.exec(text)?.[1];
          const prev = removedLines.find((r) => key && new RegExp(`\\b${key}\\s*[:=]`).test(r.text));
          const oldPatterns = prev ? quoted(prev.text) : [];
          const newPatterns = quoted(text);
          if (oldPatterns.length > 0 && oldPatterns.every((o) => newPatterns.includes(o))) continue;
          if (!prev && newPatterns.every((n) => /\*\*\/\*\.(?:\{[^}]*\}|test|spec)/.test(n) || /__tests__/.test(n))) continue;
        }
        if (rule.id === "pytest" && BENIGN_PLUGINS.test(text) && !/--ignore|--deselect|-k\s+["']?not\b/.test(text)) continue;
        add(ctx, "config-weakened", severity, line, message, text, sup);
        break;
      }
    }
  }
}
function normalizeContent(s) {
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
}
function findMovedPairs(files, opts) {
  const paired = /* @__PURE__ */ new Set();
  const added = files.filter((f) => f.status === "added" && !f.binary);
  for (const del of files.filter((f) => f.status === "deleted" && !f.binary)) {
    const before = opts.readBefore(del.path);
    if (before === null) continue;
    const norm = normalizeContent(before);
    const match = added.find((a) => !paired.has(a.path) && normalizeContent(opts.readAfter(a.path) ?? "\0") === norm);
    if (match) {
      paired.add(del.path);
      paired.add(match.path);
    }
  }
  return paired;
}
function scanIntegrity(files, opts) {
  const findings = [];
  const summary = { testsBefore: 0, testsAfter: 0, assertionsBefore: 0, assertionsAfter: 0, skippedBefore: 0, skippedAfter: 0 };
  let testFiles = 0;
  const pairs = findMovedPairs(files, opts);
  const verdicts = /* @__PURE__ */ new Map();
  const isTest = (path, deleted) => {
    let v = verdicts.get(path);
    if (v === void 0) {
      v = isTestFile(path, deleted ? [() => opts.readBefore(path)] : [() => opts.readAfter(path), () => opts.readBefore(path)]);
      verdicts.set(path, v);
    }
    return v;
  };
  const cross = { addedByFile: /* @__PURE__ */ new Map() };
  for (const file of files) {
    if (file.binary || !isTest(file.path, file.status === "deleted")) continue;
    const lang = langOf(file.path);
    const titles = /* @__PURE__ */ new Map();
    const after = lang === "rust" ? opts.readAfter(file.path) : null;
    const lines = after ? regionLines(after, rustTestRegions(normalizeFile(lang, after))) : null;
    const inRegion = (l) => lines === null || l.newNo !== null && lines.has(l.newNo);
    for (const d of declarationLines(lang, file.hunks.flatMap((h) => h.lines), "+", inRegion)) titles.set(d, (titles.get(d) ?? 0) + 1);
    cross.addedByFile.set(file.path, titles);
  }
  for (const file of files) {
    if (file.binary) continue;
    const lang = langOf(file.path);
    const ctx = { file, lang, findings, ci: opts.ci ?? false };
    const movedPair = pairs.has(file.path);
    if (isTest(file.path, file.status === "deleted") || file.oldPath && isTest(file.oldPath, true)) {
      testFiles++;
      const before = countTests(lang, file.status === "added" ? null : opts.readBefore(file.oldPath ?? file.path), lang === "rust" && !isTestFile(file.path));
      const after = countTests(lang, file.status === "deleted" ? null : opts.readAfter(file.path), lang === "rust" && !isTestFile(file.path));
      summary.testsBefore += before.tests;
      summary.testsAfter += after.tests;
      summary.assertionsBefore += before.assertions;
      summary.assertionsAfter += after.assertions;
      summary.skippedBefore += before.skipped;
      summary.skippedAfter += after.skipped;
      if (!(movedPair && file.status === "added")) scanTestFile(ctx, opts, cross, movedPair);
    }
    if (isTestConfigFile(file.path)) scanConfigFile(ctx, movedPair);
    if (/\.snap$/.test(file.path) && file.status !== "added") {
      add(ctx, "snapshot-changed", "low", null, "snapshot file changed", file.path, null);
    }
  }
  const order2 = { critical: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order2[a.severity] - order2[b.severity] || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  const blocking = findings.filter((f) => !f.suppressed && (f.severity === "critical" || f.severity === "high"));
  return { findings, summary, files: files.length, testFiles, blocking };
}
function formatSummaryLine(s) {
  return `Tests ${s.testsBefore} -> ${s.testsAfter}   Assertions ${s.assertionsBefore} -> ${s.assertionsAfter}   Skipped ${s.skippedBefore} -> ${s.skippedAfter}`;
}

// src/passes.ts
import { existsSync as existsSync6 } from "node:fs";
import { join as join7 } from "node:path";

// src/receipt.ts
import { createHmac, randomBytes, createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2, readdirSync as readdirSync3 } from "node:fs";
import { join as join6 } from "node:path";
var RECEIPT_FILE = "receipt.json";
var KEY_FILE = "key";
var KEY_RE = /^[0-9a-f]{64}$/;
function dir(root) {
  return join6(root, RECEIPT_DIR);
}
function ensureStateDir(root) {
  const d = dir(root);
  if (!existsSync5(d)) mkdirSync2(d, { recursive: true });
  const gi = join6(d, ".gitignore");
  if (!existsSync5(gi)) writeFileSync2(gi, "*\n");
  return d;
}
function loadKey(root) {
  const d = ensureStateDir(root);
  const f = join6(d, KEY_FILE);
  const read = () => {
    try {
      const k = readFileSync3(f, "utf8").trim();
      return KEY_RE.test(k) ? k : null;
    } catch {
      return null;
    }
  };
  const existing = read();
  if (existing) return existing;
  const key = randomBytes(32).toString("hex");
  try {
    writeFileSync2(f, key + "\n", { mode: 384, flag: "wx" });
    return key;
  } catch {
    for (let i = 0; i < 20; i++) {
      const k = read();
      if (k) return k;
      const until = Date.now() + 10;
      while (Date.now() < until) {
      }
    }
    writeFileSync2(f, key + "\n", { mode: 384 });
    return key;
  }
}
function canonical(r) {
  const { hmac: _omit, ...rest } = r;
  return JSON.stringify(rest);
}
function sign(root, r) {
  return signText(root, canonical(r));
}
function signText(root, text) {
  return createHmac("sha256", loadKey(root)).update(text).digest("hex");
}
function configHash(root) {
  const h = createHash2("sha256");
  const files = [".isitdone.json", "package.json", "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "Makefile", "go.mod", "Cargo.toml"];
  try {
    for (const e of readdirSync3(root)) {
      if (/^(jest|vitest|vite|playwright|cypress|karma|mocha|ava)\.config\.[cm]?[jt]s$/.test(e) || /^\.mocharc/.test(e) || e === "tsconfig.json" || /^eslint\.config\.[cm]?js$/.test(e)) {
        files.push(e);
      }
    }
    const wf = join6(root, ".github", "workflows");
    if (existsSync5(wf)) {
      for (const e of readdirSync3(wf)) if (/\.ya?ml$/.test(e)) files.push(join6(".github", "workflows", e));
    }
  } catch {
  }
  for (const f of files.sort()) {
    const p = join6(root, f);
    if (!existsSync5(p)) continue;
    let content = readFileSync3(p);
    if (f === "package.json") {
      try {
        const pkg = JSON.parse(readTextFile(p));
        content = JSON.stringify({ scripts: pkg.scripts, isitdone: pkg.isitdone, packageManager: pkg.packageManager });
      } catch {
      }
    }
    h.update(f).update("\0").update(content).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}
function writeReceipt(root, r) {
  const receipt = {
    version: 1,
    tool: `isitdone/${VERSION}`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...r
  };
  receipt.hmac = sign(root, receipt);
  const d = ensureStateDir(root);
  writeFileAtomic(join6(d, RECEIPT_FILE), JSON.stringify(receipt, null, 2) + "\n");
  return receipt;
}
function readReceipt(root) {
  const f = join6(dir(root), RECEIPT_FILE);
  if (!existsSync5(f)) return { receipt: null, valid: false, reason: "no receipt" };
  let receipt;
  try {
    receipt = JSON.parse(readTextFile(f));
  } catch {
    return { receipt: null, valid: false, reason: "receipt is not valid JSON" };
  }
  if (receipt.version !== 1) return { receipt, valid: false, reason: `unsupported receipt version ${String(receipt.version)}` };
  if (!receipt.hmac || receipt.hmac !== sign(root, receipt)) return { receipt, valid: false, reason: "receipt signature does not match (edited by hand?)" };
  return { receipt, valid: true, reason: "ok" };
}
function evaluateReceipt(root, git3, currentConfigHash) {
  const { receipt, valid, reason } = readReceipt(root);
  if (!receipt || !valid) return { state: "NONE", receipt: null, reason };
  if (git3.tree === "nogit") {
    return { state: "STALE", receipt, reason: "not a git repository, so the working tree cannot be hashed and the receipt cannot be trusted" };
  }
  if (git3.tree === "unknown") {
    return { state: "STALE", receipt, reason: `working tree could not be hashed (${git3.treeError ?? "git error"}), so the receipt cannot be trusted` };
  }
  if (receipt.tree !== git3.tree && receipt.treeBefore !== git3.tree) {
    return { state: "STALE", receipt, reason: `files changed since the receipt (tree ${receipt.tree.slice(0, 7)} -> ${git3.tree.slice(0, 7)})` };
  }
  if (receipt.configHash !== currentConfigHash) {
    return { state: "STALE", receipt, reason: "check configuration changed since the receipt" };
  }
  const what = receipt.profile === "lite" ? "lite checks (typecheck/lint) passed on this exact tree; tests were not run" : "all checks passed on this exact tree";
  return { state: receipt.status, receipt, reason: receipt.status === "PASS" ? what : "checks failed on this exact tree" };
}

// src/passes.ts
var PASSES_FILE = "passes.json";
function canonical2(f) {
  return JSON.stringify({ version: f.version, checks: f.checks });
}
function readPasses(root) {
  const file = join7(root, RECEIPT_DIR, PASSES_FILE);
  if (!existsSync6(file)) return {};
  try {
    const f = JSON.parse(readTextFile(file));
    if (f.version !== 1 || typeof f.checks !== "object" || f.checks === null || !f.hmac) return {};
    return f.hmac === signText(root, canonical2(f)) ? f.checks : {};
  } catch {
    return {};
  }
}
function sameList(a, b) {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
function reusablePass(rec, check, configHash2, inputs) {
  if (!rec || !inputs || !check.ignore || check.ignore.length === 0) return null;
  if (rec.cmd !== check.cmd || rec.cwd !== (check.cwd ?? null) || rec.configHash !== configHash2 || !sameList(rec.ignore, check.ignore)) return null;
  return rec.inputs === inputs ? rec : null;
}
function reusedResult(check, rec, timeoutMs) {
  return {
    id: check.id,
    cmd: check.cmd,
    status: "PASS",
    exitCode: 0,
    durationMs: 0,
    timeoutMs,
    tail: [],
    lines: 0,
    ...rec.summary ? { summary: rec.summary } : {},
    reused: { at: rec.at, tree: rec.tree, durationMs: rec.durationMs }
  };
}
function updatePasses(root, set, drop) {
  if (Object.keys(set).length === 0 && drop.length === 0) return;
  const checks = { ...readPasses(root) };
  let changed = false;
  for (const id2 of drop) {
    if (id2 in checks) {
      delete checks[id2];
      changed = true;
    }
  }
  for (const [id2, rec] of Object.entries(set)) {
    checks[id2] = rec;
    changed = true;
  }
  if (!changed) return;
  const f = { version: 1, checks };
  f.hmac = signText(root, canonical2(f));
  writeFileAtomic(join7(ensureStateDir(root), PASSES_FILE), JSON.stringify(f, null, 2) + "\n");
}

// src/run.ts
import { spawn, spawnSync as spawnSync3 } from "node:child_process";

// src/output.ts
var ESC = String.fromCharCode(27);
var wrap = (open, close) => (s) => `${ESC}[${open}m${s}${ESC}[${close}m`;
var id = (s) => s;
var ansi = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39)
};
var plain = {
  bold: id,
  dim: id,
  red: id,
  green: id,
  yellow: id,
  cyan: id,
  magenta: id
};
function colorEnabled(stream = process.stdout) {
  if (process.env.NO_COLOR !== void 0 && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR === "0") return false;
  if (process.env.FORCE_COLOR !== void 0 && process.env.FORCE_COLOR !== "") return true;
  return Boolean(stream.isTTY);
}
function styleFor(stream = process.stdout) {
  return colorEnabled(stream) ? ansi : plain;
}
function formatDuration(ms) {
  if (ms < 1e3) return `${Math.round(ms)}ms`;
  if (ms < 6e4) return `${(ms / 1e3).toFixed(1)}s`;
  const m = Math.floor(ms / 6e4);
  const s = Math.round(ms % 6e4 / 1e3);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
function pad(s, width) {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
var ANSI_RE = new RegExp(`${ESC}[[0-9;?]*[ -/]*[@-~]`, "g");
function stripAnsi(s) {
  return s.replace(ANSI_RE, "").replace(/\r(?!\n)/g, "\n");
}
function share(n, total) {
  if (total === 0) return "-";
  const v = Math.round(100 * n / total);
  if (v === 0 && n > 0) return "<1%";
  if (v === 100 && n < total) return ">99%";
  return `${v}%`;
}

// src/run.ts
var MAX_LINE = 64 * 1024;
var EXIT_GRACE_MS = 400;
var KILL_GRACE_MS = 2e3;
var Tail = class {
  constructor(max) {
    this.max = max;
  }
  max;
  buf = [];
  partial = "";
  lines = 0;
  push(chunk) {
    let text = this.partial + chunk;
    let hold = "";
    if (text.endsWith("\r")) {
      hold = "\r";
      text = text.slice(0, -1);
    }
    const parts = text.split("\n");
    let last = (parts.pop() ?? "") + hold;
    for (const p of parts) this.add(this.lastSegment(p));
    last = this.lastSegment(last.endsWith("\r") ? last.slice(0, -1) : last) + (last.endsWith("\r") ? "\r" : "");
    this.partial = last.length > MAX_LINE ? last.slice(-MAX_LINE) : last;
  }
  lastSegment(line) {
    const withoutCrlf = line.endsWith("\r") ? line.slice(0, -1) : line;
    const i = withoutCrlf.lastIndexOf("\r");
    return i >= 0 ? withoutCrlf.slice(i + 1) : withoutCrlf;
  }
  add(line) {
    this.lines++;
    this.buf.push(line.length > MAX_LINE ? line.slice(-MAX_LINE) : line);
    if (this.buf.length > this.max) this.buf.shift();
  }
  finish() {
    const rest = this.partial.endsWith("\r") ? this.partial.slice(0, -1) : this.partial;
    if (rest !== "") this.add(this.lastSegment(rest));
    this.partial = "";
    return this.buf.map((l) => stripAnsi(l).replace(/\s+$/, ""));
  }
};
function posixDescendants(root) {
  const r = spawnSync3("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 || !r.stdout) return [];
  const children = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out3 = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    for (const c of children.get(p) ?? []) {
      out3.push(c);
      stack.push(c);
    }
  }
  return out3;
}
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync3("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5e3 });
      return;
    }
    const descendants = posixDescendants(pid);
    for (const p of descendants.reverse()) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
      }
    }
    process.kill(pid, "SIGKILL");
  } catch {
  }
}
var SUMMARY_PATTERNS = [
  /\bTests:\s+.*$/i,
  // jest "Tests: 1 failed, 2 passed"
  /\bTest Files\s+.*$/i,
  // vitest
  /\btest result: .*$/i,
  // cargo
  /\b\d+ (?:failed|passed|skipped|pending|todo)(?:,\s*\d+ (?:failed|passed|skipped|pending|todo))*\b.*$/i,
  // jest/vitest/pytest style
  /^(?:FAIL|ok|---\s*FAIL)\b.*$/m,
  // go test
  /\bFound \d+ errors? in \d+ files?\.?/i,
  // tsc
  /\berror TS\d+:.*$/,
  // tsc single error
  /\b\d+ problems? \(\d+ errors?, \d+ warnings?\)/i,
  // eslint
  /\bFound \d+ errors?\b.*$/i,
  // ruff/mypy
  /\bSuccess: no issues found\b.*$/i,
  // mypy
  /\ball checks passed!?/i,
  // ruff
  /\bPassed!\s+-\s+Failed:\s+\d+.*$/i,
  // dotnet
  /\bFailed!\s+-\s+Failed:\s+\d+.*$/i,
  // dotnet
  /\bBUILD (?:SUCCESSFUL|FAILED|SUCCESS|FAILURE)\b.*$/i
  // gradle/maven
];
function extractSummary(tail) {
  let nodePass;
  let nodeFail;
  for (const line of tail) {
    const p = /^\s*(?:ℹ|i)?\s*pass\s+(\d+)\s*$/.exec(line);
    const f = /^\s*(?:ℹ|i)?\s*fail\s+(\d+)\s*$/.exec(line);
    if (p) nodePass = p[1];
    if (f) nodeFail = f[1];
  }
  if (nodePass !== void 0 && nodeFail !== void 0) return `${nodeFail} failed, ${nodePass} passed`;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    for (const re of SUMMARY_PATTERNS) {
      const m = re.exec(line);
      if (m) return m[0].trim().slice(0, 120);
    }
  }
  return void 0;
}
function childEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra, ISITDONE: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  if (env.CI === void 0) env.CI = "true";
  return env;
}
function runCheck(check, opts) {
  const started = Date.now();
  const tail = new Tail(opts.tailLines ?? 30);
  return new Promise((resolve7) => {
    let finished = false;
    let timedOut = false;
    let cancelled = false;
    let exited = null;
    let graceTimer = null;
    let killTimer = null;
    const child = spawn(check.cmd, {
      cwd: opts.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? childEnv(),
      windowsHide: true,
      detached: false
    });
    const onData = (d) => {
      const s = d.toString("utf8");
      tail.push(s);
      opts.onOutput?.(s);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const done = (status, exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
      }
      const lines = tail.finish();
      const result = {
        id: check.id,
        cmd: check.cmd,
        status,
        exitCode,
        durationMs: Date.now() - started,
        timeoutMs: opts.timeoutMs,
        tail: lines,
        lines: tail.lines
      };
      const summary = cancelled ? "cancelled" : extractSummary(lines);
      if (summary) result.summary = summary;
      resolve7(result);
    };
    const settle = () => {
      if (cancelled) return done("ERROR", exited?.code ?? null);
      if (timedOut) return done("TIMEOUT", exited?.code ?? null);
      if (!exited) return done("ERROR", null);
      if (exited.code === 0) return done("PASS", 0);
      if (exited.signal) tail.push(`(terminated by ${exited.signal})
`);
      done("FAIL", exited.code);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      killTimer = setTimeout(settle, KILL_GRACE_MS);
    }, opts.timeoutMs);
    child.on("error", (err2) => {
      tail.push(`${err2.message}
`);
      done("ERROR", null);
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      graceTimer = setTimeout(settle, EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => {
      if (!exited) exited = { code, signal };
      settle();
    });
    function onAbort() {
      if (finished || cancelled) return;
      cancelled = true;
      tail.push("(cancelled)\n");
      if (child.pid) killTree(child.pid);
      if (!killTimer) killTimer = setTimeout(settle, KILL_GRACE_MS);
    }
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/sessions.ts
import { appendFileSync, mkdirSync as mkdirSync3, readdirSync as readdirSync4, readFileSync as readFileSync4, rmSync as rmSync3, statSync as statSync3, utimesSync, writeFileSync as writeFileSync3 } from "node:fs";
import { performance } from "node:perf_hooks";
import { createHash as createHash3 } from "node:crypto";
import { join as join8 } from "node:path";
var SESSIONS_DIR = "sessions";
var EDITS_EXT = ".edits";
var ACTIVE_WINDOW_MS = 60 * 60 * 1e3;
var RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var MAX_PATHS_PER_EVENT = 50;
var COMPACT_ABOVE_BYTES = 64 * 1024;
function sessionKey(host, sessionId) {
  return `${host}-${createHash3("sha1").update(sessionId ?? "anon").digest("hex").slice(0, 16)}`;
}
function sessionsDir(base) {
  return join8(base, RECEIPT_DIR, SESSIONS_DIR);
}
function recordEdits(top, host, sessionId, paths, now = Date.now()) {
  if (sessionId === null || paths.length === 0) return;
  try {
    ensureStateDir(top);
    mkdirSync3(sessionsDir(top), { recursive: true });
    const lines = paths.slice(0, MAX_PATHS_PER_EVENT).map((p) => JSON.stringify({ t: now, p }) + "\n");
    appendFileSync(join8(sessionsDir(top), sessionKey(host, sessionId) + EDITS_EXT), lines.join(""));
  } catch {
  }
}
function recordPass(top, host, sessionId, at) {
  if (sessionId === null) return;
  try {
    ensureStateDir(top);
    mkdirSync3(sessionsDir(top), { recursive: true });
    appendFileSync(join8(sessionsDir(top), sessionKey(host, sessionId) + EDITS_EXT), JSON.stringify({ t: at, pass: true }) + "\n");
  } catch {
  }
}
function readSessions(bases) {
  const out3 = /* @__PURE__ */ new Map();
  const get = (key) => {
    let s = out3.get(key);
    if (!s) {
      s = { key, firstSeen: Infinity, lastActive: 0, lastPassAt: 0, files: /* @__PURE__ */ new Map() };
      out3.set(key, s);
    }
    return s;
  };
  const seen = (s, t) => {
    if (t < s.firstSeen) s.firstSeen = t;
    if (t > s.lastActive) s.lastActive = t;
  };
  for (const base of new Set(bases)) {
    const dir2 = sessionsDir(base);
    let entries;
    try {
      entries = readdirSync4(dir2);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(EDITS_EXT)) {
        let text;
        try {
          text = readFileSync4(join8(dir2, e), "utf8");
        } catch {
          continue;
        }
        const s = get(e.slice(0, -EDITS_EXT.length));
        for (const line of text.split("\n")) {
          if (line === "") continue;
          try {
            const rec = JSON.parse(line);
            if (typeof rec.t === "number" && rec.pass === true) {
              if (rec.t > s.lastPassAt) s.lastPassAt = rec.t;
              seen(s, rec.t);
              continue;
            }
            if (typeof rec.t !== "number" || typeof rec.p !== "string") continue;
            if ((s.files.get(rec.p) ?? 0) < rec.t) s.files.set(rec.p, rec.t);
            seen(s, rec.t);
          } catch {
          }
        }
      } else if (e.endsWith(".json")) {
        const st = tryReadJsonFile(join8(dir2, e));
        const s = get(e.slice(0, -".json".length));
        for (const iso of [st?.firstSeen, st?.updatedAt]) {
          const t = iso ? Date.parse(iso) : NaN;
          if (!Number.isNaN(t)) seen(s, t);
        }
        const passed = st?.lastPassAt ? Date.parse(st.lastPassAt) : NaN;
        if (!Number.isNaN(passed) && passed > s.lastPassAt) s.lastPassAt = passed;
      }
    }
  }
  return [...out3.values()];
}
function pruneSessions(base, now = Date.now()) {
  const dir2 = sessionsDir(base);
  try {
    for (const e of readdirSync4(dir2)) {
      const p = join8(dir2, e);
      try {
        if (now - statSync3(p).mtimeMs > RECORD_MAX_AGE_MS) rmSync3(p, { force: true });
      } catch {
      }
    }
  } catch {
  }
}
function lastEditAt(bases, host, sessionId) {
  if (sessionId === null) return 0;
  try {
    const me = readSessions(bases).find((s) => s.key === sessionKey(host, sessionId));
    return me ? Math.max(0, ...me.files.values()) : 0;
  } catch {
    return 0;
  }
}
function editsSince(bases, since) {
  try {
    return readSessions(bases).some((s) => [...s.files.values()].some((t) => t >= since));
  } catch {
    return false;
  }
}
function compactEdits(top, host, sessionId) {
  if (sessionId === null) return;
  const file = join8(sessionsDir(top), sessionKey(host, sessionId) + EDITS_EXT);
  try {
    if (statSync3(file).size < COMPACT_ABOVE_BYTES) return;
    const me = readSessions([top]).find((s) => s.key === sessionKey(host, sessionId));
    if (!me) return;
    if (me.files.size === 0) return;
    const lines = [...me.files].map(([p, t]) => JSON.stringify({ t, p }) + "\n");
    lines.unshift(JSON.stringify({ t: me.firstSeen, p: [...me.files.keys()][0] }) + "\n");
    if (me.lastPassAt > 0) lines.push(JSON.stringify({ t: me.lastPassAt, pass: true }) + "\n");
    writeFileAtomic(file, lines.join(""));
  } catch {
  }
}
function attribute(bases, host, sessionId, dirty, now = Date.now()) {
  if (sessionId === null) return null;
  const sessions = readSessions(bases);
  const meKey = sessionKey(host, sessionId);
  const me = sessions.find((s) => s.key === meKey);
  const myStart = me && Number.isFinite(me.firstSeen) ? me.firstSeen : now;
  const unfinished = (s) => [...s.files.values()].some((t) => t > s.lastPassAt);
  const concurrent = sessions.filter((s) => s.key !== meKey && s.lastActive > myStart && now - s.lastActive <= ACTIVE_WINDOW_MS && unfinished(s));
  if (concurrent.length === 0) return null;
  const dirtyNow = dirty();
  const mine = new Set(me ? me.files.keys() : []);
  const others = /* @__PURE__ */ new Map();
  let otherLastActive = 0;
  for (const s of concurrent) {
    let counted = false;
    for (const [p, t] of s.files) {
      if (t <= s.lastPassAt || !dirtyNow.has(p) || now - t > RECORD_MAX_AGE_MS) continue;
      counted = true;
      if ((others.get(p) ?? 0) < t) others.set(p, t);
    }
    if (counted && s.lastActive > otherLastActive) otherLastActive = s.lastActive;
  }
  if (others.size === 0) return null;
  const foreign = [];
  const shared = [];
  for (const [path, editedAt] of others) (mine.has(path) ? shared : foreign).push({ path, editedAt });
  const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { mine, foreign: foreign.sort(byPath), shared: shared.sort(byPath), otherLastActive };
}
function liveSessionsNote(bases, dirty, now = Date.now()) {
  const recent = readSessions(bases).filter((s) => now - s.lastActive <= ACTIVE_WINDOW_MS && [...s.files.values()].some((t) => t > s.lastPassAt));
  const overlapping = recent.filter((s) => recent.some((t) => t !== s && s.firstSeen < t.lastActive && t.firstSeen < s.lastActive));
  if (overlapping.length < 2) return null;
  const dirtyNow = dirty();
  const live = overlapping.map((s) => ({ ...s, dirty: [...s.files].filter(([p, t]) => t > s.lastPassAt && dirtyNow.has(p)).map(([p]) => p).sort() })).filter((s) => s.dirty.length > 0).sort((a, b) => b.lastActive - a.lastActive);
  if (live.length < 2) return null;
  const lines = [`  note: ${live.length} agent sessions have uncommitted edits in this directory. If you are one of them, fix only the files you edited and leave the others alone:`];
  for (const s of live.slice(0, 5)) {
    const shown = s.dirty.slice(0, 8).join(", ") + (s.dirty.length > 8 ? `, ... ${s.dirty.length - 8} more` : "");
    lines.push(`    ${s.key.slice(0, s.key.lastIndexOf("-") + 7)} (active ${formatAgo(now - s.lastActive)}): ${shown}`);
  }
  return lines.join("\n");
}
var GENERIC_BASENAME = /^(?:index|main|mod|lib|utils?|helpers?|types?|common|base|core|config|constants|setup|conftest|__init__|test|tests|app)\.[A-Za-z0-9]+$/i;
var PATH_CHAR = /[^\s"'`<>|*?,;=]/;
var ANCHOR = String.fromCharCode(1);
var MAX_TOKEN = 4096;
var MAX_HITS = 2e3;
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\export function mentionContext(");
}
function mentionContext(output, top, repoPaths, fold = process.platform === "win32" || process.platform === "darwin") {
  const norm = (s) => fold ? s.toLowerCase() : s;
  const byBase = /* @__PURE__ */ new Map();
  for (const p of new Set(repoPaths)) {
    const q = norm(p);
    const name = q.slice(q.lastIndexOf("/") + 1);
    const list = byBase.get(name);
    if (list) list.push(q);
    else byBase.set(name, [q]);
  }
  const topNorm = norm(top.replace(/\\/g, "/").replace(/\/$/, ""));
  const plain2 = norm(stripAnsi(output).replace(/\\/g, "/"));
  const text = topNorm === "" ? plain2 : plain2.replace(new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(topNorm)}/`, "g"), ANCHOR);
  return { text, top: topNorm, byBase, fold };
}
function mentions(ctx, file) {
  const path = ctx.fold ? file.toLowerCase() : file;
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "") return false;
  const text = ctx.text;
  const sameBase = ctx.byBase.get(name) ?? [path];
  const resolves = (token, end) => {
    let t = token;
    const k = t.lastIndexOf(ANCHOR);
    if (k >= 0) return t.slice(k + 1) === path;
    {
      t = t.replace(/^[a-z][a-z0-9+.-]*:\/\/+(?![a-z]:\/)/i, "").replace(/^[a-z][a-z0-9+.-]*:\/\/+/i, "");
      while (t.startsWith("./")) t = t.slice(2);
      if (t.startsWith("/") || /^[a-z]:\//i.test(t)) return false;
    }
    if (t === path && t.includes("/")) return true;
    if (t !== path && !path.endsWith(`/${t}`)) return false;
    const unique = sameBase.filter((p) => p === t || p.endsWith(`/${t}`)).length <= 1;
    if (t.includes("/")) return unique;
    if (!unique) return false;
    if (t === path) return true;
    return !GENERIC_BASENAME.test(name) && /^[:(]\d/.test(text.slice(end, end + 2));
  };
  let looked = 0;
  for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
    const end = i + name.length;
    const next = text[end];
    if (next !== void 0 && /[A-Za-z0-9_-]/.test(next)) continue;
    if (next === "." && /[A-Za-z0-9]/.test(text[end + 1] ?? "")) continue;
    if (i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1])) continue;
    if (++looked > MAX_HITS) return false;
    const whole = end - path.length;
    const anchored = whole > 0 && text[whole - 1] === ANCHOR;
    if (whole >= 0 && text.startsWith(path, whole) && (anchored || path.includes("/") && (whole === 0 || !/[A-Za-z0-9_.\/-]/.test(text[whole - 1])))) return true;
    let start = i;
    while (start > 0 && i - start < MAX_TOKEN && PATH_CHAR.test(text[start - 1])) start--;
    const token = text.slice(start, end);
    if (resolves(token, end)) return true;
    const open = Math.max(token.lastIndexOf("("), token.lastIndexOf("["), token.lastIndexOf("{"));
    const inner = (open >= 0 ? token.slice(open + 1) : token).replace(/^[a-z]+:(?!\/)/i, "");
    if (inner !== token && inner.endsWith(name) && resolves(inner, end)) return true;
  }
  return false;
}
function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1e3));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
var LOCK_FILE = "run.lock";
var LOCK_WAIT_MS = 18e4;
var LOCK_BEAT_MS = 5e3;
var LOCK_STALE_MS = 3e4;
var LOCK_DEAD_PID_MS = 2 * LOCK_BEAT_MS + 1e3;
var LOCK_POLL_MS = 400;
function pidGone(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err2) {
    return err2.code === "ESRCH";
  }
}
async function acquireRunLock(root, waitMs = LOCK_WAIT_MS, onWait, signal) {
  const started = performance.now();
  const waited = () => Math.round(performance.now() - started);
  let tookOver = false;
  let told = false;
  const none = () => ({ held: false, waitedMs: waited(), tookOver, release: () => {
  } });
  let file;
  try {
    file = join8(ensureStateDir(root), LOCK_FILE);
  } catch {
    return none();
  }
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const holder = () => tryReadJsonFile(file);
  const tokenOf = () => holder()?.token ?? null;
  for (; ; ) {
    try {
      writeFileSync3(file, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }), { flag: "wx" });
      const touch = () => {
        try {
          const now = /* @__PURE__ */ new Date();
          utimesSync(file, now, now);
        } catch {
        }
      };
      touch();
      const beat = setInterval(touch, LOCK_BEAT_MS);
      beat.unref();
      return {
        held: true,
        waitedMs: waited(),
        tookOver,
        release: () => {
          clearInterval(beat);
          try {
            if (tokenOf() === token) rmSync3(file, { force: true });
          } catch {
          }
        }
      };
    } catch (err2) {
      const code = err2.code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") return none();
    }
    try {
      const st = statSync3(file);
      const age = Date.now() - st.mtimeMs;
      const judged = holder();
      if (age > LOCK_STALE_MS || age > LOCK_DEAD_PID_MS && pidGone(judged?.pid)) {
        const again = statSync3(file);
        if (again.mtimeMs === st.mtimeMs && tokenOf() === (judged?.token ?? null)) {
          rmSync3(file, { force: true });
          tookOver = true;
        }
      }
    } catch {
    }
    if (waited() >= waitMs || signal?.aborted) return none();
    if (!told) {
      told = true;
      onWait?.();
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}

// src/verify.ts
function runIntegrity(git3, opts, warnings) {
  if (!git3.isRepo) return null;
  const base = opts.base ?? "HEAD";
  const diff = collectDiff(git3.root, base);
  if (diff.error) {
    warnings.push(`integrity scan skipped: ${diff.error}`);
    return null;
  }
  try {
    return scanIntegrity(diff.files, {
      readBefore: (p) => readAtBase(git3.root, p, base),
      readAfter: (p) => readNow(git3.root, p),
      ci: opts.ci ?? false
    });
  } catch (err2) {
    warnings.push(`integrity scan failed: ${err2.message}`);
    return null;
  }
}
var DEFAULT_TIMEOUT_S = 120;
var DEFAULT_LITE_TIMEOUT_S = 60;
function timeoutFor(check, config) {
  if (check.timeout !== void 0) return check.timeout * 1e3;
  if (check.kind === "lite") return (config.liteTimeout ?? DEFAULT_LITE_TIMEOUT_S) * 1e3;
  return (config.timeout ?? DEFAULT_TIMEOUT_S) * 1e3;
}
function budgetSeconds(checks, config) {
  return checks.reduce((sum, c) => sum + timeoutFor(c, config) / 1e3, 0);
}
function receiptSatisfies(evaluation, profile) {
  if (evaluation.state !== "PASS" || !evaluation.receipt) return false;
  if (profile === "full") return evaluation.receipt.profile === "full";
  return true;
}
async function verify(opts) {
  const started = Date.now();
  const root = opts.root;
  const detection = detectChecks(root, opts.config);
  const scoped = detection.checks.filter((c) => c.ignore !== void 0 && c.ignore.length > 0);
  const ignoreSets = scoped.map((c) => c.ignore);
  const inputsOf = (g, id2) => {
    const i = scoped.findIndex((c) => c.id === id2);
    return i >= 0 ? g.inputs?.[i] ?? null : null;
  };
  let git3 = gitInfo(root, ignoreSets);
  const ch = configHash(root);
  const before = evaluateReceipt(root, git3, ch);
  const claim = opts.claim ?? null;
  const warnings = [];
  if (git3.treeError) warnings.push(`working tree could not be hashed (${git3.treeError}); receipts cannot be cached`);
  const integrityMode = opts.config.integrity ?? "warn";
  const integrity = integrityMode === "off" ? null : runIntegrity(git3, { base: opts.base, ci: opts.ci }, warnings);
  let base = { git: git3, detection, profile: opts.profile, before, claim, warnings, integrity, integrityMode };
  if ((opts.useCache ?? true) && receiptSatisfies(before, opts.profile)) {
    return { ...base, ok: true, ran: [], skipped: [], receipt: before.receipt, cached: true, durationMs: Date.now() - started };
  }
  const wanted = opts.profile === "full" ? detection.checks : detection.checks.filter((c) => c.kind === "lite");
  const skipped = detection.checks.filter((c) => !wanted.includes(c)).map((check) => ({ check, reason: "full checks run only when the agent claims completion (claim-gated profile)" }));
  if (wanted.length === 0) {
    return { ...base, ok: true, ran: [], skipped, receipt: null, cached: false, durationMs: Date.now() - started };
  }
  const mayReuse = (opts.useCache ?? true) && !opts.dryRun && scoped.length > 0;
  const reusable = (g) => {
    const out3 = /* @__PURE__ */ new Map();
    if (!mayReuse) return out3;
    const passes = readPasses(root);
    for (const c of wanted) {
      const rec = reusablePass(passes[c.id], c, ch, inputsOf(g, c.id));
      if (rec) out3.set(c.id, rec);
    }
    return out3;
  };
  let reuse = reusable(git3);
  const nothingToRun = wanted.every((c) => reuse.has(c.id));
  const waitMs = nothingToRun ? 0 : typeof opts.lockWaitMs === "function" ? opts.lockWaitMs(wanted) : opts.lockWaitMs ?? 0;
  const lock = waitMs > 0 ? await acquireRunLock(root, waitMs, opts.onLockWait, opts.signal) : null;
  const lockInfo = lock ? { waitedMs: lock.waitedMs, held: lock.held, tookOver: lock.tookOver } : void 0;
  try {
    if (lock && lock.waitedMs > 1e3) {
      git3 = gitInfo(root, ignoreSets);
      const again = evaluateReceipt(root, git3, ch);
      base = { ...base, git: git3, before: again };
      if ((opts.useCache ?? true) && receiptSatisfies(again, opts.profile) && again.receipt?.treeBefore === git3.tree) {
        return { ...base, ok: true, ran: [], skipped: [], receipt: again.receipt, cached: true, durationMs: Date.now() - started, lock: lockInfo };
      }
      reuse = reusable(git3);
    }
    const runStarted = Date.now();
    const env = childEnv(process.env, detection.env);
    const ran = [];
    let liteFailed = false;
    for (const check of wanted) {
      if (opts.signal?.aborted) {
        skipped.push({ check, reason: "cancelled" });
        continue;
      }
      if (check.kind === "full" && liteFailed && !opts.all) {
        skipped.push({ check, reason: "skipped because a lite check failed (use --all to run anyway)" });
        continue;
      }
      const prior = reuse.get(check.id);
      if (prior) {
        ran.push(reusedResult(check, prior, timeoutFor(check, opts.config)));
        continue;
      }
      opts.onCheckStart?.(check);
      const result = await runCheck(check, {
        cwd: check.cwd ? join9(root, check.cwd) : root,
        timeoutMs: timeoutFor(check, opts.config),
        env,
        onOutput: opts.onOutput ? (chunk) => opts.onOutput?.(check, chunk) : void 0,
        signal: opts.signal
      });
      ran.push(result);
      opts.onCheckDone?.(result);
      if (result.status !== "PASS" && check.kind === "lite") liteFailed = true;
    }
    const cancelled = opts.signal?.aborted ?? false;
    if (cancelled) warnings.push("verification was cancelled; no receipt was written");
    const ok = !cancelled && ran.every((r) => r.status === "PASS");
    const fullRan = detection.checks.filter((c) => c.kind === "full").every((c) => ran.some((r) => r.id === c.id));
    let receipt = null;
    if (!opts.dryRun && !cancelled) {
      const now = git3.isRepo ? gitInfo(root, ignoreSets) : git3;
      let after = now;
      const sessionEdits = git3.isRepo && editsSince([git3.root, root], runStarted);
      const editedMidRun = now.tree !== git3.tree && (sessionEdits || existingPathsChanged(git3.root, git3.tree, now.tree));
      if (editedMidRun) {
        warnings.push("files changed while the checks ran; the receipt covers the tree the run started on, not the current one");
        after = git3;
      }
      if (after !== git3 && ran.some((r) => r.reused && inputsOf(now, r.id) !== inputsOf(git3, r.id))) {
        warnings.push("files a reused check reads changed during the run; the receipt covers the tree the run started on, not the current one");
        after = git3;
      }
      if (scoped.length > 0) {
        const set = {};
        const drop = [];
        for (const r of ran) {
          const check = scoped.find((c) => c.id === r.id);
          if (!check || r.reused) continue;
          const before2 = inputsOf(git3, r.id);
          if (r.status !== "PASS" || !before2) {
            drop.push(r.id);
            continue;
          }
          if (sessionEdits || inputsOf(now, r.id) !== before2) continue;
          set[r.id] = {
            cmd: check.cmd,
            cwd: check.cwd ?? null,
            ignore: [...check.ignore],
            configHash: ch,
            inputs: before2,
            at: new Date(runStarted).toISOString(),
            tree: git3.tree,
            durationMs: r.durationMs,
            ...r.summary ? { summary: r.summary } : {}
          };
        }
        try {
          updatePasses(root, set, drop);
        } catch (err2) {
          warnings.push(`passes could not be recorded: ${err2.message}`);
        }
      }
      try {
        receipt = writeReceipt(root, {
          status: ok ? "PASS" : "FAIL",
          profile: ok && fullRan ? "full" : "lite",
          head: after.head,
          branch: after.branch,
          tree: after.tree,
          treeBefore: git3.tree,
          startedAt: new Date(runStarted).toISOString(),
          dirtyFiles: after.dirtyFiles,
          configHash: ch,
          checks: ran,
          claim,
          host: opts.host ?? null,
          integrity: integrity ? { findings: integrity.findings, summary: integrity.summary, base: opts.base ?? "HEAD" } : null
        });
      } catch (err2) {
        warnings.push(`receipt could not be written: ${err2.message}`);
      }
    }
    return { ...base, ok, ran, skipped, receipt, cached: false, durationMs: Date.now() - started, lock: lockInfo };
  } finally {
    lock?.release();
  }
}

// src/init.ts
var DEFAULT_HOOK_TIMEOUT_S = 600;
var EDIT_HOOK_TIMEOUT_S = 30;
var HOOK_MARGIN_S = 60;
var PACKAGE_NAME = "@aivolution/isitdone";
function defaultCommand(host) {
  return `npx -y ${PACKAGE_NAME} hook --host ${host.name}`;
}
function editCommand(stopCommand) {
  return `${stopCommand} --event edit`;
}
function readSettings(path) {
  if (!existsSync7(path)) return {};
  const text = readFileSync5(path, "utf8");
  if (stripBom(text).trim() === "") return {};
  try {
    const v = readJsonFile(path);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("top level is not an object");
    return v;
  } catch (err2) {
    throw new Error(`${path} is not valid JSON (${err2.message}); fix it or move it aside and re-run`);
  }
}
function writeSettings(path, settings) {
  mkdirSync4(dirname3(path), { recursive: true });
  writeFileSync4(path, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8" });
}
function readText2(path) {
  return existsSync7(path) ? readFileSync5(path, "utf8") : null;
}
function ensureGitignore(root) {
  if (!existsSync7(join10(root, ".git"))) return "skipped";
  const p = join10(root, ".gitignore");
  const existing = existsSync7(p) ? readFileSync5(p, "utf8") : "";
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === `${RECEIPT_DIR}/` || l === RECEIPT_DIR || l === `/${RECEIPT_DIR}` || l === `/${RECEIPT_DIR}/`)) return "present";
  const sep3 = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync4(p, `${existing}${sep3}${RECEIPT_DIR}/
`);
  return "added";
}
function resolveHosts(root, hosts, scope) {
  const supported = (h) => hostScopes(h).includes(scope);
  const scopeNote = (h) => `${h.displayName} reads hooks only from ${h.settingsPath(root, scope === "project" ? "user" : "project")}; re-run ${scope === "project" ? "with --user" : "without --user"}`;
  if (hosts === "all") return HOST_NAMES.map((n) => getHost(n)).map((host) => supported(host) ? { host, scope } : { host, scope, skip: scopeNote(host) });
  if (hosts === "auto") {
    const found = detectHosts(root, existsSync7).filter((f) => f.scope === scope).map((f) => ({ host: f.host, scope }));
    return found.length > 0 ? found : [{ host: getHost("claude"), scope }];
  }
  return hosts.map((n) => {
    const host = getHost(n);
    if (!supported(host)) throw new Error(scopeNote(host));
    return { host, scope };
  });
}
function recommendedTimeout(root) {
  try {
    const { config } = loadConfig(root);
    const d = detectChecks(root, config);
    return Math.max(DEFAULT_HOOK_TIMEOUT_S, Math.ceil(budgetSeconds(d.checks, config) + HOOK_MARGIN_S));
  } catch {
    return DEFAULT_HOOK_TIMEOUT_S;
  }
}
function coveredBy(host, root, scope) {
  if (!host.coveredBy) return null;
  const other = getHost(host.coveredBy);
  const otherPath = other.settingsPath(root, scope);
  if (!existsSync7(otherPath)) return null;
  let cmd;
  try {
    cmd = other.registered(readSettings(otherPath), scope);
  } catch {
    return null;
  }
  if (!cmd) return null;
  return `${host.displayName} also loads ${otherPath}, which already runs "${cmd}"; a second registration would run the checks twice. Uninstall the ${other.displayName} hook first if you want a native ${host.displayName} entry.`;
}
var DELETE_WHEN_EMPTY = /* @__PURE__ */ new Set(["copilot", "droid"]);
var WRAPPER_MARK = "isitdone wrapper";
function wrapperCommand(host, root, scope, command) {
  const dir2 = join10(dirname3(host.settingsPath(root, scope)), "hooks");
  mkdirSync4(dir2, { recursive: true });
  const sh = join10(dir2, "isitdone-hook.sh");
  const cmd = join10(dir2, "isitdone-hook.cmd");
  writeFileSync4(sh, `#!/bin/sh
# ${WRAPPER_MARK}: ${host.displayName} runs script files, not command lines
exec ${command} "$@"
`, { encoding: "utf8", mode: 493 });
  try {
    chmodSync(sh, 493);
  } catch {
  }
  writeFileSync4(cmd, `@echo off\r
rem ${WRAPPER_MARK}: ${host.displayName} runs script files, not command lines\r
${command} %*\r
`, "utf8");
  const chosen = process.platform === "win32" ? cmd : sh;
  return scope === "project" ? relative2(root, chosen) : chosen;
}
function removeWrappers(settingsPath) {
  for (const name of ["isitdone-hook.sh", "isitdone-hook.cmd"]) {
    const p = join10(dirname3(settingsPath), "hooks", name);
    try {
      if (existsSync7(p) && readFileSync5(p, "utf8").includes(WRAPPER_MARK)) rmSync4(p, { force: true });
    } catch {
    }
  }
}
function alreadyRegistered(host, path, scope) {
  if (host.kind !== "json" || !existsSync7(path)) return false;
  try {
    return host.registered(readSettings(path), scope) !== null;
  } catch {
    return false;
  }
}
function init(opts) {
  const results = [];
  const timeout = Math.ceil(opts.timeout ?? recommendedTimeout(opts.root));
  if (!(timeout > 0)) throw new Error("timeout must be a positive number of seconds");
  const wantEdit = opts.editHook ?? true;
  if (opts.remove) {
    const targets = installedHooks(opts.root).filter((h) => opts.hosts === "auto" || opts.hosts === "all" || opts.hosts.includes(h.host.name));
    if (targets.length === 0) {
      const named = opts.hosts === "all" || opts.hosts === "auto" ? resolveHosts(opts.root, opts.hosts, opts.scope) : opts.hosts.map((n) => {
        const host = getHost(n);
        const scopes = hostScopes(host);
        return { host, scope: scopes.includes(opts.scope) ? opts.scope : scopes[0] };
      });
      for (const { host, scope } of named) {
        results.push({ host: host.name, displayName: host.displayName, event: "stop", hostEvent: host.event, path: host.settingsPath(opts.root, scope), scope, action: "absent", command: "", timeout, note: null });
      }
      return results;
    }
    const seen = /* @__PURE__ */ new Set();
    for (const t of targets) {
      const key = `${t.host.name}:${t.scope}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = { host: t.host.name, displayName: t.host.displayName, path: t.path, scope: t.scope, timeout, note: null };
      if (t.host.kind === "file" && t.host.file) {
        const text = readText2(t.path);
        const parsed = text === null ? null : t.host.file.parse(text);
        if (parsed) rmSync4(t.path, { force: true });
        results.push({ ...base, event: "stop", hostEvent: t.host.event, action: parsed ? "removed" : "absent", command: parsed?.stopCommand ?? "" });
        if (t.host.edit && parsed?.editCommand) results.push({ ...base, event: "edit", hostEvent: t.host.edit.event, action: "removed", command: parsed.editCommand, timeout: EDIT_HOOK_TIMEOUT_S });
        continue;
      }
      const settings = readSettings(t.path);
      const stopBefore = t.host.registered(settings, t.scope);
      const editBefore = t.host.edit?.registered(settings, t.scope) ?? null;
      const changedStop = t.host.unregister(settings, t.scope);
      const changedEdit = t.host.edit ? t.host.edit.unregister(settings, t.scope) : false;
      if (changedStop || changedEdit) {
        const leftover = Object.keys(settings).filter((k) => !(k === "version" && Object.keys(settings).length === 1));
        if (leftover.length === 0 && DELETE_WHEN_EMPTY.has(t.host.name)) rmSync4(t.path, { force: true });
        else writeSettings(t.path, settings);
      }
      if (t.host.scriptOnly) removeWrappers(t.path);
      results.push({ ...base, event: "stop", hostEvent: t.host.event, action: changedStop ? "removed" : "absent", command: stopBefore ?? "" });
      if (t.host.edit && editBefore) results.push({ ...base, event: "edit", hostEvent: t.host.edit.event, action: changedEdit ? "removed" : "absent", command: editBefore, timeout: EDIT_HOOK_TIMEOUT_S });
    }
    return results;
  }
  for (const { host, scope, skip } of resolveHosts(opts.root, opts.hosts, opts.scope)) {
    const path = host.settingsPath(opts.root, scope);
    const command = (opts.command ?? defaultCommand)(host);
    const base = { host: host.name, displayName: host.displayName, path, scope, timeout };
    const registerCommand = host.scriptOnly ? wrapperCommand(host, opts.root, scope, command) : command;
    const skipped = skip ?? (alreadyRegistered(host, path, scope) ? null : coveredBy(host, opts.root, scope));
    if (skipped) {
      results.push({ ...base, event: "stop", hostEvent: host.event, action: "skipped", command, note: skipped });
      continue;
    }
    if (host.kind === "file" && host.file) {
      const before = readText2(path);
      const prev = before === null ? null : host.file.parse(before);
      if (before !== null && prev === null) {
        results.push({ ...base, event: "stop", hostEvent: host.event, action: "skipped", command, note: `${path} exists but was not generated by isitdone; move it aside and re-run` });
        continue;
      }
      const edit = host.edit && (wantEdit || prev?.editCommand) ? editCommand(command) : null;
      const rendered = host.file.render(command, edit, timeout, EDIT_HOOK_TIMEOUT_S);
      const changed = before !== rendered;
      if (changed) {
        mkdirSync4(dirname3(path), { recursive: true });
        writeFileSync4(path, rendered, { encoding: "utf8" });
      }
      results.push({ ...base, event: "stop", hostEvent: host.event, action: !changed ? "unchanged" : prev?.stopCommand ? "updated" : "added", command, note: host.postInstallNote });
      if (edit && host.edit) results.push({ ...base, event: "edit", hostEvent: host.edit.event, action: !changed ? "unchanged" : prev?.editCommand ? "updated" : "added", command: edit, timeout: EDIT_HOOK_TIMEOUT_S, note: null });
      continue;
    }
    const settings = readSettings(path);
    const stopBefore = host.registered(settings, scope);
    const changedStop = host.register(settings, registerCommand, timeout, scope);
    let changedEdit = false;
    let editBefore = null;
    if (wantEdit && host.edit) {
      editBefore = host.edit.registered(settings, scope);
      changedEdit = host.edit.register(settings, editCommand(command), EDIT_HOOK_TIMEOUT_S, scope);
    }
    if (changedStop || changedEdit) writeSettings(path, settings);
    const devinNote = host.name === "claude" && alreadyRegistered(getHost("devin"), getHost("devin").settingsPath(opts.root, scope), scope) ? ` ${getHost("devin").settingsPath(opts.root, scope)} also registers isitdone natively; Devin loads both, so uninstall one of them (npx isitdone uninstall --agent devin).` : "";
    results.push({ ...base, event: "stop", hostEvent: host.event, action: !changedStop ? "unchanged" : stopBefore ? "updated" : "added", command: registerCommand, note: devinNote ? (host.postInstallNote ?? "") + devinNote : host.postInstallNote });
    if (wantEdit && host.edit) {
      results.push({ ...base, event: "edit", hostEvent: host.edit.event, action: !changedEdit ? "unchanged" : editBefore ? "updated" : "added", command: editCommand(command), timeout: EDIT_HOOK_TIMEOUT_S, note: null });
    }
  }
  return results;
}
function installedHooks(root) {
  const out3 = [];
  for (const name of HOST_NAMES) {
    const host = getHost(name);
    for (const scope of hostScopes(host)) {
      const path = host.settingsPath(root, scope);
      if (!existsSync7(path)) continue;
      if (host.kind === "file" && host.file) {
        const p = host.file.parse(readText2(path) ?? "");
        if (!p?.stopCommand) continue;
        out3.push({ host, event: "stop", scope, path, command: p.stopCommand, timeout: p.timeoutSeconds });
        if (host.edit && p.editCommand) out3.push({ host, event: "edit", scope, path, command: p.editCommand, timeout: EDIT_HOOK_TIMEOUT_S });
        continue;
      }
      let settings;
      try {
        settings = readSettings(path);
      } catch {
        continue;
      }
      const stop = host.registered(settings, scope);
      if (stop) out3.push({ host, event: "stop", scope, path, command: stop, timeout: registeredTimeout(settings, stop, host) });
      const edit = host.edit?.registered(settings, scope) ?? null;
      if (edit) out3.push({ host, event: "edit", scope, path, command: edit, timeout: registeredTimeout(settings, edit, host) });
    }
  }
  return out3;
}
function pluginHooks(root) {
  const out3 = [];
  let claudeDir;
  try {
    claudeDir = join10(homedir2(), ".claude");
  } catch {
    return out3;
  }
  const files = /* @__PURE__ */ new Set();
  try {
    for (const e of readdirSync5(join10(claudeDir, "skills"), { withFileTypes: true })) {
      const dir2 = join10(claudeDir, "skills", e.name);
      if (e.isDirectory() && existsSync7(join10(dir2, ".claude-plugin", "plugin.json"))) files.add(join10(dir2, "hooks", "hooks.json"));
    }
  } catch {
  }
  const enabled = /* @__PURE__ */ new Map();
  for (const f of [join10(claudeDir, "settings.json"), ...root ? [join10(root, ".claude", "settings.json"), join10(root, ".claude", "settings.local.json")] : []]) {
    const s = tryReadJsonFile(f);
    for (const [id2, on] of Object.entries(s?.enabledPlugins ?? {})) if (typeof on === "boolean") enabled.set(id2, on);
  }
  const fold = (p) => process.platform === "win32" || process.platform === "darwin" ? resolve3(p).toLowerCase() : resolve3(p);
  const installed = tryReadJsonFile(join10(claudeDir, "plugins", "installed_plugins.json"));
  for (const [id2, entry] of Object.entries(installed?.plugins ?? {})) {
    if (enabled.get(id2) === false) continue;
    for (const p of Array.isArray(entry) ? entry : [entry]) {
      const { installPath, projectPath } = p ?? {};
      if (typeof installPath !== "string") continue;
      if (typeof projectPath === "string" && (!root || !(fold(root) + sep2).startsWith(fold(projectPath) + sep2))) continue;
      files.add(join10(installPath, "hooks", "hooks.json"));
    }
  }
  const host = getHost("claude");
  for (const path of files) {
    if (!existsSync7(path)) continue;
    let settings;
    try {
      settings = readSettings(path);
    } catch {
      continue;
    }
    const stop = host.registered(settings, "user");
    const pluginRoot = dirname3(dirname3(path));
    if (stop) out3.push({ host, event: "stop", scope: "plugin", path, command: stop, timeout: registeredTimeout(settings, stop, host), pluginRoot });
    const edit = host.edit?.registered(settings, "user") ?? null;
    if (edit) out3.push({ host, event: "edit", scope: "plugin", path, command: edit, timeout: registeredTimeout(settings, edit, host), pluginRoot });
  }
  return out3;
}
function registeredTimeout(settings, command, host) {
  const text = JSON.stringify(settings);
  const idx = text.indexOf(JSON.stringify(command));
  if (idx < 0) return null;
  const m = /"timeout(?:Sec)?"\s*:\s*(\d+(?:\.\d+)?)/.exec(text.slice(idx, idx + 400));
  if (!m) return null;
  const n = Number(m[1]);
  return host.msTimeouts ? n / 1e3 : n;
}

// src/pause.ts
import { createHash as createHash4 } from "node:crypto";
import { readdirSync as readdirSync6, rmSync as rmSync5 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join11 } from "node:path";
var PAUSES_DIR = "pauses";
var GLOBAL_PAUSE = "global.json";
var DEFAULT_PAUSE_MS = 60 * 60 * 1e3;
var MAX_PAUSE_MS = 30 * 24 * 60 * 60 * 1e3;
function pausesDir() {
  try {
    const home = homedir3();
    return home ? join11(home, RECEIPT_DIR, PAUSES_DIR) : null;
  } catch {
    return null;
  }
}
function repoPauseKey(cwd) {
  const common = gitCommonDir(cwd);
  if (!common) return null;
  const norm = process.platform === "win32" || process.platform === "darwin" ? common.toLowerCase() : common;
  return createHash4("sha1").update(norm).digest("hex").slice(0, 16);
}
function pauseLookup(cwd) {
  let key;
  return () => {
    const dir2 = pausesDir();
    if (!dir2) return { global: null, repo: null };
    let anyRepo = false;
    try {
      anyRepo = readdirSync6(dir2).some((e) => e.startsWith("repo-"));
    } catch {
    }
    if (anyRepo && key === void 0) key = cwd ? repoPauseKey(cwd) : null;
    return { global: join11(dir2, GLOBAL_PAUSE), repo: anyRepo && key ? join11(dir2, `repo-${key}.json`) : null };
  };
}
function pauseFiles(cwd) {
  return pauseLookup(cwd)();
}
function pruneExpired(dir2, now) {
  try {
    for (const e of readdirSync6(dir2)) {
      if (e.startsWith("repo-") && e.endsWith(".json") && readPause(join11(dir2, e), "repo", now) === null) rmSync5(join11(dir2, e), { force: true });
    }
  } catch {
  }
}
function readPause(file, scope, now) {
  if (!file) return null;
  const p = tryReadJsonFile(file);
  if (!p || typeof p !== "object" || Array.isArray(p) || typeof p.until !== "string") return null;
  const untilMs = Date.parse(p.until);
  if (!Number.isFinite(untilMs) || untilMs <= now || untilMs - now > MAX_PAUSE_MS) return null;
  return {
    until: new Date(untilMs).toISOString(),
    createdAt: typeof p.createdAt === "string" ? p.createdAt : "",
    scope,
    repo: typeof p.repo === "string" ? p.repo : void 0,
    version: typeof p.version === "string" ? p.version : "",
    file,
    untilMs
  };
}
function activePause(files, now = Date.now()) {
  try {
    const found = [readPause(files.repo, "repo", now), readPause(files.global, "global", now)].filter((p) => p !== null);
    return found.sort((a, b) => b.untilMs - a.untilMs)[0] ?? null;
  } catch {
    return null;
  }
}
function writePause(scope, cwd, untilMs, version, now = Date.now(), repo) {
  const dir2 = pausesDir();
  if (!dir2) throw new Error("the home directory cannot be resolved, so there is nowhere to keep a pause");
  let file = join11(dir2, GLOBAL_PAUSE);
  if (scope === "repo") {
    const key = cwd ? repoPauseKey(cwd) : null;
    if (!key) throw new Error("not inside a git repository");
    file = join11(dir2, `repo-${key}.json`);
  }
  const rec = { until: new Date(untilMs).toISOString(), createdAt: new Date(now).toISOString(), scope, ...scope === "repo" && repo ? { repo } : {}, version };
  writeFileAtomic(file, JSON.stringify(rec, null, 2) + "\n");
  pruneExpired(dir2, now);
  return { ...rec, file, untilMs };
}
function clearPause(file, scope, now = Date.now()) {
  const dir2 = pausesDir();
  if (dir2) pruneExpired(dir2, now);
  if (!file) return null;
  const p = readPause(file, scope, now);
  rmSync5(file, { force: true });
  return p;
}
var AGENT_SHELL_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "AI_AGENT",
  "CODEX_THREAD_ID",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "QWEN_CODE"
];
function isAgentShell(env = process.env) {
  return AGENT_SHELL_MARKERS.some((v) => env[v] !== void 0);
}
function parseDuration(v) {
  const m = /^(\d+)\s*(m|min|h|d|w)$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit === "m" || unit === "min" ? 6e4 : unit === "h" ? 36e5 : unit === "d" ? 864e5 : 7 * 864e5;
  return n > 0 ? n * ms : null;
}
function parseUntil(v) {
  const t = v.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:([T ])(.+))?$/.exec(t);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  const ms = m[4] === void 0 ? new Date(y, mo - 1, d, 23, 59, 59, 999).getTime() : Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[5]}`);
  return Number.isFinite(ms) ? ms : null;
}
var two = (n) => String(n).padStart(2, "0");
function formatPauseTime(ms) {
  const d = new Date(ms);
  const utcDate = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const localDate = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  const utc = `${utcDate} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
  if (d.getTimezoneOffset() === 0) return utc;
  return `${utc} (${localDate === utcDate ? "" : localDate + " "}${two(d.getHours())}:${two(d.getMinutes())} local)`;
}
function formatSpan(ms) {
  const min = Math.floor(ms / 6e4);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const days = Math.floor(h / 24);
  return h % 24 ? `${days} d ${h % 24} h` : `${days} d`;
}
function describePause(p, now = Date.now()) {
  return `${p.scope === "global" ? "for every repository of this user" : "in this repository"} until ${formatPauseTime(p.untilMs)} (${formatSpan(p.untilMs - now)} from now)`;
}

// src/update.ts
import { spawnSync as spawnSync5 } from "node:child_process";
import { existsSync as existsSync9, readdirSync as readdirSync7, rmSync as rmSync7 } from "node:fs";
import { homedir as homedir5, tmpdir as tmpdir2 } from "node:os";
import { join as join13 } from "node:path";

// src/localcopy.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync5, readFileSync as readFileSync6, renameSync as renameSync2, rmSync as rmSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { basename, dirname as dirname4, join as join12 } from "node:path";
import { fileURLToPath } from "node:url";
function localCopyPath() {
  try {
    const home = homedir4();
    return home ? join12(home, RECEIPT_DIR, "bin", "isitdone.js") : null;
  } catch {
    return null;
  }
}
function ownBundle() {
  try {
    const p = fileURLToPath(import.meta.url);
    return basename(p) === "isitdone.js" && existsSync8(p) ? p : null;
  } catch {
    return null;
  }
}
function bundleVersion(file) {
  if (!existsSync8(file)) return null;
  const r = spawnSync4(process.execPath, [file, "--version"], { encoding: "utf8", windowsHide: true, timeout: 15e3, env: { ...process.env, NO_COLOR: "1" } });
  return r.status === 0 ? /(\d+\.\d+\.\d+\S*)\s*$/.exec((r.stdout ?? "").trim())?.[1] ?? null : null;
}
function installLocalCopy(source = ownBundle(), sourceVersion = VERSION) {
  const path = localCopyPath();
  if (!path) return { path: null, version: null, action: "unavailable", note: "the home directory cannot be resolved" };
  if (!source) return { path, version: null, action: "unavailable", note: "this isitdone does not run from its published bundle, so there is nothing to copy" };
  if (/["$%`!]/.test(path)) return { path, version: null, action: "unavailable", note: `${path} has a character that shells expand ($, %, !, \` or a quote)` };
  const dir2 = dirname4(path);
  const installed = existsSync8(path) ? bundleVersion(path) : null;
  if (installed && !isNewer(sourceVersion, installed)) return { path, version: installed, action: "unchanged", note: null };
  const tmp = join12(dir2, `isitdone.${process.pid}.${Date.now()}.tmp.js`);
  try {
    mkdirSync5(dir2, { recursive: true });
    writeFileSync5(join12(dir2, "package.json"), '{\n  "type": "module"\n}\n');
    writeFileSync5(tmp, readFileSync6(source, "utf8"));
    const answered = bundleVersion(tmp);
    if (answered !== sourceVersion) {
      rmSync6(tmp, { force: true });
      return { path, version: installed, action: "unavailable", note: `the new copy does not run here (it reported ${answered ?? "nothing"}); ${installed ? `kept ${installed}` : "nothing installed"}` };
    }
    renameWithRetry(tmp, path);
  } catch (e) {
    rmSync6(tmp, { force: true });
    return { path, version: installed, action: "unavailable", note: `could not replace ${path}: ${e.message}${installed ? `; kept ${installed}` : ""}` };
  }
  return { path, version: sourceVersion, action: installed ? "updated" : "installed", note: null };
}
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      renameSync2(from, to);
      return;
    } catch (e) {
      if (i >= 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}
function directCommand(path, hostName) {
  return `node "${path.replace(/\\/g, "/")}" hook --host ${hostName}`;
}

// src/update.ts
var OUR_PACKAGES = [PACKAGE_NAME, "isitdone"];
function npm(args, timeoutMs = 2e4) {
  const r = spawnSync5(`npm ${args.join(" ")}`, { encoding: "utf8", windowsHide: true, timeout: timeoutMs, shell: true, cwd: tmpdir2() });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}
function npmCacheDir(env = process.env) {
  if (env.npm_config_cache) return env.npm_config_cache;
  const r = npm(["config", "get", "cache"]);
  if (r.ok && r.out && r.out !== "undefined") return r.out;
  if (process.platform === "win32" && env.LOCALAPPDATA) return join13(env.LOCALAPPDATA, "npm-cache");
  return join13(homedir5(), ".npm");
}
function findNpxEntries(cacheDir, packages = OUR_PACKAGES) {
  const npx = join13(cacheDir, "_npx");
  if (!existsSync9(npx)) return [];
  const out3 = [];
  for (const e of readdirSync7(npx)) {
    const dir2 = join13(npx, e);
    const pkg = tryReadJsonFile(join13(dir2, "package.json"));
    const deps = Object.keys(pkg?.dependencies ?? {});
    if (deps.some((d) => packages.includes(d))) out3.push(dir2);
  }
  return out3;
}
function latestVersion(timeoutMs = 8e3) {
  const r = npm(["view", PACKAGE_NAME, "version"], timeoutMs);
  return r.ok && /^\d+\.\d+\.\d+/.test(r.out) ? r.out : null;
}
function isNewer(candidate, current) {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
function runUpdate(opts = {}) {
  const cacheDir = opts.cacheDir === void 0 ? npmCacheDir() : opts.cacheDir;
  const result = { cacheDir, removed: [], warmed: [], latest: latestVersion(), running: VERSION, localCopy: null };
  if (opts.checkOnly) return result;
  if (cacheDir) {
    for (const dir2 of findNpxEntries(cacheDir)) {
      try {
        rmSync7(dir2, { recursive: true, force: true, maxRetries: 3 });
        result.removed.push(dir2);
      } catch {
      }
    }
  }
  if (opts.warm ?? true) {
    for (const pkg of OUR_PACKAGES) {
      const r = spawnSync5(`npx -y ${pkg} --version`, { encoding: "utf8", shell: true, windowsHide: true, timeout: 12e4, cwd: tmpdir2(), env: { ...process.env, NO_COLOR: "1" } });
      const version = /(\d+\.\d+\.\d+)\s*$/.exec((r.stdout ?? "").trim())?.[1] ?? null;
      result.warmed.push({ pkg, version, error: r.status === 0 && version ? null : (r.stderr ?? "").trim().split("\n").slice(-1)[0] || "npx failed" });
    }
  }
  result.localCopy = refreshLocalCopy(cacheDir);
  return result;
}
function refreshLocalCopy(cacheDir) {
  const path = localCopyPath();
  if (!path || !existsSync9(path)) return null;
  let best = null;
  const own = ownBundle();
  if (own) best = { file: own, version: VERSION };
  for (const dir2 of cacheDir ? findNpxEntries(cacheDir) : []) {
    const pkgDir = join13(dir2, "node_modules", "@aivolution", "isitdone");
    const version = tryReadJsonFile(join13(pkgDir, "package.json"))?.version;
    const file = join13(pkgDir, "dist", "isitdone.js");
    if (typeof version === "string" && existsSync9(file) && (!best || isNewer(version, best.version))) best = { file, version };
  }
  if (!best) return { path, action: "unchanged", version: null };
  const r = installLocalCopy(best.file, best.version);
  return { path, action: r.action, version: r.version };
}

// src/doctor.ts
function probeHook(command, host, root, timeoutMs, message = "Done. All tests pass and the feature is complete.") {
  const started = Date.now();
  return new Promise((resolve7) => {
    const env = childEnv();
    delete env.ISITDONE;
    env.ISITDONE_DOCTOR = "1";
    const child = spawn2(command, {
      cwd: root,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
      }
      resolve7({ exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };
    child.stdout?.on("data", (d) => stdout += d.toString("utf8"));
    child.stderr?.on("data", (d) => stderr += d.toString("utf8"));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killTree(child.pid);
      setTimeout(() => finish(null), 2e3);
    }, timeoutMs);
    child.on("error", (err2) => {
      stderr += err2.message;
      finish(null);
    });
    child.on("exit", (code) => setTimeout(() => finish(code), 300));
    child.on("close", (code) => finish(code));
    child.stdin?.end(JSON.stringify(host.synthetic(root, message)));
  });
}
function looksBlocked(host, probe) {
  if (probe.exitCode === 2 && probe.stderr.trim() !== "") return { blocked: true, reason: "exit 2 with stderr" };
  const text = probe.stdout.trim();
  if (!text.startsWith("{")) return { blocked: false, reason: text === "" ? "no output" : `non-JSON stdout: ${text.slice(0, 80)}` };
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { blocked: false, reason: "stdout is not valid JSON" };
  }
  if (host.name === "cursor") return typeof json.followup_message === "string" && json.followup_message !== "" ? { blocked: true, reason: "followup_message present" } : { blocked: false, reason: "no followup_message" };
  if (host.name === "gemini") return json.decision === "deny" || json.decision === "block" ? { blocked: true, reason: `decision ${String(json.decision)}` } : { blocked: false, reason: "decision is not deny" };
  if (host.name === "augment") {
    const nested = json.hookSpecificOutput ?? {};
    return nested.decision === "block" && typeof nested.reason === "string" && nested.reason !== "" ? { blocked: true, reason: "hookSpecificOutput.decision block with reason" } : { blocked: false, reason: "no nested block decision" };
  }
  return json.decision === "block" && typeof json.reason === "string" && json.reason !== "" ? { blocked: true, reason: "decision block with reason" } : { blocked: false, reason: "decision is not block" };
}
function gitignoreCoversState(root) {
  const own = join14(root, ".isitdone", ".gitignore");
  if (existsSync10(own) && readFileSync7(own, "utf8").trim() === "*") return true;
  const gi = join14(root, ".gitignore");
  if (!existsSync10(gi)) return false;
  return readFileSync7(gi, "utf8").split(/\r?\n/).some((l) => /^\/?\.isitdone\/?$/.test(l.trim()));
}
async function doctor(opts) {
  const checks = [];
  const root = opts.root;
  const probeTimeout = opts.probeTimeoutMs ?? 9e4;
  const git3 = gitInfo(root);
  if (!git3.isRepo) {
    checks.push({ name: "git", ok: false, detail: "not a git repository", hint: "isitdone binds receipts to the git tree; without git every receipt is STALE and nothing is cached." });
  } else if (git3.tree === "unknown") {
    checks.push({ name: "git", ok: false, detail: `working tree could not be hashed: ${git3.treeError ?? "unknown git error"}`, hint: "receipts cannot be cached until this is fixed; the checks still run." });
  } else {
    checks.push({ name: "git", ok: true, detail: `${git3.branch ?? "detached"}@${git3.headShort ?? "no commits"}, ${git3.dirtyFiles} dirty file(s), tree ${git3.tree.slice(0, 7)}` });
  }
  const pause = activePause(pauseFiles(git3.isRepo ? git3.root : root));
  if (pause) checks.push({ name: "note:pause", ok: true, detail: `the Stop hook is paused ${describePause(pause)}: agents' stops go through without running the checks (${pause.file}); \`npx isitdone resume${pause.scope === "global" ? " --global" : ""}\` ends it` });
  let config = {};
  let configSource = null;
  try {
    const loaded = loadConfig(root);
    config = loaded.config;
    configSource = loaded.source;
    checks.push({ name: "config", ok: true, detail: configSource ? `loaded ${configSource}` : "no .isitdone.json (auto-detect only)" });
  } catch (err2) {
    checks.push({ name: "config", ok: false, detail: err2.message });
  }
  const detection = detectChecks(root, config);
  if (detection.checks.length === 0) {
    checks.push({ name: "checks", ok: false, detail: "no checks detected", hint: "add scripts to package.json or define checks in .isitdone.json; until then the hook allows every stop." });
  } else {
    const lines = detection.checks.map((c) => `${c.id}: ${c.cmd} [${c.kind}, ${timeoutFor(c, config) / 1e3}s]`);
    checks.push({ name: "checks", ok: true, detail: lines.join("; ") });
  }
  for (const n of detection.notes) checks.push({ name: "note", ok: true, detail: n });
  if ((opts.baseline ?? true) && detection.checks.length > 0) {
    const res = await verify({
      root,
      config: { ...config, integrity: "off" },
      profile: "full",
      all: true,
      useCache: true,
      dryRun: true,
      host: "doctor",
      lockWaitMs: config.otherSessions === "ignore" ? 0 : LOCK_WAIT_MS,
      onCheckStart: opts.onCheckStart,
      onCheckDone: opts.onCheckDone
    });
    const failed = res.ran.filter((r) => r.status !== "PASS");
    if (res.cached && res.receipt) {
      checks.push({ name: "baseline", ok: true, detail: `a PASS receipt from ${res.receipt.createdAt} already proves the current tree (${res.receipt.checks.length} check${res.receipt.checks.length === 1 ? "" : "s"})` });
    } else if (failed.length === 0) {
      checks.push({ name: "baseline", ok: true, detail: `all ${res.ran.length} check${res.ran.length === 1 ? "" : "s"} pass on the current tree (${res.ran.map((r) => `${r.cmd} ${formatDuration(r.durationMs)}`).join(", ")})` });
    } else {
      for (const r of failed) {
        const source = detection.checks.find((c) => c.id === r.id)?.source;
        const tail = r.tail.slice(-3).map((l) => l.trim()).filter((l) => l !== "").join(" | ");
        if (r.status === "TIMEOUT") {
          checks.push({
            name: `baseline:${r.id}`,
            ok: false,
            detail: `${r.cmd} TIMES OUT on the current tree before any agent edit${source ? ` (detected from ${source})` : ""}: killed after ${formatDuration(r.timeoutMs)}${tail ? ` | ${tail}` : ""}`,
            hint: `the hook would report NOT DONE on every stop. If the check is legitimately slow, raise "timeout" (or "liteTimeout") in .isitdone.json; if it hangs (watch mode, a prompt), set the right command there instead.`
          });
        } else {
          const why = r.status === "ERROR" ? `could not start${r.tail[0] ? `: ${r.tail[0].trim()}` : ""}` : `exit ${r.exitCode ?? "?"}${r.summary ? `: ${r.summary}` : ""}`;
          checks.push({
            name: `baseline:${r.id}`,
            ok: false,
            detail: `${r.cmd} FAILS on the current tree before any agent edit${source ? ` (detected from ${source})` : ""}: ${why}${tail && !r.summary ? ` | ${tail}` : ""}`,
            hint: `the hook would report NOT DONE on every stop. If this command is wrong for the repo, put the right one in .isitdone.json: {"checks": {"${r.id}": "<command>"}} (or false to drop the check); if the tree is really broken, fix it, then run \`npx isitdone\`.`
          });
        }
      }
    }
    for (const w of res.warnings) checks.push({ name: "note", ok: true, detail: w });
  }
  const hooks = [...installedHooks(root), ...pluginHooks(root)];
  if (!hooks.some((h) => h.event === "stop")) {
    checks.push({ name: "hooks", ok: false, detail: "no isitdone hook installed", hint: `run \`npx isitdone init\` (add --agent <name>|all for other hosts: ${HOST_NAMES.filter((n) => n !== "claude").join(", ")}).` });
  }
  const budget = budgetSeconds(detection.checks, config);
  for (const h of hooks) {
    if (h.event === "edit") {
      checks.push({ name: `edit-hook:${h.host.name}`, ok: true, detail: `${h.host.displayName} ${h.host.edit?.event ?? ""} (${h.scope}) -> ${h.command}` });
      continue;
    }
    checks.push({ name: `hook:${h.host.name}`, ok: true, detail: `${h.host.displayName} (${h.scope}) ${h.path} -> ${h.command}` });
    if (h.timeout !== null && budget + HOOK_MARGIN_S > h.timeout) {
      checks.push({
        name: `timeout:${h.host.name}`,
        ok: false,
        detail: `the checks may run for up to ${budget}s, but ${h.host.displayName} stops this hook after ${h.timeout}s: a run that long is cut off, nothing is verified, and the stop goes through`,
        hint: `lower the check timeouts in .isitdone.json so they add up to at most ${Math.max(0, h.timeout - HOOK_MARGIN_S)}s, or raise this hook's timeout to ${budget + HOOK_MARGIN_S}s (${h.scope === "plugin" ? h.path : "re-run `init`"}).`
      });
    }
    if (/(^|[\s"'])npx(\.cmd)?\s/.test(h.command)) {
      const instead = h.scope === "plugin" ? "the plugin's hooks.json sets that command; a hook from `npx isitdone init --user` runs a local copy with node instead (then remove the plugin's hook, or the checks run twice)" : "`npx isitdone init --user` (or --no-npx) registers a local copy that runs with node instead";
      checks.push({ name: `note:${h.host.name}`, ok: true, detail: `this hook starts isitdone through npx, which adds npm's start-up (about 1-2 s) to every stop and every edit; ${instead}` });
    }
    if (opts.probeHooks ?? true) {
      const probe = await probeHook(h.pluginRoot ? h.command.split("${CLAUDE_PLUGIN_ROOT}").join(h.pluginRoot) : h.command, h.host, root, probeTimeout);
      const verdict = looksBlocked(h.host, probe);
      if (verdict.blocked) {
        const hookVersion = /\[isitdone ([^\]\s]+)\]/.exec(probe.stdout + probe.stderr)?.[1] ?? null;
        checks.push({ name: `probe:${h.host.name}`, ok: true, detail: `synthetic "tests pass" stop was blocked in ${(probe.durationMs / 1e3).toFixed(1)}s (${verdict.reason})${hookVersion ? `, hook runs isitdone ${hookVersion}` : ""}` });
        if (hookVersion && hookVersion !== VERSION && isNewer(VERSION, hookVersion)) {
          checks.push({ name: `stale:${h.host.name}`, ok: false, detail: `the hook runs isitdone ${hookVersion} but this CLI is ${VERSION}`, hint: h.scope === "plugin" ? `the plugin in ${h.pluginRoot ?? h.path} carries that version; update the plugin (/plugin) and restart its sessions.` : "npx caches the hook package separately, and a local copy stays as it is; run `npx isitdone update` to refresh both." });
        }
      } else if (probe.timedOut) {
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not answer within ${probeTimeout / 1e3}s`, hint: "first npx run downloads the package; run `npx -y @aivolution/isitdone --version` once, or `npm i -D @aivolution/isitdone` so the hook resolves locally." });
      } else {
        const tail = (probe.stderr || probe.stdout).trim().split("\n").slice(-3).join(" | ");
        checks.push({ name: `probe:${h.host.name}`, ok: false, detail: `hook did not block (${verdict.reason}; exit ${probe.exitCode ?? "n/a"}) ${tail}`.trim(), hint: "check that the command in the settings file runs from a shell in this directory." });
      }
    }
    if (h.host.postInstallNote) checks.push({ name: `note:${h.host.name}`, ok: true, detail: h.host.postInstallNote });
  }
  if (git3.isRepo && !gitignoreCoversState(root)) {
    checks.push({ name: "gitignore", ok: false, detail: ".isitdone/ is not ignored by git", hint: 'receipts and keys are local state; `init` adds the rule, or add ".isitdone/" to .gitignore.' });
  }
  if (opts.checkLatest ?? true) {
    const latest = latestVersion();
    if (latest && isNewer(latest, VERSION)) {
      checks.push({ name: "version", ok: true, detail: `this is isitdone ${VERSION}; ${latest} is available (run \`npx isitdone update\`)` });
    }
  }
  return { ok: checks.every((c) => c.ok), checks, paused: pause ? { scope: pause.scope, until: pause.until, file: pause.file } : null };
}

// src/hook.ts
import { existsSync as existsSync12, readdirSync as readdirSync9, rmSync as rmSync9, statSync as statSync6 } from "node:fs";
import { join as join18 } from "node:path";

// src/claims.ts
var CLAIM_PATTERNS = [
  ["tests-pass", /\b(?:all\s+)?(?:\d+\s+)?(?:unit\s+|integration\s+|e2e\s+|existing\s+|new\s+)?tests?(?:\s+suites?)?\s+(?:are\s+|is\s+|now\s+|still\s+|all\s+|should\s+)*(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)\b/i],
  ["n-passed", /\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)\b/i],
  ["checks-green", /\b(?:the\s+)?(?:build|typecheck|type\s*check(?:ing)?|lint(?:er|ing)?|ci|pipeline|compil(?:e|ation)|checks?)\s+(?:is\s+|are\s+|now\s+|still\s+|all\s+)*(?:green|pass(?:es|ed|ing)?|clean|succeed(?:s|ed)?|successful)\b/i],
  ["everything-passes", /\b(?:everything|all\s+checks|all\s+of\s+the\s+above|the\s+suite)\s+(?:is\s+|are\s+|now\s+)*(?:pass(?:es|ing)?|green|working|good|clean)\b/i],
  ["all-green", /\b(?:all\s+green|good\s+to\s+go|green\s+across\s+the\s+board)\b/i],
  ["task-complete", /\b(?:task|work|implementation|feature|fix|refactor(?:ing)?|migration|change|changes|pr|pull\s+request|job|everything)s?\s+(?:is|are|has\s+been|have\s+been)\s+(?:now\s+)?(?:complete|completed|done|finished|ready|implemented|wrapped\s+up)\b/i],
  ["ready-for", /\bready\s+(?:for|to)\s+(?:review|merge|ship|deploy|release|test(?:ing)?|use)\b/i],
  ["done", /(?:^|[\s(])(?:all\s+)?done[.!:)]?(?:\s|$)/i],
  ["complete", /^\s*(?:complete|completed|finished|all\s+set|ready|that's\s+it|wrapped\s+up)\b/i],
  ["i-have-done", /\b(?:i(?:'ve|\s+have)\s+(?:now\s+|successfully\s+|also\s+)?)(?:implemented|completed|finished|fixed|resolved|addressed|verified|added|updated|refactored|migrated|wired(?:\s+up)?|integrated|removed|cleaned\s+up|written|created|built)\b/i],
  ["past-tense-summary", /^\s*(?:implemented|fixed|added|updated|refactored|migrated|completed|finished|resolved|removed|created|built)\b\s+(?:the|a|an|all|your|this|that|support|tests?|new)\b/i],
  ["successfully", /\bsuccessfully\s+(?:implemented|fixed|completed|added|updated|migrated|refactored|resolved|built|compiled|passed|verified|tested)\b/i],
  ["verified", /\b(?:verified|confirmed|double[-\s]checked)\s+(?:that\s+)?(?:it|this|the|everything|all|they)\b/i],
  ["works-now", /\b(?:should\s+(?:now\s+)?work|works\s+(?:now|as\s+expected|correctly|fine|end[-\s]to[-\s]end)|is\s+(?:now\s+)?working|are\s+(?:now\s+)?working|now\s+works)\b/i],
  ["no-errors", /\b(?:no|zero)\s+(?:more\s+|remaining\s+|new\s+)?(?:errors|failures|failing\s+tests|type\s+errors|lint\s+errors|issues|warnings)\b/i],
  ["passes-now", /\b(?:now\s+pass(?:es|ing)?|pass(?:es|ing)?\s+(?:now|locally|cleanly))\b/i]
];
var NEGATIONS = [
  /\b(?:not\s+yet|haven't|hasn't|isn't|aren't|don't|doesn't|didn't|cannot|can't|couldn't|won't|wouldn't|unable|have\s+not|has\s+not|is\s+not|are\s+not|do\s+not|does\s+not|did\s+not|will\s+not|could\s+not|failed\s+to|still\s+fail|still\s+failing|not\s+(?:yet\s+)?(?:done|complete|passing|working|verified)|no\s+longer)\b/i,
  /\b(?:i(?:'ll|\s+will)|let\s+me|going\s+to|next\s+(?:step|i|up)|todo|to\s+do|should\s+i|do\s+you\s+want|would\s+you\s+like|before\s+(?:i|we)\s+(?:can|mark|call)|once\s+you|if\s+you\s+want|remaining\s+work|still\s+(?:need|needs|to\s+do|todo))\b/i,
  /\?\s*$/
];
function splitSentences(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").split(/(?<=[.!?])\s+|\n+|(?<=:)\s+(?=[A-Z])/).map((s) => s.replace(/^[\s\-*#>•\d.)]+/, "").trim()).filter((s) => s.length > 0);
}
function findClaim(text, extraPatterns = []) {
  if (!text) return null;
  const extras = [];
  for (const p of extraPatterns) {
    try {
      extras.push([`custom:${p}`, new RegExp(p, "i")]);
    } catch {
    }
  }
  const patterns = [...CLAIM_PATTERNS, ...extras];
  const sentences = splitSentences(text).reverse();
  for (const sentence of sentences) {
    if (NEGATIONS.some((n) => n.test(sentence))) continue;
    for (const [name, re] of patterns) {
      if (re.test(sentence)) {
        return { sentence: sentence.length > 200 ? sentence.slice(0, 197) + "..." : sentence, pattern: name };
      }
    }
  }
  return null;
}

// src/editcheck.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { basename as basename2, dirname as dirname5, isAbsolute as isAbsolute2, join as join15, relative as relative3, resolve as resolve4 } from "node:path";
function toRepoPath(top, file, cwd = top) {
  let abs = isAbsolute2(file) ? file : resolve4(cwd, file);
  try {
    abs = realpathSync2.native(abs);
  } catch {
    try {
      abs = join15(realpathSync2.native(dirname5(abs)), basename2(abs));
    } catch {
    }
  }
  let base = top;
  try {
    base = realpathSync2.native(top);
  } catch {
  }
  return relative3(base, abs).replace(/\\/g, "/");
}
function insideRepo(path) {
  return path !== "" && !path.startsWith("..") && !isAbsolute2(path) && !/^[A-Za-z]:/.test(path) && !path.startsWith("//");
}
function checkEditedFile(cwd, file, base = "HEAD", diff, knownTop) {
  const top = knownTop ?? gitTopLevel(cwd);
  if (!top) return null;
  const path = toRepoPath(top, file, cwd);
  if (!insideRepo(path)) return null;
  const isScannable = (p) => isTestFile(p, [() => readNow(top, p), () => readAtBase(top, p, base)]) || isTestConfigFile(p);
  if (!isScannable(path)) return { path, report: null, notable: [], note: null };
  const d = diff ? diff() : collectDiff(top, base);
  if (d.error) return null;
  const mine = d.files.filter((f) => f.path === path || f.oldPath === path);
  if (mine.length === 0) return { path, report: null, notable: [], note: null };
  const others = (status) => d.files.filter((f) => f.status === status && !mine.includes(f) && isScannable(f.path));
  const files = [...mine, ...mine.some((f) => f.status === "deleted") ? others("added") : [], ...mine.some((f) => f.status === "added") ? others("deleted") : []];
  const report = scanIntegrity(files, { readBefore: (p) => readAtBase(top, p, base), readAfter: (p) => readNow(top, p) });
  const order2 = { critical: 0, high: 1, medium: 2, low: 3 };
  const notable = report.findings.filter((f) => !f.suppressed && order2[f.severity] <= order2.medium && mine.some((m) => m.path === f.file));
  return { path, report, notable, note: formatEditNote(path, report, notable) };
}
function formatEditNote(path, report, notable) {
  if (notable.length === 0) return null;
  const lines = [];
  const s = report.summary;
  const counts = report.testFiles > 0 ? ` (${formatSummaryLine(s)})` : "";
  lines.push(`isitdone: after your edit, ${path} has weaker tests than HEAD${counts}:`);
  for (const f of notable.slice(0, 5)) lines.push(`  - ${f.line ? `line ${f.line}: ` : ""}${f.message} [${f.severity}]`);
  if (notable.length > 5) lines.push(`  - ... ${notable.length - 5} more`);
  lines.push("If this is intentional, or the change was already there before your edit, tell the user why; otherwise restore the tests. The Stop hook will run the full checks before you can finish.");
  return lines.join("\n");
}

// src/gatelog.ts
import { appendFileSync as appendFileSync2, existsSync as existsSync11, readFileSync as readFileSync8, statSync as statSync4, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join16 } from "node:path";
var DECISIONS_FILE = "decisions.jsonl";
var MAX_BYTES = 512 * 1024;
function appendDecision(root, rec, opts = {}) {
  try {
    if (opts.create === false && !existsSync11(join16(root, RECEIPT_DIR))) return;
    const file = join16(ensureStateDir(root), DECISIONS_FILE);
    appendFileSync2(file, JSON.stringify(rec) + "\n");
    if (statSync4(file).size > MAX_BYTES) {
      const lines = readFileSync8(file, "utf8").split("\n").filter((l) => l !== "");
      writeFileSync6(file, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n");
    }
  } catch {
  }
}
function readDecisions(root, since = null, until = null) {
  let text;
  try {
    text = readFileSync8(join16(root, RECEIPT_DIR, DECISIONS_FILE), "utf8");
  } catch {
    return [];
  }
  const out3 = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.t !== "string" || typeof r.kind !== "string") continue;
      if (since && Date.parse(r.t) < since.getTime()) continue;
      if (until && Date.parse(r.t) > until.getTime()) continue;
      out3.push(r);
    } catch {
    }
  }
  return out3;
}
var PASSED = /* @__PURE__ */ new Set(["passed", "passed-lite", "passed-cached"]);
function summarizeDecisions(byProject) {
  const s = { projects: 0, checked: 0, passed: 0, blockedTurns: 0, fixed: 0, gaveUp: 0, released: 0, open: 0, claims: 0, claimsBlocked: 0, pausedStops: 0, pausedTurns: 0, cutOff: 0, cutOffTurns: 0, other: 0 };
  for (const records of byProject) {
    if (records.length === 0) continue;
    s.projects++;
    const bySession = /* @__PURE__ */ new Map();
    for (const r of records) {
      const list = bySession.get(r.session) ?? [];
      list.push(r);
      bySession.set(r.session, list);
    }
    for (const list of bySession.values()) {
      list.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
      let inBlockedTurn = false;
      for (const r of list) {
        if (PASSED.has(r.kind) || r.kind === "blocked") s.checked++;
        if (PASSED.has(r.kind)) s.passed++;
        if (r.kind === "user-paused") s.pausedStops++;
        else if (r.kind === "cut-off") s.cutOff++;
        else if (r.claim === true) {
          s.claims++;
          if (r.kind === "blocked") s.claimsBlocked++;
        }
        if (r.kind === "blocked") {
          if (!inBlockedTurn) s.blockedTurns++;
          inBlockedTurn = true;
          continue;
        }
        if (inBlockedTurn) {
          if (PASSED.has(r.kind)) s.fixed++;
          else if (r.kind === "gave-up" || r.kind === "unenforced") s.gaveUp++;
          else if (r.kind === "released") s.released++;
          else if (r.kind === "user-paused") s.pausedTurns++;
          else if (r.kind === "cut-off") s.cutOffTurns++;
          else s.other++;
          inBlockedTurn = false;
        }
      }
      if (inBlockedTurn) s.open++;
    }
  }
  return s;
}

// src/report.ts
function statusWord(r) {
  return r.status === "PASS" ? "PASS" : r.status === "TIMEOUT" ? "TIMEOUT" : r.status === "ERROR" ? "ERROR" : "FAIL";
}
function colorStatus(s, r) {
  const w = statusWord(r);
  return r.status === "PASS" ? s.green(w) : r.status === "TIMEOUT" ? s.yellow(w) : s.red(w);
}
function detail(r) {
  if (r.reused) return `reused the pass from ${r.reused.at.slice(0, 16).replace("T", " ")} UTC: none of its inputs changed since${r.summary ? ` (${r.summary})` : ""}`;
  if (r.status === "TIMEOUT") return `killed after ${formatDuration(r.timeoutMs)} (isitdone timeout; raise it in .isitdone.json if the check is legitimately slow)`;
  if (r.summary) return r.summary;
  if (r.status === "FAIL") return `exit ${r.exitCode ?? "?"}`;
  if (r.status === "ERROR") return r.tail[0] ?? "could not start";
  return "";
}
function cmdWidth(results) {
  return Math.min(40, Math.max(12, ...results.map((r) => r.cmd.length)));
}
function findingLine(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${where}  ${f.message}${f.suppressed ? `  (allowed: ${f.suppressed})` : ""}  [${f.severity}]`;
}
function formatIntegrity(res, s, maxFindings = 12) {
  const it = res.integrity;
  if (!it) return [];
  const lines = [];
  const touched = it.testFiles > 0 || it.findings.length > 0;
  if (!touched) return [];
  const head = `  ${s.bold("test integrity")}   ${formatSummaryLine(it.summary)}`;
  lines.push(head);
  if (it.findings.length === 0) {
    lines.push(`    ${s.green("none")}  ${s.dim(`${it.testFiles} test file${it.testFiles === 1 ? "" : "s"} changed, nothing weakened`)}`);
    return lines;
  }
  for (const f of it.findings.slice(0, maxFindings)) {
    const sev = f.severity === "critical" || f.severity === "high" ? s.red(f.severity) : f.severity === "medium" ? s.yellow(f.severity) : s.dim(f.severity);
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`    ${pad(where, 40)}  ${f.message}${f.suppressed ? s.dim(`  (allowed: ${f.suppressed})`) : ""}  ${sev}`);
    if (f.evidence && f.id !== "tests-removed" && f.id !== "assertions-removed" && f.id !== "test-file-deleted") {
      for (const ev of f.evidence.split("\n").slice(0, 2)) lines.push(`      ${s.dim(ev)}`);
    }
  }
  if (it.findings.length > maxFindings) lines.push(`    ${s.dim(`... ${it.findings.length - maxFindings} more`)}`);
  const mode = res.integrityMode === "strict" ? "strict: high/critical findings block" : 'warn only; set "integrity": "strict" in .isitdone.json to block';
  lines.push(`    ${s.dim(mode)}`);
  return lines;
}
function formatReport(res, s) {
  const lines = [];
  const g = res.git;
  const where = g.isRepo ? `${g.branch ?? "detached"}@${g.headShort ?? "no-commits"}  ${g.dirtyFiles === 0 ? "clean" : `dirty (${g.dirtyFiles} file${g.dirtyFiles === 1 ? "" : "s"})`}` : "not a git repo";
  lines.push(`${s.bold("isitdone")}  ${s.dim(where)}${res.claim ? `   claim: ${s.cyan(JSON.stringify(res.claim))}` : ""}`);
  lines.push("");
  if (res.cached && res.receipt) {
    lines.push(`  ${s.green("PASS")} (cached)  receipt from ${res.receipt.createdAt} proves this exact tree; nothing changed since.`);
    for (const r of res.receipt.checks) lines.push(`  ${s.dim(pad(r.cmd, cmdWidth(res.receipt.checks)))}  ${colorStatus(s, r)}  ${s.dim(formatDuration(r.durationMs))}  ${s.dim(detail(r))}`.trimEnd());
    const integrity2 = formatIntegrity(res, s);
    if (integrity2.length) lines.push("", ...integrity2);
    lines.push("");
    if (res.receipt.profile === "lite") lines.push(`  ${s.yellow(s.bold("OK (lite)"))}   lite checks passed on this exact tree (tree ${res.receipt.tree.slice(0, 7)}, cached); full checks not run`);
    else lines.push(`  ${s.green(s.bold("DONE"))}   receipt -> PASS (tree ${res.receipt.tree.slice(0, 7)}, ${res.receipt.checks.length} checks, cached)`);
    for (const w2 of res.warnings) lines.push(`  ${s.yellow("warning: " + w2)}`);
    return lines.join("\n");
  }
  if (res.ran.length === 0 && res.skipped.length === 0) {
    lines.push(`  ${s.yellow("no checks detected")} in ${g.root}`);
    lines.push(`  ${s.dim("isitdone looks for package.json scripts (test/typecheck/lint/build), pytest/ruff/mypy, go.mod, Cargo.toml, .NET, Gradle/Maven and Makefile targets.")}`);
    lines.push(`  ${s.dim('Add your own in .isitdone.json:  { "checks": { "test": "make test" } }')}`);
    for (const n of res.detection.notes) lines.push(`  ${s.dim("note: " + n)}`);
    const integrity2 = formatIntegrity(res, s);
    if (integrity2.length) lines.push("", ...integrity2);
    return lines.join("\n");
  }
  const w = cmdWidth(res.ran);
  for (const r of res.ran) {
    lines.push(`  ${pad(r.cmd, w)}  ${colorStatus(s, r)}  ${s.dim(pad(formatDuration(r.durationMs), 6))}  ${detail(r)}`.trimEnd());
  }
  for (const sk of res.skipped) {
    lines.push(`  ${s.dim(pad(sk.check.cmd, w))}  ${s.dim("SKIP")}  ${s.dim("      " + sk.reason)}`.trimEnd());
  }
  const failed = res.ran.filter((r) => r.status !== "PASS");
  for (const r of failed) {
    lines.push("");
    lines.push(`  ${s.red("--")} ${r.cmd} ${s.dim(`(last ${Math.min(r.tail.length, 15)} of ${r.lines} lines)`)}`);
    for (const l of r.tail.slice(-15)) lines.push(`     ${s.dim(l)}`);
  }
  const integrity = formatIntegrity(res, s);
  if (integrity.length) lines.push("", ...integrity);
  for (const n of res.detection.notes) lines.push(`  ${s.dim("note: " + n)}`);
  for (const wn of res.warnings) lines.push(`  ${s.yellow("warning: " + wn)}`);
  lines.push("");
  const blockedByIntegrity = res.ok && integrityBlocks(res);
  if (res.ok && !blockedByIntegrity) {
    const rc = res.receipt;
    const what = res.profile === "lite" ? `lite checks passed; full checks not run (${res.skipped.length} skipped)` : `receipt -> PASS (tree ${(rc?.tree ?? "").slice(0, 7)}, ${res.ran.length} checks, ${formatDuration(res.durationMs)})`;
    lines.push(`  ${res.profile === "lite" ? s.yellow(s.bold("OK (lite)")) : s.green(s.bold("DONE"))}   ${what}`);
  } else if (blockedByIntegrity) {
    lines.push(`  ${s.red(s.bold("NOT DONE"))}   checks passed but ${res.integrity?.blocking.length} test-integrity finding${res.integrity?.blocking.length === 1 ? "" : "s"} block${res.integrity?.blocking.length === 1 ? "s" : ""} in strict mode`);
  } else {
    lines.push(`  ${s.red(s.bold("NOT DONE"))}   ${failed.length} check${failed.length === 1 ? "" : "s"} failed`);
    lines.push(`  ${s.dim("receipt   .isitdone/receipt.json -> FAIL")}`);
  }
  return lines.join("\n");
}
function integrityBlocks(res) {
  return res.integrityMode === "strict" && (res.integrity?.blocking.length ?? 0) > 0;
}
var MAX_NOTE_FILES = 10;
function otherSessionLines(note) {
  const lines = [];
  const list = (xs) => {
    for (const x of xs.slice(0, MAX_NOTE_FILES)) lines.push(`  ${x.path}  (edited ${x.ago})`);
    if (xs.length > MAX_NOTE_FILES) lines.push(`  ... ${xs.length - MAX_NOTE_FILES} more`);
  };
  lines.push(`ANOTHER AGENT SESSION HAS BEEN WORKING IN THIS SAME DIRECTORY WHILE YOU WERE${note.lastActive ? ` (its last hook activity: ${note.lastActive})` : ""}. The checks see its unfinished work too.`);
  if (note.foreign.length > 0 && note.ownUnknown) {
    lines.push("It has unfinished edits in these uncommitted files (isitdone has no record of which files YOU edited, so you may have changed some of them too):");
    list(note.foreign);
    lines.push("Do not revert or discard the other session's changes, and do not run git commands that would (checkout, restore, reset, stash, clean). Where you changed one of these files yourself, fix only your own change.");
  } else if (note.foreign.length > 0) {
    lines.push("These uncommitted files are its work in progress, not yours:");
    list(note.foreign);
    lines.push('Do not edit, revert or "fix" them, and do not run git commands that would discard them (checkout, restore, reset, stash, clean).');
  }
  if (note.shared.length > 0) {
    lines.push("Both of you have edited these; re-read them before editing and keep the other session's changes:");
    list(note.shared);
  }
  return lines;
}
function formatBlockReason(res, attempt, maxAttempts, otherSession = null) {
  const lines = [];
  const failed = res.ran.filter((r) => r.status !== "PASS");
  const timedOut = failed.filter((r) => r.status === "TIMEOUT");
  const onlyIntegrity = failed.length === 0 && integrityBlocks(res);
  if (onlyIntegrity) {
    lines.push(`isitdone: NOT DONE. The checks pass, but the change weakened the tests (attempt ${attempt}/${maxAttempts}). [isitdone ${VERSION}]`);
  } else {
    const verb = timedOut.length === failed.length ? "timed out" : timedOut.length > 0 ? "failed or timed out" : "failed";
    lines.push(`isitdone: NOT DONE. ${failed.length} check${failed.length === 1 ? "" : "s"} ${verb} on the current working tree (attempt ${attempt}/${maxAttempts}). [isitdone ${VERSION}]`);
  }
  if (res.claim) lines.push(`You claimed: "${res.claim}"`);
  if (otherSession) lines.push("", ...otherSessionLines(otherSession));
  lines.push("");
  const w = cmdWidth(res.ran);
  for (const r of res.ran) lines.push(`  ${pad(r.cmd, w)}  ${statusWord(r)}  ${detail(r)}`.trimEnd());
  for (const sk of res.skipped) lines.push(`  ${pad(sk.check.cmd, w)}  SKIP  ${sk.reason}`);
  const budget = Math.max(4, Math.floor(20 / Math.max(1, failed.length)));
  for (const r of failed) {
    lines.push("");
    lines.push(`--- ${r.cmd} (last ${Math.min(r.tail.length, budget)} lines) ---`);
    for (const l of r.tail.slice(-budget)) lines.push(l.length > 200 ? l.slice(0, 197) + "..." : l);
  }
  const it = res.integrity;
  if (it && it.findings.length > 0) {
    lines.push("");
    lines.push(`test integrity   ${formatSummaryLine(it.summary)}`);
    for (const f of it.findings.slice(0, 8)) lines.push(`  ${findingLine(f)}`);
    if (it.findings.length > 8) lines.push(`  ... ${it.findings.length - 8} more`);
  }
  lines.push("");
  if (timedOut.length > 0) {
    lines.push(`A TIMEOUT means isitdone killed the check after its time limit, not that the tests failed. If the check is legitimately slow, tell the user to raise "timeout" in .isitdone.json; otherwise look for a hung process or watch mode.`);
  }
  if (onlyIntegrity) {
    lines.push("Restore the removed or weakened tests (or explain to the user why the change to the tests is correct), then run `npx isitdone` before claiming completion.");
  } else if (otherSession && otherSession.soft) {
    lines.push(`Nothing in this output names a file you edited, so first work out whether your change caused it (a changed type, signature or fixture can break a file you never opened). If it did, fix YOUR change, in your own files. If it did not, tell the user exactly that and stop: ${attempt < maxAttempts ? "isitdone will run the checks once more and let you stop if the output still names none of your files" : "this was the last block isitdone issues this turn"}. Do not skip, delete or weaken tests to make this pass.`);
  } else if (otherSession && otherSession.foreign.length > 0 && otherSession.ownUnknown) {
    lines.push("Fix the failures your own changes caused, then run `npx isitdone`. Do not undo the other session's changes to get there; where a failure is its doing, leave it and tell the user. Do not skip, delete or weaken tests to make this pass.");
  } else if (otherSession && otherSession.foreign.length > 0) {
    lines.push("Fix the failures in your own files, then run `npx isitdone`. Failures that remain in the other session's files are not yours to fix: leave them and tell the user. Do not skip, delete or weaken tests to make this pass.");
  } else {
    lines.push("Fix the failures, then run `npx isitdone` and paste its output before claiming completion. Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo, say so explicitly to the user.");
  }
  return lines.join("\n");
}
function formatReceiptState(ev, s, fullRun) {
  const color = ev.state === "PASS" ? s.green : ev.state === "FAIL" ? s.red : s.yellow;
  const label = ev.state === "PASS" && ev.receipt?.profile === "lite" ? "PASS (lite)" : ev.state;
  const lines = [`${s.bold("isitdone receipt")}  ${color(s.bold(label))}  ${s.dim(ev.reason)}`];
  if (ev.receipt) {
    const r = ev.receipt;
    lines.push(`  ${s.dim(`created ${r.createdAt} on ${r.branch ?? "detached"}@${(r.head ?? "").slice(0, 7)} tree ${r.tree.slice(0, 7)}, profile ${r.profile}${r.host ? `, host ${r.host}` : ""}`)}`);
    for (const c of r.checks) lines.push(`  ${c.cmd}  ${c.status === "PASS" ? s.green("PASS") : s.red(c.status)}  ${s.dim(formatDuration(c.durationMs))}  ${s.dim(c.reused ? detail(c) : c.summary ?? "")}`.trimEnd());
    if (r.claim) lines.push(`  ${s.dim("claim: " + JSON.stringify(r.claim))}`);
    if (ev.state === "PASS" && r.profile === "lite") lines.push(`  ${s.yellow(`tests were not run; ${fullRun} for a full receipt`)}`);
  }
  return lines.join("\n");
}
function formatDetection(root, d, config, source, s) {
  const lines = [`${s.bold("isitdone detect")}  ${s.dim(root)}${source ? s.dim(`  (config: ${source})`) : ""}`];
  if (d.checks.length === 0) lines.push(`  ${s.yellow("no checks detected")}`);
  for (const c of d.checks) {
    lines.push(`  ${s.cyan(c.id.padEnd(10))} ${c.cmd.padEnd(32)} ${s.dim(`${c.kind}  ${timeoutFor(c, config) / 1e3}s  from ${c.source}`)}`);
    if (c.ignore?.length) lines.push(`  ${" ".repeat(10)} ${s.dim(`reuses its last pass while only these change: ${c.ignore.join(", ")}`)}`);
  }
  for (const n of d.notes) lines.push(`  ${s.dim("note: " + n)}`);
  return lines.join("\n");
}
function mdCell(s) {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function formatMarkdown(receipt, state) {
  const lines = [];
  lines.push("| check | result | time |");
  lines.push("|---|---|---|");
  for (const r of receipt.checks) {
    const d = detail(r);
    lines.push(`| \`${mdCell(r.cmd)}\` | ${statusWord(r)}${d ? ` (${mdCell(d)})` : ""} | ${formatDuration(r.durationMs)} |`);
  }
  lines.push("");
  if (receipt.integrity) {
    const it = receipt.integrity;
    const unsuppressed = it.findings.filter((f) => !f.suppressed);
    if (unsuppressed.length === 0) lines.push(`Tests weakened: none (${formatSummaryLine(it.summary)}).`);
    else lines.push(`Tests weakened: ${unsuppressed.length} finding${unsuppressed.length === 1 ? "" : "s"} (${formatSummaryLine(it.summary)}): ${unsuppressed.slice(0, 5).map((f) => `${mdCell(f.file)}${f.line ? ":" + f.line : ""} ${mdCell(f.message)}`).join("; ")}${unsuppressed.length > 5 ? "; ..." : ""}.`);
    lines.push("");
  }
  const tree = receipt.tree.slice(0, 7);
  const where = receipt.head ? `Tree ${tree} on ${receipt.branch ?? "detached"}@${receipt.head.slice(0, 7)}${receipt.dirtyFiles ? ` (+${receipt.dirtyFiles} uncommitted)` : " (clean)"}` : `Tree ${tree}`;
  const label = state === "PASS" && receipt.profile === "lite" ? "PASS (lite: typecheck/lint only, tests not run)" : state;
  lines.push(`${where}. Receipt: **${label}**${receipt.host ? ` \xB7 Agent: ${receipt.host}` : ""} \xB7 isitdone ${VERSION} \xB7 ${receipt.createdAt}`);
  return lines.join("\n");
}
function formatReportMarkdown(res, state) {
  const lines = [];
  const failed = res.ran.filter((r) => r.status !== "PASS");
  const blocked = integrityBlocks(res);
  const verdict = res.ok && !blocked ? "DONE" : "NOT DONE";
  const why = !res.ok ? `${failed.length} check${failed.length === 1 ? "" : "s"} failed` : blocked ? `checks pass, but ${res.integrity?.blocking.length} test-integrity finding${res.integrity?.blocking.length === 1 ? "" : "s"} block${res.integrity?.blocking.length === 1 ? "s" : ""}` : res.detection.checks.length === 0 ? "no checks detected" : `${res.ran.length || res.receipt?.checks.length || 0} checks passed`;
  lines.push(`**${verdict}** (${why})`);
  lines.push("");
  const checks = res.cached && res.receipt ? res.receipt.checks : res.ran;
  if (checks.length > 0) {
    lines.push("| check | result | time |");
    lines.push("|---|---|---|");
    for (const r of checks) {
      const d = detail(r);
      lines.push(`| \`${mdCell(r.cmd)}\` | ${statusWord(r)}${d ? ` (${mdCell(d)})` : ""} | ${formatDuration(r.durationMs)} |`);
    }
    for (const sk of res.skipped) lines.push(`| \`${mdCell(sk.check.cmd)}\` | SKIP (${mdCell(sk.reason)}) | |`);
    lines.push("");
  } else if (res.detection.checks.length === 0) {
    lines.push("No checks detected: add a test script to `package.json` or define checks in `.isitdone.json`.");
    lines.push("");
  }
  for (const r of failed) {
    lines.push(`<details><summary><code>${mdCell(r.cmd)}</code> output (last ${Math.min(r.tail.length, 30)} lines)</summary>`);
    lines.push("");
    lines.push("```");
    for (const l of r.tail.slice(-30)) lines.push(l.replace(/```/g, "'''"));
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  const it = res.integrity;
  if (it && (it.testFiles > 0 || it.findings.length > 0)) {
    lines.push(`**Test integrity** (${formatSummaryLine(it.summary)}${res.integrityMode === "strict" ? ", strict" : ""})`);
    lines.push("");
    if (it.findings.length === 0) lines.push(`${it.testFiles} test file${it.testFiles === 1 ? "" : "s"} changed, nothing weakened.`);
    else {
      lines.push("| where | finding | severity |");
      lines.push("|---|---|---|");
      for (const f of it.findings.slice(0, 40)) lines.push(`| \`${mdCell(f.file)}${f.line ? ":" + f.line : ""}\` | ${mdCell(f.message)}${f.suppressed ? ` (allowed: ${mdCell(f.suppressed)})` : ""} | ${f.severity} |`);
      if (it.findings.length > 40) lines.push(`| | ... ${it.findings.length - 40} more | |`);
    }
    lines.push("");
  }
  for (const w of res.warnings) lines.push(`> warning: ${w}`);
  if (res.warnings.length) lines.push("");
  const g = res.git;
  const tree = g.tree.slice(0, 7);
  lines.push(`<sub>Tree ${tree}${g.head ? ` on ${g.branch ?? "detached"}@${g.head.slice(0, 7)}` : ""}${g.dirtyFiles ? ` (+${g.dirtyFiles} uncommitted)` : ""} \xB7 receipt ${state} \xB7 isitdone ${VERSION}</sub>`);
  return lines.join("\n");
}
function receiptStateOf(res) {
  return res.receipt ? res.receipt.status === "PASS" ? "PASS" : "FAIL" : res.cached ? "PASS" : "NONE";
}
function toJson(res, state) {
  const checks = res.cached && res.receipt ? res.receipt.checks : res.ran;
  const noChecks = res.detection.checks.length === 0;
  const fullPass = res.ok && !noChecks && (res.cached ? res.receipt?.profile === "full" : res.profile === "full" && res.receipt?.profile === "full");
  return {
    ok: res.ok && !integrityBlocks(res),
    // done is true only when every full check passed on this exact tree. No checks detected is not "done".
    done: Boolean(fullPass) && !integrityBlocks(res),
    noChecks,
    state,
    profile: res.profile,
    cached: res.cached,
    claim: res.claim,
    git: { root: res.git.root, head: res.git.head, branch: res.git.branch, tree: res.git.tree, dirtyFiles: res.git.dirtyFiles },
    checks: checks.map((r) => ({
      id: r.id,
      cmd: r.cmd,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      summary: r.summary ?? null,
      tail: r.tail,
      reused: r.reused ?? null
    })),
    skipped: res.skipped.map((sk) => ({ id: sk.check.id, cmd: sk.check.cmd, reason: sk.reason })),
    integrity: res.integrity ? {
      mode: res.integrityMode,
      summary: res.integrity.summary,
      testFiles: res.integrity.testFiles,
      findings: res.integrity.findings,
      blocking: res.integrity.blocking.length
    } : null,
    stacks: res.detection.stacks,
    notes: res.detection.notes,
    warnings: res.warnings,
    receipt: res.receipt ? { createdAt: res.receipt.createdAt, status: res.receipt.status, profile: res.receipt.profile, tree: res.receipt.tree } : null,
    durationMs: res.durationMs,
    version: VERSION
  };
}

// src/runmarks.ts
import { mkdirSync as mkdirSync6, readdirSync as readdirSync8, readFileSync as readFileSync9, renameSync as renameSync3, rmSync as rmSync8, statSync as statSync5, utimesSync as utimesSync2, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join17 } from "node:path";
var RUNS_DIR = "runs";
var BEAT_MS = 15e3;
var STALE_MS = 9e4;
function startRunMark(root, mark) {
  const dir2 = join17(root, RECEIPT_DIR, RUNS_DIR);
  const file = join17(dir2, `${mark.session}-${process.pid}.json`);
  try {
    mkdirSync6(join17(ensureStateDir(root), RUNS_DIR), { recursive: true });
    writeFileSync7(file, JSON.stringify({ ...mark, pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch {
    return () => {
    };
  }
  const beat = setInterval(() => {
    try {
      const now = /* @__PURE__ */ new Date();
      utimesSync2(file, now, now);
    } catch {
    }
  }, BEAT_MS);
  beat.unref();
  return () => {
    clearInterval(beat);
    try {
      rmSync8(file, { force: true });
    } catch {
    }
  };
}
var NOTICE_FILE = "cutoff-notice.json";
function addCutOffNotice(root, cut) {
  if (cut.length === 0) return;
  const file = join17(root, RECEIPT_DIR, NOTICE_FILE);
  try {
    let prev = { count: 0, longestMs: 0 };
    try {
      prev = JSON.parse(readFileSync9(file, "utf8"));
    } catch {
    }
    const next = { count: (Number(prev.count) || 0) + cut.length, longestMs: Math.max(Number(prev.longestMs) || 0, ...cut.map((c) => c.ranMs)) };
    writeFileSync7(join17(ensureStateDir(root), NOTICE_FILE), JSON.stringify(next));
  } catch {
  }
}
function takeCutOffNotice(root) {
  const file = join17(root, RECEIPT_DIR, NOTICE_FILE);
  const taken = `${file}.${process.pid}.taken`;
  try {
    renameSync3(file, taken);
    const n = JSON.parse(readFileSync9(taken, "utf8"));
    rmSync8(taken, { force: true });
    return Number(n.count) > 0 ? { count: Number(n.count), longestMs: Number(n.longestMs) || 0 } : null;
  } catch {
    rmSync8(taken, { force: true });
    return null;
  }
}
function collectCutOffs(root, now = Date.now()) {
  const dir2 = join17(root, RECEIPT_DIR, RUNS_DIR);
  let entries;
  try {
    entries = readdirSync8(dir2).filter((e) => e.endsWith(".json"));
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    const file = join17(dir2, e);
    try {
      const lastBeat = statSync5(file).mtimeMs;
      const mark = JSON.parse(readFileSync9(file, "utf8"));
      if (typeof mark.pid !== "number" || typeof mark.startedAt !== "string") {
        rmSync8(file, { force: true });
        continue;
      }
      if (mark.pid === process.pid) continue;
      if (!(now - lastBeat > STALE_MS || now - lastBeat > 2 * BEAT_MS + 1e3 && pidGone(mark.pid))) continue;
      const taken = `${file}.taken`;
      renameSync3(file, taken);
      rmSync8(taken, { force: true });
      found.push({ pid: mark.pid, host: String(mark.host ?? ""), session: String(mark.session ?? "anon"), profile: mark.profile === "lite" ? "lite" : "full", startedAt: mark.startedAt, ranMs: Math.max(0, lastBeat - Date.parse(mark.startedAt)) });
    } catch {
    }
  }
  return found;
}

// src/hook.ts
var DEFAULT_MAX_ATTEMPTS = 3;
var MAX_REASON_CHARS = 9e3;
var STATE_MAX_AGE_MS = 24 * 60 * 60 * 1e3;
var RECEIPT_HOST = { claude: "claude-code", gemini: "gemini-cli", copilot: "copilot-cli", qwen: "qwen-code", junie: "junie-cli", augment: "auggie" };
var EDIT_EVENT = /^(?:PostToolUse|AfterTool|afterFileEdit|tool\.execute\.after)$/i;
function stateFile(root, host, sessionId) {
  return join18(root, RECEIPT_DIR, SESSIONS_DIR, `${sessionKey(host, sessionId)}.json`);
}
function readState(root, host, sessionId) {
  return tryReadJsonFile(stateFile(root, host, sessionId));
}
function writeState(root, state) {
  try {
    ensureStateDir(root);
    writeFileAtomic(stateFile(root, state.host, state.sessionId), JSON.stringify(state, null, 2) + "\n");
    pruneStates(root);
    return true;
  } catch {
    return false;
  }
}
function pruneStates(root) {
  const dir2 = join18(root, RECEIPT_DIR, SESSIONS_DIR);
  try {
    const now = Date.now();
    for (const e of readdirSync9(dir2)) {
      const p = join18(dir2, e);
      try {
        if (now - statSync6(p).mtimeMs > STATE_MAX_AGE_MS) rmSync9(p, { force: true });
      } catch {
      }
    }
  } catch {
  }
}
function parsePayload(stdin) {
  const text = (stdin.charCodeAt(0) === 65279 ? stdin.slice(1) : stdin).trim();
  if (text === "" || !text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
function resolveProfile(config, input, override) {
  const claim = findClaim(input.lastMessage, config.claimPatterns ?? []);
  const setting = override ?? config.profile ?? "claim-gated";
  if (setting === "full") return { profile: "full", claim: claim?.sentence ?? null, why: "profile is full" };
  if (setting === "lite") return { profile: "lite", claim: claim?.sentence ?? null, why: "profile is lite" };
  if (input.lastMessage === null) return { profile: "full", claim: null, why: "host did not provide the final message; running full checks (cached per tree)" };
  if (claim) return { profile: "full", claim: claim.sentence, why: `completion claim detected (${claim.pattern})` };
  return { profile: "lite", claim: null, why: "no completion claim in the final message" };
}
function isContinuation(input, prev) {
  if (input.loopCount !== null && !input.stopHookActive) {
    return prev !== null && prev.loopCount !== null && prev.attempts > 0 && input.loopCount === prev.loopCount + 1;
  }
  if (input.stopHookActive === null) return prev !== null && prev.attempts > 0;
  return input.stopHookActive;
}
function truncate(s, max) {
  return s.length <= max ? s : s.slice(0, max - 20) + "\n... (truncated)";
}
var TOLD_MAX_AGE_MS = 10 * 60 * 1e3;
var PAUSE_POLL_MS = 3e3;
var MAX_ATTRIBUTION_CHARS = 1024 * 1024;
var GIVE_UP_MESSAGE = (n) => `isitdone: checks still failing after ${n} attempt${n === 1 ? "" : "s"}; allowing the agent to stop. Run \`npx isitdone\` to see what is failing.`;
async function runHook(opts) {
  const log = { root: null, session: null, claim: null, profile: null };
  const outcome = await decideStop(opts, log);
  if (!opts.doctor && log.root !== null && outcome.kind) {
    const r = outcome.result;
    appendDecision(log.root, {
      t: (/* @__PURE__ */ new Date()).toISOString(),
      host: getHost(opts.host).name,
      session: log.session ?? "anon",
      kind: outcome.kind,
      claim: log.claim,
      profile: log.profile,
      attempts: outcome.attempts,
      checks: r ? r.cached ? r.receipt?.checks.length ?? 0 : r.ran.length : 0,
      failed: r ? r.ran.filter((x) => x.status !== "PASS").length : 0,
      ...r && !r.cached && r.ran.some((x) => x.reused) ? { reused: r.ran.filter((x) => x.reused).length } : {}
    }, { create: outcome.kind !== "user-paused" });
  }
  return outcome;
}
async function decideStop(opts, log) {
  const host = getHost(opts.host);
  const doctor2 = opts.doctor ?? false;
  const env = opts.env ?? process.env;
  const allow = (why2, systemMessage, result2 = null, attempts2 = 0, kind) => ({
    stdout: host.allow(systemMessage),
    stderr: "",
    exitCode: 0,
    decision: "allow",
    why: why2,
    result: result2,
    attempts: attempts2,
    kind
  });
  if (env.ISITDONE === "1") return allow("running nested inside an isitdone check; allowing");
  const raw = parsePayload(opts.stdin);
  if (!raw) return allow("stdin was not a JSON object (host bug or manual run); allowing");
  const input = host.parse(raw);
  if (input.hookEventName && EDIT_EVENT.test(input.hookEventName)) {
    const e = runEditHook({ host: opts.host, stdin: opts.stdin, cwd: opts.cwd, env });
    return { stdout: e.stdout, stderr: "", exitCode: 0, decision: "allow", why: `${input.hookEventName} payload routed to the edit hook: ${e.why}`, result: null, attempts: 0 };
  }
  if (input.status !== null && input.status !== "completed") return allow(`host status is ${input.status}; nothing to verify`);
  if (input.permissionMode === "plan") return allow("plan mode: the agent cannot edit files, so there is nothing to verify yet");
  const cwd = input.cwd && existsSync12(input.cwd) ? input.cwd : opts.cwd ?? process.cwd();
  const topLevel = gitTopLevel(cwd);
  const root = findRoot(cwd, topLevel);
  log.root = root;
  log.session = sessionKey(host.name, input.sessionId);
  let config;
  try {
    config = loadConfig(root).config;
  } catch (err2) {
    return allow(`config error: ${err2.message}`, `isitdone: ${err2.message}`, null, 0, "error");
  }
  if (doctor2) {
    if (input.stopHookActive) return allow("doctor mode never blocks twice");
    const disabled = Object.fromEntries(detectChecks(root, config).checks.map((c) => [c.id, false]));
    config = { ...config, checks: { ...disabled, "doctor-probe": { cmd: `node -e "console.log('isitdone doctor: simulated failing check'); process.exit(1)"`, kind: "lite" } }, profile: "full" };
  }
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!doctor2) recordCutOffs(root);
  const prev = doctor2 ? null : readState(root, host.name, input.sessionId);
  const continuation = isContinuation(input, prev);
  let attempts = continuation && prev ? prev.attempts : 0;
  const pauses = doctor2 ? null : pauseLookup(topLevel ?? root);
  const pausedStop = (pause, stoppedRun) => {
    log.claim = input.lastMessage === null ? null : resolveProfile(config, input, opts.profile).claim !== null;
    log.profile = null;
    const cutShort = attempts > 0;
    if (prev && prev.attempts > 0) writeState(root, { ...prev, attempts: 0, softBlocks: 0, loopCount: input.loopCount, turnId: input.turnId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const on = `\`npx isitdone resume${pause.scope === "global" ? " --global" : ""}\` turns the gate back on.`;
    const message = stoppedRun ? `isitdone was paused ${describePause(pause)} while its checks were running; they were stopped, and this stop was not checked. ${on}` : cutShort ? `isitdone had blocked this turn ${attempts} time${attempts === 1 ? "" : "s"} because checks failed; it is paused ${describePause(pause)}, so the agent was let stop with them unfixed. ${on}` : `isitdone is paused ${describePause(pause)}; this stop was not checked. ${on}`;
    const tell = stoppedRun || cutShort || log.claim !== false;
    return allow(`paused by the user ${describePause(pause)}${stoppedRun ? "; the checks were stopped mid-run" : ""}`, tell ? message : void 0, null, cutShort ? attempts : 0, "user-paused");
  };
  const pausedNow = pauses ? activePause(pauses()) : null;
  if (pausedNow) return pausedStop(pausedNow, false);
  if (continuation && attempts >= maxAttempts) {
    if (!doctor2 && prev) writeState(root, { ...prev, attempts: input.stopHookActive === null ? 0 : prev.attempts, loopCount: input.loopCount, turnId: input.turnId, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return allow(`already blocked ${attempts} time(s) this turn (max ${maxAttempts}); letting the agent stop`, GIVE_UP_MESSAGE(attempts), null, attempts, "gave-up");
  }
  const { profile, claim, why } = resolveProfile(config, input, opts.profile);
  log.claim = input.lastMessage === null ? null : claim !== null;
  log.profile = profile;
  if (input.backgroundTasks > 0 && !claim && profile === "lite") {
    return allow(`${input.backgroundTasks} background task(s) still running and no completion claim; treating this stop as a pause`, void 0, null, 0, "paused");
  }
  const top = doctor2 || config.otherSessions === "ignore" || input.sessionId === null ? null : topLevel;
  const whoseFiles = () => {
    if (top === null) return null;
    try {
      return attribute([top, root], host.name, input.sessionId, () => dirtyPathSet(top));
    } catch {
      return null;
    }
  };
  const before = whoseFiles();
  const output = /* @__PURE__ */ new Map();
  const pauseWatch = new AbortController();
  const runVerify = (useCache) => verify({
    root,
    config,
    profile,
    claim,
    host: RECEIPT_HOST[host.name] ?? host.name,
    useCache,
    dryRun: doctor2,
    // A lite failure in the other session's file must not hide this session's own failing tests.
    all: before !== null,
    lockWaitMs: doctor2 || config.otherSessions === "ignore" ? 0 : (wanted) => {
      const budget = budgetSeconds(wanted, config);
      const slack = Math.max(DEFAULT_HOOK_TIMEOUT_S, budget + HOOK_MARGIN_S) - budget - HOOK_MARGIN_S / 2;
      return Math.min(LOCK_WAIT_MS, Math.max(10, slack) * 1e3);
    },
    onOutput: doctor2 ? void 0 : (check, chunk) => output.set(check.id, ((output.get(check.id) ?? "") + chunk).slice(-MAX_ATTRIBUTION_CHARS)),
    signal: pauseWatch.signal
  });
  let pausedMidRun = null;
  const poll = pauses ? setInterval(() => {
    const p = activePause(pauses());
    if (p) {
      pausedMidRun = p;
      pauseWatch.abort();
    }
  }, PAUSE_POLL_MS) : null;
  poll?.unref();
  let result;
  const endMark = doctor2 ? () => {
  } : startRunMark(root, { host: host.name, session: sessionKey(host.name, input.sessionId), profile });
  try {
    result = await runVerify(!doctor2);
    if (result.cached && result.receipt && top !== null && !pauseWatch.signal.aborted) {
      const r = result.receipt;
      const ranFrom = r.startedAt ? Date.parse(r.startedAt) : Date.parse(r.createdAt) - r.checks.reduce((n, c) => n + c.durationMs, 0) - 1e3;
      if (lastEditAt([top, root], host.name, input.sessionId) >= ranFrom) result = await runVerify(false);
    }
  } finally {
    if (poll) clearInterval(poll);
    endMark();
  }
  if (pausedMidRun && !result.ok) return pausedStop(pausedMidRun, true);
  const provedAt = result.ok && result.receipt?.status === "PASS" && result.receipt.profile === "full" ? Date.now() - result.durationMs : null;
  const firstSeen = prev?.firstSeen ?? (/* @__PURE__ */ new Date()).toISOString();
  const state = (n, softBlocks2 = 0, passed = false) => ({
    host: host.name,
    sessionId: input.sessionId,
    turnId: input.turnId,
    attempts: n,
    loopCount: input.loopCount,
    lastTree: result.git.tree,
    softBlocks: softBlocks2,
    firstSeen,
    lastPassAt: passed && provedAt !== null ? new Date(provedAt).toISOString() : prev?.lastPassAt,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  if (top !== null) {
    compactEdits(top, host.name, input.sessionId);
    if (top !== root) pruneSessions(top);
  }
  const failing = !result.ok || (result.integrity?.findings.some((x) => !x.suppressed) ?? false);
  const others = failing ? otherSessions(whoseFiles(), top, result, output) : null;
  const view = others && others.attribution.mine.size > 0 ? setAsideForeignFindings(result, new Set(others.attribution.foreign.map((x) => x.path))) : result;
  const setAside = others && view.integrity && result.integrity ? result.integrity.findings.filter((x) => !x.suppressed).length - view.integrity.findings.filter((x) => !x.suppressed).length : 0;
  const notes = [...view.warnings];
  const cutOffNote = doctor2 ? null : cutOffMessage(root);
  if (cutOffNote) notes.push(cutOffNote);
  const lock = result.lock;
  if (lock && lock.waitedMs > 5e3) {
    const what = lock.tookOver ? "for a check run in this directory that never finished (its lock was cleared)" : "for another check run in this directory";
    notes.push(`waited ${Math.round(lock.waitedMs / 1e3)} s ${what}${lock.held ? "" : " and then ran alongside it"}`);
  }
  if (setAside > 0) notes.push(`${setAside} test-integrity finding${setAside === 1 ? " is" : "s are"} in files another session edited and ${setAside === 1 ? "was" : "were"} left to that session`);
  const it = view.integrity;
  const weakened = it ? it.findings.filter((f) => !f.suppressed) : [];
  if (view.ok && weakened.length > 0 && !integrityBlocks(view)) {
    notes.push(`the change weakened tests (${weakened.length} finding${weakened.length === 1 ? "" : "s"}: ${weakened.slice(0, 3).map((f) => f.message).join("; ")}); run \`npx isitdone\` for details`);
  }
  const warn = notes.length ? `isitdone: ${notes.join("; ")}` : void 0;
  if (view.ok && !integrityBlocks(view)) {
    if (!doctor2) writeState(root, state(0, 0, true));
    if (!doctor2 && top !== null && provedAt !== null) recordPass(top, host.name, input.sessionId, provedAt);
    const kind = view.cached ? "passed-cached" : view.ran.length === 0 ? "no-checks" : profile === "full" ? "passed" : "passed-lite";
    return allow(`${view.cached ? "cached PASS" : profile === "full" ? "all checks passed" : "lite checks passed"} (${why})`, warn, view, 0, kind);
  }
  const pausedLate = pauses ? activePause(pauses()) : null;
  if (pausedLate) return pausedStop(pausedLate, false);
  const failedCount = view.ran.filter((r) => r.status !== "PASS").length;
  const tied = others === null || others.mineNamed || integrityBlocks(view) || others.attribution.mine.size === 0;
  const toldRecently = prev !== null && (input.stopHookActive === true || Date.now() - Date.parse(prev.updatedAt) < TOLD_MAX_AGE_MS);
  const softBlocks = continuation && toldRecently ? prev?.softBlocks ?? 0 : 0;
  if (!tied && others && softBlocks >= 1) {
    if (!doctor2) writeState(root, state(input.stopHookActive === null ? 0 : attempts));
    const theirs = others.attribution.foreign.slice(0, 5).map((x) => x.path).join(", ") + (others.attribution.foreign.length > 5 ? ", ..." : "");
    const message = `isitdone: ${failedCount} check${failedCount === 1 ? "" : "s"} still failing, but nothing in the output names a file this session edited, and another session has uncommitted work here (${theirs}). This session was let go after one block; the receipt says FAIL. Run \`npx isitdone\` once both sessions are finished.`;
    return allow(`${failedCount} check(s) failed, not tied to this session while another session works here (${why})`, warn ? `${message} (${warn})` : message, view, attempts, "released");
  }
  attempts += 1;
  if (!doctor2 && !writeState(root, state(attempts, others ? softBlocks + 1 : softBlocks))) {
    return allow("checks failed but session state could not be written; allowing to avoid an unbounded loop", `isitdone: checks failed but .isitdone/ is not writable, so the stop was allowed without enforcement. Run \`npx isitdone\` to see the failures.`, view, attempts, "unenforced");
  }
  if (attempts > maxAttempts) {
    return allow(`checks failed but attempts (${attempts}) exceed max (${maxAttempts}); letting the agent stop`, GIVE_UP_MESSAGE(attempts - 1), view, attempts, "gave-up");
  }
  let reason = formatBlockReason(view, attempts, maxAttempts, others ? sessionNote(others.attribution, !tied) : null);
  if (warn) reason += `
(${warn})`;
  return {
    stdout: host.block(truncate(reason, MAX_REASON_CHARS)),
    stderr: "",
    exitCode: 0,
    decision: "block",
    why: `${failedCount} check(s) failed (${why})`,
    result: view,
    attempts,
    kind: "blocked"
  };
}
function recordCutOffs(root) {
  const cut = collectCutOffs(root);
  for (const c of cut) appendDecision(root, { t: c.startedAt, host: c.host, session: c.session, kind: "cut-off", claim: null, profile: c.profile, attempts: 0, checks: 0, failed: 0 });
  addCutOffNotice(root, cut);
}
function cutOffMessage(root) {
  const n = takeCutOffNotice(root);
  if (!n) return null;
  const one = n.count === 1;
  return `${one ? "a check run" : `${n.count} check runs`} here stopped answering after ${one ? "" : "up to "}${formatSpan(n.longestMs)} without finishing, cut off by the host (its hook timeout, or an interrupted turn): nothing was verified, and ${one ? "that stop" : "those stops"} went through (\`npx isitdone doctor\` compares the hook's timeout with the checks')`;
}
function otherSessions(attribution, top, result, output) {
  if (attribution === null || top === null) return null;
  try {
    const text = result.ran.filter((r) => r.status !== "PASS").map((r) => output.get(r.id) ?? r.tail.join("\n")).join("\n");
    const ctx = mentionContext(text, top, [...trackedPaths(top), ...dirtyPathSet(top)]);
    return { attribution, mineNamed: [...attribution.mine].some((p) => mentions(ctx, p)) };
  } catch {
    return null;
  }
}
function setAsideForeignFindings(result, foreign) {
  const it = result.integrity;
  if (!it || foreign.size === 0 || !it.findings.some((f) => foreign.has(f.file) && !f.suppressed)) return result;
  const findings = it.findings.map((f) => foreign.has(f.file) && !f.suppressed ? { ...f, suppressed: "another session is editing this file" } : f);
  return { ...result, integrity: { ...it, findings, blocking: it.blocking.filter((f) => !foreign.has(f.file)) } };
}
function sessionNote(a, soft) {
  const now = Date.now();
  const list = (xs) => xs.map((x) => ({ path: x.path, ago: formatAgo(now - x.editedAt) }));
  return { foreign: list(a.foreign), shared: list(a.shared), lastActive: formatAgo(now - a.otherLastActive), soft, ownUnknown: a.mine.size === 0 };
}
function runEditHook(opts) {
  const host = getHost(opts.host);
  const env = opts.env ?? process.env;
  if (!host.edit) return { stdout: "", why: `${host.displayName} has no agent-visible channel after an edit`, notes: [] };
  const silent = (why) => ({ stdout: host.edit ? host.edit.silent() : "", why, notes: [] });
  if (env.ISITDONE === "1") return silent("nested inside an isitdone check");
  const raw = parsePayload(opts.stdin);
  if (!raw) return silent("stdin was not a JSON object");
  const input = host.edit.parse(raw);
  if (input.files.length === 0) return silent("no file path in the payload");
  const cwd = input.cwd && existsSync12(input.cwd) ? input.cwd : opts.cwd ?? process.cwd();
  const top = gitTopLevel(cwd);
  if (!top) return silent("not inside a git repository");
  recordEdits(top, host.name, host.parse(raw).sessionId, input.files.map((file) => toRepoPath(top, file, cwd)).filter(insideRepo));
  try {
    if (loadConfig(findRoot(cwd, top)).config.integrity === "off") return silent("integrity scan is off in config");
  } catch {
  }
  let diff = null;
  const diffOnce = () => {
    if (!diff) diff = collectDiff(top);
    return diff;
  };
  const notes = [];
  for (const file of input.files.slice(0, 8)) {
    try {
      const r = checkEditedFile(cwd, file, "HEAD", diffOnce, top);
      if (r?.note) notes.push(r.note);
    } catch {
    }
  }
  if (notes.length === 0) return silent(`nothing weakened in ${input.files.length} file(s)`);
  return { stdout: host.edit.warn(notes.join("\n\n")), why: `${notes.length} note(s)`, notes };
}
function readStdin(timeoutMs = 3e3) {
  return new Promise((resolve7) => {
    if (process.stdin.isTTY) return resolve7("");
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        process.stdin.pause();
        process.stdin.destroy();
      } catch {
      }
      resolve7(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

// src/history.ts
import { createReadStream as createReadStream3, existsSync as existsSync16, readdirSync as readdirSync13, statSync as statSync10 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { basename as basename6, join as join22 } from "node:path";
import { createInterface as createInterface3 } from "node:readline";

// src/codex.ts
import { createReadStream, existsSync as existsSync13, readdirSync as readdirSync10, readFileSync as readFileSync10, statSync as statSync7 } from "node:fs";
import { basename as basename3, join as join19 } from "node:path";
import { createInterface } from "node:readline";
import * as zlib from "node:zlib";

// src/turns.ts
var TEST_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|test:\w+|jest|vitest|e2e)\b|\b(?:npx\s+|pnpm\s+|yarn\s+|bunx\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test|cypress\s+run|pytest|py\.test|python3?\s+-m\s+(?:pytest|unittest)|unittest|go\s+test|cargo\s+(?:test|nextest)|dotnet\s+test|make\s+(?:test|tests|check)|gradle\w*\s+test|mvnw?\s+.*\btest\b|rspec|phpunit|mix\s+test|swift\s+test|isitdone(?!\s+(?:doctor|init|uninstall|history|hook|update|receipt|detect)\b))\b/;
var CHECK_CMD = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|lint|check|build|verify|validate)\b|\b(?:npx\s+)?(?:tsc|eslint|biome|ruff|mypy|pyright|flake8|go\s+(?:vet|build)|cargo\s+(?:check|clippy|build)|dotnet\s+build)\b/;
var SHELL_EDIT = /\bsed\s+-i\b|\btee\b|\bcat\s*>|(?:^|[^>2&])>\s*(?!\/dev\/null\b)[^&\s]|\bmv\s|\bcp\s|(?:^|[;&|(]\s*)patch\s|\bapply_patch\b|\bgit\s+(?:checkout|restore|stash|revert|cherry-pick|merge|rebase|apply)\b/;
function unquoted(cmd) {
  return cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`/g, '""');
}
function classifyCommand(cmd) {
  if (TEST_CMD.test(cmd)) return "test";
  if (CHECK_CMD.test(cmd)) return "check";
  if (SHELL_EDIT.test(unquoted(cmd))) return "edit";
  return null;
}
var TurnTracker = class {
  constructor(meta, out3, stats) {
    this.meta = meta;
    this.out = out3;
    this.stats = stats;
  }
  meta;
  out;
  stats;
  edits = 0;
  lastEditAt = 0;
  testRuns = 0;
  checkRuns = 0;
  testFails = 0;
  lastTest = null;
  lastText = "";
  lastTextAt = 0;
  pending = /* @__PURE__ */ new Map();
  /** Old id -> the id a pending command now lives under (Codex: call id -> session id -> write_stdin call id). */
  aliases = /* @__PURE__ */ new Map();
  /** Anything happened since the last finalize(): only such turns are closed and remembered for rollback(). */
  active = false;
  /** Closed turns of this session, oldest first, so a host's "undo the last N turns" can retract their claims. */
  turns = [];
  /** A user prompt opened this turn (a prompted turn with no other activity still counts for rollback()). */
  prompt() {
    this.active = true;
  }
  edit(at) {
    this.active = true;
    this.edits++;
    this.lastEditAt = at;
  }
  /** A command was issued; its outcome arrives later via resolve(). */
  command(id2, cmd, at) {
    this.active = true;
    const kind = classifyCommand(cmd);
    if (kind === "test" || kind === "check") this.pending.set(id2, { kind, at });
    else if (kind === "edit") this.edit(at);
  }
  key(id2) {
    let k = id2;
    for (let i = 0; i < 16 && this.aliases.has(k); i++) k = this.aliases.get(k);
    return k;
  }
  /** A command finished. `ok` is null when the exit status is unknown (treated as success). */
  resolve(id2, ok, at) {
    const k = this.key(id2);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    this.record(p.kind, ok, at || p.at);
  }
  /** The command is still running; its outcome will arrive under `newId`. Nothing is recorded yet. */
  rekey(oldId, newId) {
    const k = this.key(oldId);
    const p = this.pending.get(k);
    if (!p) return;
    this.pending.delete(k);
    this.aliases.delete(newId);
    this.pending.set(newId, p);
    this.aliases.set(oldId, newId);
    if (k !== oldId) this.aliases.set(k, newId);
  }
  isPending(id2) {
    return this.pending.has(this.key(id2));
  }
  /** The command never ran (declined, aborted): drop it without recording a result. */
  forget(id2) {
    this.pending.delete(this.key(id2));
  }
  /** A command with a known outcome, all at once (paginated Codex items, Gemini tool calls, Cursor bubbles). */
  ran(cmd, ok, at) {
    this.active = true;
    const kind = classifyCommand(cmd);
    if (kind === "test" || kind === "check") this.record(kind, ok, at);
    else if (kind === "edit") this.edit(at);
  }
  record(kind, ok, at) {
    if (kind === "test") {
      this.testRuns++;
      if (ok === false) this.testFails++;
      this.lastTest = { at, ok: ok !== false };
    } else {
      this.checkRuns++;
    }
  }
  text(t, at) {
    if (t.trim() === "") return;
    this.active = true;
    this.lastText = t;
    this.lastTextAt = at;
  }
  /**
   * The host undid the last `n` turns (Codex thread_rolled_back): the open turn is closed first and counts as one of
   * them; their claims are retracted and editTurns adjusted.
   */
  rollback(n) {
    this.finalize();
    for (let i = 0; i < n; i++) {
      const t = this.turns.pop();
      if (!t) break;
      if (t.edited) this.stats.editTurns--;
      if (t.claim) {
        const k = this.out.lastIndexOf(t.claim);
        if (k >= 0) this.out.splice(k, 1);
      }
    }
  }
  /** Close the turn: classify its final claim (if any) and reset. A no-op when nothing happened since the last close. */
  finalize() {
    if (!this.active) return;
    let pushed = null;
    const at = this.lastTextAt || this.lastEditAt;
    const inWindow = (!this.meta.sinceMs || at >= this.meta.sinceMs) && (!this.meta.untilMs || at > 0 && at <= this.meta.untilMs);
    const counted = this.edits > 0 && inWindow;
    if (counted) this.stats.editTurns++;
    if (this.edits > 0 || this.testRuns > 0) {
      const claim = findClaim(this.lastText);
      if (claim && counted) {
        let verdict;
        if (this.testRuns === 0 || !this.lastTest) verdict = "NEVER_RAN";
        else if (!this.lastTest.ok) verdict = "FAILED";
        else if (this.lastEditAt > this.lastTest.at) verdict = "STALE";
        else verdict = "VERIFIED";
        pushed = {
          project: this.meta.project(),
          session: this.meta.session,
          at: new Date(this.lastTextAt || 0).toISOString(),
          verdict,
          claim: claim.sentence,
          pattern: claim.pattern,
          edits: this.edits,
          testRuns: this.testRuns,
          checkRuns: this.checkRuns,
          testFails: this.testFails,
          agent: this.meta.agent
        };
        if (this.meta.lossy) pushed.lossy = true;
        this.out.push(pushed);
      }
    }
    this.turns.push({ claim: pushed, edited: counted });
    this.active = false;
    this.edits = 0;
    this.lastEditAt = 0;
    this.testRuns = 0;
    this.checkRuns = 0;
    this.testFails = 0;
    this.lastTest = null;
    this.lastText = "";
    this.lastTextAt = 0;
    this.pending.clear();
    this.aliases.clear();
  }
};
function ts(v) {
  const n = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : 0;
}

// src/codex.ts
var CONTEXTUAL_PREFIXES = ["<user_instructions>", "<environment_context>", "<environments_instructions>", "<apps_instructions>", "<skills_instructions>", "<plugins_instructions>", "<tools>", "<collaboration_mode>", "<multi_agent_mode>", "<realtime_conversation>", "<context_window>", "<context_window_guidance>", "<rollout_budget>", "<token_budget>", "<permissions instructions>", "<model_switch>", "<managed_developer_instructions>", "<persistent_mode>", "<multi_agent_role>", "<git_attribution>", "<personality_spec>"];
function codexSessionFiles(codexDir, since) {
  const files = [];
  let skipped = 0;
  const consider = (p) => {
    if (!/^rollout-.*\.jsonl(?:\.zst)?$/.test(basename3(p))) return;
    if (p.endsWith(".zst") && typeof zlib.zstdDecompressSync !== "function") {
      skipped++;
      return;
    }
    try {
      if (since && statSync7(p).mtimeMs < since.getTime()) {
        skipped++;
        return;
      }
    } catch {
      skipped++;
      return;
    }
    files.push(p);
  };
  const walk = (dir2, depth) => {
    let entries;
    try {
      entries = readdirSync10(dir2);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join19(dir2, e);
      let st;
      try {
        st = statSync7(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else consider(p);
    }
  };
  const sessions = join19(codexDir, "sessions");
  if (existsSync13(sessions)) walk(sessions, 0);
  const archived = join19(codexDir, "archived_sessions");
  if (existsSync13(archived)) walk(archived, 0);
  return { files, skipped };
}
function obj2(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function rawText(payload) {
  const parts = [];
  for (const c of Array.isArray(payload.content) ? payload.content : []) {
    const t = c && typeof c.text === "string" ? c.text : null;
    if (t !== null && (c.type === "input_text" || c.type === "output_text" || c.type === "text")) parts.push(t);
  }
  return parts.join("\n");
}
function messageText(payload) {
  let text = rawText(payload);
  if (text === "") return null;
  const lower = text.trimStart().toLowerCase();
  if (CONTEXTUAL_PREFIXES.some((p) => lower.startsWith(p))) return null;
  const marker = "## My request for Codex:";
  const i = text.indexOf(marker);
  if (i >= 0) text = text.slice(i + marker.length);
  return text.trim() === "" ? null : text;
}
function commandOf(payload) {
  const name = typeof payload.name === "string" ? payload.name : "";
  if (!/^(?:exec_command|shell|shell_command|unified_exec|container\.exec|bash)$/.test(name)) return null;
  let args = {};
  try {
    args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : obj2(payload.arguments) ?? {};
  } catch {
    return null;
  }
  const c = args.cmd ?? args.command;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return null;
}
function stdinSession(payload) {
  if (payload.name !== "write_stdin") return null;
  try {
    const args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : obj2(payload.arguments) ?? {};
    const sid = args.session_id;
    return typeof sid === "number" || typeof sid === "string" && sid !== "" ? String(sid) : null;
  } catch {
    return null;
  }
}
function commandOutcome(output) {
  const text = typeof output === "string" ? output : Array.isArray(output) ? output.map((c) => obj2(c)?.text ?? "").join("\n") : "";
  const none = { ok: null, running: null, rejected: false };
  const exited = /^Process exited with code (-?\d+)\s*$/m.exec(text) ?? /^Exit code: (-?\d+)\s*$/m.exec(text);
  if (exited) return { ...none, ok: Number(exited[1]) === 0 };
  const running = /^Process running with session ID (\S+)\s*$/m.exec(text);
  if (running) return { ...none, running: running[1] };
  if (text.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(text);
      if (j.metadata && typeof j.metadata.exit_code === "number") return { ...none, ok: j.metadata.exit_code === 0 };
    } catch {
    }
  }
  if (/^(?:exec command rejected|command rejected|rejected by user|approval (?:denied|rejected)|user (?:declined|rejected))/im.test(text)) return { ...none, rejected: true };
  if (/^(?:command failed|error:|FAIL\b|failed)/im.test(text) && /exit(?:ed)? (?:with )?(?:code |status )?[1-9]/i.test(text)) return { ...none, ok: false };
  return none;
}
async function readLines(file) {
  if (file.endsWith(".zst")) {
    const decompress = zlib.zstdDecompressSync;
    const text = decompress(readFileSync10(file)).toString("utf8");
    return (async function* () {
      for (const l of text.split("\n")) yield l;
    })();
  }
  const stream = createReadStream(file, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  return (async function* () {
    try {
      for await (const l of rl) yield l;
    } finally {
      rl.close();
      await new Promise((resolve7) => {
        if (stream.destroyed || stream.closed) return resolve7();
        stream.once("close", () => resolve7());
        stream.destroy();
      });
    }
  })();
}
async function scanCodexSession(file, opts, out3, stats) {
  const session = basename3(file).replace(/\.jsonl(?:\.zst)?$/, "");
  let cwd = null;
  const turn = new TurnTracker({ project: () => cwd ?? "codex", session, agent: "codex", sinceMs: opts.since ? opts.since.getTime() : 0, untilMs: opts.until ? opts.until.getTime() : 0 }, out3, stats);
  let first = true;
  let sawTurnEvents = false;
  let v0 = false;
  let v0At = 0;
  const seen = /* @__PURE__ */ new Set();
  for await (const line of await readLines(file)) {
    if (!line.startsWith("{")) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    let at = ts(j.timestamp);
    let type = j.type;
    let payload = obj2(j.payload) ?? {};
    if (first) {
      first = false;
      if (type === "session_meta" && typeof payload.cwd === "string") cwd = payload.cwd;
      if (type === "session_meta") continue;
      if (type === void 0 && typeof j.id === "string" && j.payload === void 0) {
        v0 = true;
        v0At = at;
        continue;
      }
    }
    if (v0) {
      if (j.record_type !== void 0) continue;
      payload = j;
      type = "response_item";
      at = ++v0At;
    }
    if (type === "turn_context" && typeof payload.cwd === "string") cwd = payload.cwd;
    if (type === "event_msg") {
      const et = payload.type;
      if (et === "turn_started" || et === "task_started") {
        if (sawTurnEvents) turn.finalize();
        sawTurnEvents = true;
        turn.prompt();
      } else if (et === "thread_rolled_back") {
        if (typeof payload.num_turns === "number" && payload.num_turns > 0) turn.rollback(payload.num_turns);
      } else if (et === "turn_complete" || et === "task_complete") {
        if (typeof payload.last_agent_message === "string") turn.text(payload.last_agent_message, at);
        sawTurnEvents = true;
        turn.finalize();
      } else if (et === "turn_aborted" || et === "task_aborted") {
        if (typeof payload.last_agent_message === "string") turn.text(payload.last_agent_message, at);
        turn.finalize();
      } else if (et === "user_message" && !sawTurnEvents) {
        turn.finalize();
        turn.prompt();
      } else if (et === "agent_message" && typeof payload.message === "string") {
        turn.text(payload.message, at);
      } else if (et === "patch_apply_end") {
        const id2 = typeof payload.call_id === "string" ? payload.call_id : "";
        if (!(id2 && seen.has(id2)) && payload.success !== false) turn.edit(at);
        if (id2) seen.add(id2);
      } else if (et === "item_completed") {
        const item = obj2(payload.item) ?? {};
        const kind = item.type;
        const id2 = typeof item.id === "string" ? item.id : "";
        if (kind === "FileChange") {
          if (!(id2 && seen.has(id2)) && item.status !== "failed" && item.status !== "declined") turn.edit(at);
          if (id2) seen.add(id2);
        } else if (kind === "CommandExecution") {
          const cmd = Array.isArray(item.command) ? item.command.map(String).join(" ") : typeof item.command === "string" ? item.command : "";
          const ok = typeof item.exit_code === "number" ? item.exit_code === 0 : item.status === "failed" ? false : null;
          const neverRan = ok === null && (item.status === "declined" || item.status === "in_progress");
          if (id2 && seen.has(id2)) {
            if (neverRan) turn.forget(id2);
            else if (turn.isPending(id2)) turn.resolve(id2, ok, at);
          } else {
            if (id2) seen.add(id2);
            if (!neverRan) turn.ran(cmd, ok, at);
          }
        } else if (kind === "AgentMessage") {
          const t = (Array.isArray(item.content) ? item.content : []).map((c) => typeof c.text === "string" ? c.text : "").join("\n");
          if (t.trim()) turn.text(t, at);
        } else if (kind === "UserMessage") {
          if (!sawTurnEvents) turn.finalize();
          turn.prompt();
        }
      }
      continue;
    }
    if (type !== "response_item") continue;
    const pt = payload.type;
    if (pt === "message") {
      const role = payload.role;
      const text = messageText(payload);
      if (role === "user" && text !== null) {
        if (!sawTurnEvents) turn.finalize();
        turn.prompt();
      } else if (role === "assistant" && text !== null) turn.text(text, at);
      else if (role === "user" && cwd === null) {
        const m = /<cwd>\s*([^<]+?)\s*<\/cwd>/.exec(rawText(payload));
        if (m) cwd = m[1];
      }
    } else if (pt === "function_call") {
      const id2 = typeof payload.call_id === "string" ? payload.call_id : "";
      const cmd = commandOf(payload);
      const sid = stdinSession(payload);
      if (cmd !== null) {
        if (id2) seen.add(id2);
        turn.command(id2, cmd, at);
      } else if (sid !== null && id2) {
        turn.rekey(`session:${sid}`, id2);
      }
    } else if (pt === "local_shell_call") {
      const action = obj2(payload.action) ?? {};
      const cmd = Array.isArray(action.command) ? action.command.map(String).join(" ") : "";
      const id2 = typeof payload.call_id === "string" ? payload.call_id : "";
      if (cmd) {
        if (id2) seen.add(id2);
        turn.command(id2, cmd, at);
      }
    } else if (pt === "function_call_output") {
      const id2 = typeof payload.call_id === "string" ? payload.call_id : "";
      const o = commandOutcome(payload.output);
      if (o.running !== null) turn.rekey(id2, `session:${o.running}`);
      else if (o.rejected) turn.forget(id2);
      else turn.resolve(id2, o.ok, at);
    } else if (pt === "custom_tool_call") {
      const id2 = typeof payload.call_id === "string" ? payload.call_id : "";
      if (payload.name === "apply_patch") {
        if (!(id2 && seen.has(id2))) turn.edit(at);
        if (id2) seen.add(id2);
      }
    }
  }
  turn.finalize();
}

// src/cursor.ts
import { existsSync as existsSync14, readdirSync as readdirSync11, readFileSync as readFileSync11, statSync as statSync8 } from "node:fs";
import { createRequire } from "node:module";
import { homedir as homedir6 } from "node:os";
import { basename as basename4, join as join20 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var sqliteCache;
function loadSqlite() {
  if (sqliteCache !== void 0) return sqliteCache;
  const warn = process.emitWarning;
  const quiet = (...args) => {
    if (!/sqlite/i.test(String(args[0]))) warn.apply(process, args);
  };
  process.emitWarning = quiet;
  let mod = null;
  try {
    const get = process.getBuiltinModule;
    if (typeof get === "function") mod = get.call(process, "node:sqlite");
    if (!mod) mod = createRequire(import.meta.url)("node:sqlite");
  } catch {
    mod = null;
  } finally {
    process.emitWarning = warn;
  }
  const m = mod;
  sqliteCache = m && typeof m.DatabaseSync === "function" ? m : null;
  return sqliteCache;
}
function defaultCursorDir() {
  return join20(homedir6(), ".cursor");
}
function defaultCursorUserDir() {
  if (process.platform === "win32") return join20(process.env.APPDATA && process.env.APPDATA !== "" ? process.env.APPDATA : join20(homedir6(), "AppData", "Roaming"), "Cursor", "User");
  if (process.platform === "darwin") return join20(homedir6(), "Library", "Application Support", "Cursor", "User");
  return join20(process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== "" ? process.env.XDG_CONFIG_HOME : join20(homedir6(), ".config"), "Cursor", "User");
}
function obj3(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function isDir2(p) {
  try {
    return statSync8(p).isDirectory();
  } catch {
    return false;
  }
}
function valueJson(v) {
  try {
    const text = typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("utf8") : "";
    return text ? obj3(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}
function parseJson(v) {
  if (typeof v !== "string") return obj3(v);
  try {
    return obj3(JSON.parse(v));
  } catch {
    return null;
  }
}
function uriToPath(uri) {
  try {
    if (uri.startsWith("file:")) return fileURLToPath2(uri);
  } catch {
  }
  try {
    return decodeURIComponent(uri);
  } catch {
    return uri;
  }
}
function workspaceFolders(userDir) {
  const map = /* @__PURE__ */ new Map();
  const ws = join20(userDir, "workspaceStorage");
  if (!isDir2(ws)) return map;
  for (const id2 of readdirSync11(ws)) {
    try {
      const j = obj3(JSON.parse(readFileSync11(join20(ws, id2, "workspace.json"), "utf8")));
      const uri = typeof j?.folder === "string" ? j.folder : typeof j?.workspace === "string" ? j.workspace : null;
      if (uri) map.set(id2, uriToPath(uri));
    } catch {
    }
  }
  return map;
}
var TERMINAL_TOOL = /^(?:run_terminal_(?:cmd|commands?|command_v2)|run_test|Shell|shell)$/;
var EDIT_TOOL = /^(?:edit_file(?:_v2)?|search_replace|new_file|reapply|delete_file|apply_agent_diff|new_edit|save_file|create_rm_files|undo_edit|Write|StrReplace|Edit|MultiEdit|edit|delete|Delete)$/;
function openDb(sqlite, path) {
  try {
    return new sqlite.DatabaseSync(path, { readOnly: true, timeout: 2e3 });
  } catch {
    return new sqlite.DatabaseSync(path, { readOnly: true });
  }
}
function composerProjects(sqlite, db, userDir, folders) {
  const projects = /* @__PURE__ */ new Map();
  const subagents = /* @__PURE__ */ new Set();
  try {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    const j = row ? valueJson(row.value) : null;
    for (const c of Array.isArray(j?.allComposers) ? j.allComposers : []) {
      const h = obj3(c);
      const id2 = typeof h?.composerId === "string" ? h.composerId : null;
      if (!h || !id2) continue;
      if (h.isSubagent === true) subagents.add(id2);
      const wi = obj3(h.workspaceIdentifier);
      const uri = obj3(wi?.uri);
      const p = typeof uri?.fsPath === "string" ? uri.fsPath : typeof uri?.external === "string" ? uriToPath(uri.external) : typeof wi?.id === "string" ? folders.get(wi.id) ?? null : null;
      if (p) projects.set(id2, p);
    }
  } catch {
  }
  for (const [id2, folder] of folders) {
    const p = join20(userDir, "workspaceStorage", id2, "state.vscdb");
    if (!existsSync14(p)) continue;
    let wdb = null;
    try {
      wdb = openDb(sqlite, p);
      const row = wdb.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
      const j = row ? valueJson(row.value) : null;
      for (const c of Array.isArray(j?.allComposers) ? j.allComposers : []) {
        const cid = obj3(c)?.composerId;
        if (typeof cid === "string" && !projects.has(cid)) projects.set(cid, folder);
      }
    } catch {
    } finally {
      try {
        wdb?.close();
      } catch {
      }
    }
  }
  return { projects, subagents };
}
function bubbleAt(b, fallback) {
  const t = ts(b.createdAt);
  if (t > 1e12) return t;
  const ti = obj3(b.timingInfo);
  for (const k of ["clientRpcSendTime", "clientSettleTime", "clientEndTime", "clientStartTime"]) {
    const v = ti?.[k];
    if (typeof v === "number" && v > 1e12) return v;
  }
  return fallback;
}
function commandText(params) {
  const c = params?.command ?? params?.cmd ?? params?.commands;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(String).join(" && ");
  return "";
}
function feedBubble(turn, b, at) {
  if (b.type === 1) {
    turn.finalize();
    turn.prompt();
    return;
  }
  if (b.type !== 2) return;
  const tf = obj3(b.toolFormerData);
  const toolId = typeof tf?.tool === "number" ? tf.tool : typeof tf?.tool === "string" ? Number(tf.tool) : NaN;
  const name = typeof tf?.name === "string" ? tf.name : "";
  if (tf && (name || Number.isFinite(toolId))) {
    const status = typeof tf.status === "string" ? tf.status : typeof obj3(tf.additionalData)?.status === "string" ? obj3(tf.additionalData)?.status : void 0;
    const params = parseJson(tf.params ?? tf.rawArgs);
    const result = parseJson(tf.result);
    if (toolId === 15 || TERMINAL_TOOL.test(name)) {
      const cmd = commandText(params);
      const declined = tf.userDecision === "rejected" || result?.rejected === true || status === "cancelled";
      if (cmd && !declined) {
        const code = typeof result?.exitCodeV2 === "number" ? result.exitCodeV2 : typeof result?.exitCode === "number" ? result.exitCode : null;
        if (code !== null) turn.ran(cmd, code === 0, at);
        else if (status === "error") turn.ran(cmd, false, at);
        else if (result?.notInterrupted !== false && status !== "running") turn.ran(cmd, null, at);
      }
    } else if (toolId === 38 || toolId === 11 || EDIT_TOOL.test(name)) {
      if (status === "completed" || status === void 0 && tf.result != null) turn.edit(at);
    }
  }
  if (b.capabilityType === 30) return;
  if (typeof b.text === "string" && b.text.trim()) turn.text(b.text, at);
}
function openCursorStore(userDir, opts = {}) {
  const path = join20(userDir, "globalStorage", "state.vscdb");
  if (!existsSync14(path)) return null;
  const sqlite = opts.sqlite === void 0 ? loadSqlite() : opts.sqlite;
  if (!sqlite) return null;
  const db = openDb(sqlite, path);
  const folders = workspaceFolders(userDir);
  const { projects, subagents } = composerProjects(sqlite, db, userDir, folders);
  return {
    path,
    composers() {
      const list = [];
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'").all();
      for (const row of rows) {
        const id2 = String(row.key).slice("composerData:".length);
        const cd = valueJson(row.value);
        if (!id2 || !cd) continue;
        const wi = obj3(cd.workspaceIdentifier);
        const uri = obj3(wi?.uri);
        const worktree = obj3(cd.gitWorktree)?.worktreePath;
        let project = projects.get(id2) ?? null;
        if (project === null && typeof uri?.fsPath === "string") project = uri.fsPath;
        if (project === null && typeof wi?.id === "string") project = folders.get(wi.id) ?? null;
        if (project === null && typeof worktree === "string") project = worktree;
        const order2 = [];
        for (const h of Array.isArray(cd.fullConversationHeadersOnly) ? cd.fullConversationHeadersOnly : []) {
          const bid = obj3(h)?.bubbleId;
          if (typeof bid === "string") order2.push(bid);
        }
        const mode = typeof cd.unifiedMode === "string" ? cd.unifiedMode : null;
        list.push({
          id: id2,
          project,
          createdAt: ts(cd.createdAt),
          updatedAt: ts(cd.lastUpdatedAt) || ts(cd.createdAt),
          subagent: id2.startsWith("task-") || cd.isSubagent === true || subagents.has(id2),
          // Chat-mode composers never edit files; unknown modes (older rows) are scanned.
          agentic: cd.isAgentic === true || mode === null || mode === "agent",
          order: order2
        });
      }
      return list;
    },
    scan(c, opts2, label, out3, stats) {
      const turn = new TurnTracker({ project: () => label, session: c.id, agent: "cursor", sinceMs: opts2.since ? opts2.since.getTime() : 0, untilMs: opts2.until ? opts2.until.getTime() : 0 }, out3, stats);
      const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?").all(`bubbleId:${c.id}:`, `bubbleId:${c.id};`);
      const index = /* @__PURE__ */ new Map();
      c.order.forEach((bid, i) => index.set(bid, i));
      const bubbles = [];
      for (const row of rows) {
        const b = valueJson(row.value);
        if (!b) continue;
        const bid = typeof b.bubbleId === "string" ? b.bubbleId : String(row.key).split(":").pop() ?? "";
        const pos = index.get(bid) ?? Number.MAX_SAFE_INTEGER;
        bubbles.push({ b, at: bubbleAt(b, 0), pos });
      }
      bubbles.sort((x, y) => x.pos !== y.pos ? x.pos - y.pos : x.at - y.at);
      let last = c.createdAt;
      for (const { b, at } of bubbles) {
        const t = at || ++last;
        last = Math.max(last, t);
        feedBubble(turn, b, t);
      }
      turn.finalize();
    },
    close() {
      try {
        db.close();
      } catch {
      }
    }
  };
}
function transcriptProjectLabel(dir2, slug) {
  try {
    const j = obj3(JSON.parse(readFileSync11(join20(dir2, "repo.json"), "utf8")));
    for (const k of ["workspace", "rootPath", "path"]) {
      const v = j?.[k];
      if (typeof v === "string" && v) return v;
    }
  } catch {
  }
  return `cursor:${slug}`;
}
function cursorTranscriptFiles(cursorDir, since, includeSubagents = false) {
  const files = [];
  let skipped = 0;
  const projects = join20(cursorDir, "projects");
  if (!isDir2(projects)) return { files, skipped };
  const consider = (p, slug, label) => {
    try {
      if (since && statSync8(p).mtimeMs < since.getTime()) skipped++;
      else files.push({ file: p, slug, label });
    } catch {
      skipped++;
    }
  };
  const walk = (dir2, slug, label, depth) => {
    for (const e of readdirSync11(dir2)) {
      const p = join20(dir2, e);
      if (e.endsWith(".jsonl")) {
        if (!isDir2(p)) consider(p, slug, label);
      } else if (depth < 2 && isDir2(p)) {
        if (e === "subagents" && !includeSubagents) continue;
        walk(p, slug, label, depth + 1);
      }
    }
  };
  for (const slug of readdirSync11(projects)) {
    const dir2 = join20(projects, slug);
    const transcripts = join20(dir2, "agent-transcripts");
    if (!isDir2(transcripts)) continue;
    walk(transcripts, slug, transcriptProjectLabel(dir2, slug), 0);
  }
  return { files, skipped };
}
function transcriptComposerId(file) {
  return basename4(file, ".jsonl");
}
function scanCursorTranscript(file, opts, label, out3, stats) {
  const lines = readFileSync11(file, "utf8").split(/\r?\n/);
  const mtime = statSync8(file).mtimeMs;
  const turn = new TurnTracker({ project: () => label, session: transcriptComposerId(file), agent: "cursor", sinceMs: opts.since ? opts.since.getTime() : 0, untilMs: opts.until ? opts.until.getTime() : 0, lossy: true }, out3, stats);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("{")) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    const at = mtime - (lines.length - 1 - i);
    const content = obj3(j.message)?.content;
    const blocks = Array.isArray(content) ? content : [];
    if (j.role === "user") {
      turn.finalize();
      turn.prompt();
    } else if (j.role === "assistant") {
      const texts = [];
      for (const blk of blocks) {
        const b = obj3(blk);
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text.replace(/\[REDACTED\]/g, " "));
        if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "";
          const input = obj3(b.input);
          if (EDIT_TOOL.test(name)) turn.edit(at);
          else if (TERMINAL_TOOL.test(name)) {
            const cmd = commandText(input);
            if (cmd) turn.ran(cmd, null, at);
          }
        }
      }
      const text = texts.join("\n");
      if (text.trim()) turn.text(text, at);
    }
  }
  turn.finalize();
}

// src/gemini.ts
import { createReadStream as createReadStream2, readdirSync as readdirSync12, readFileSync as readFileSync12, statSync as statSync9 } from "node:fs";
import { homedir as homedir7 } from "node:os";
import { basename as basename5, join as join21 } from "node:path";
import { createInterface as createInterface2 } from "node:readline";
var EDIT_TOOLS = /* @__PURE__ */ new Set(["replace", "write_file", "edit", "notebook_edit", "edit_file", "create_file", "smart_edit"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["run_shell_command", "shell", "bash", "execute_bash_command"]);
function obj4(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}
function isDir3(p) {
  try {
    return statSync9(p).isDirectory();
  } catch {
    return false;
  }
}
function tooOld(p, since) {
  try {
    return since !== null && statSync9(p).mtimeMs < since.getTime();
  } catch {
    return null;
  }
}
function defaultGeminiDir() {
  const home = process.env.GEMINI_CLI_HOME && process.env.GEMINI_CLI_HOME !== "" ? process.env.GEMINI_CLI_HOME : homedir7();
  return join21(home, ".gemini");
}
function defaultQwenDir() {
  return process.env.QWEN_HOME && process.env.QWEN_HOME !== "" ? process.env.QWEN_HOME : join21(homedir7(), ".qwen");
}
function geminiRegistry(geminiDir) {
  const map = /* @__PURE__ */ new Map();
  try {
    const j = JSON.parse(readFileSync12(join21(geminiDir, "projects.json"), "utf8"));
    for (const [path, slug] of Object.entries(obj4(j.projects) ?? {})) if (typeof slug === "string" && !map.has(slug)) map.set(slug, path);
  } catch {
  }
  return map;
}
function geminiProjectLabel(geminiDir, id2, registry) {
  try {
    const owner = readFileSync12(join21(geminiDir, "tmp", id2, ".project_root"), "utf8").trim();
    if (owner) return owner;
  } catch {
  }
  return (registry ?? geminiRegistry(geminiDir)).get(id2) ?? `gemini:${id2}`;
}
function geminiSessionFiles(geminiDir, since, includeSubagents = false) {
  const files = [];
  let skipped = 0;
  const tmp = join21(geminiDir, "tmp");
  if (!isDir3(tmp)) return { files, skipped };
  const registry = geminiRegistry(geminiDir);
  const consider = (p, slug, label) => {
    const old = tooOld(p, since);
    if (old === null || old) skipped++;
    else files.push({ file: p, slug, label });
  };
  for (const id2 of readdirSync12(tmp)) {
    const chats = join21(tmp, id2, "chats");
    if (!isDir3(chats)) continue;
    let label = null;
    for (const f of readdirSync12(chats)) {
      const p = join21(chats, f);
      if (/^session-.*\.jsonl?$/.test(f)) {
        if (!isDir3(p)) consider(p, id2, label ??= geminiProjectLabel(geminiDir, id2, registry));
      } else if (includeSubagents && isDir3(p)) {
        for (const s of readdirSync12(p)) if (s.endsWith(".jsonl")) consider(join21(p, s), id2, label ??= geminiProjectLabel(geminiDir, id2, registry));
      }
    }
  }
  return { files, skipped };
}
function qwenSessionFiles(qwenDir, since) {
  const files = [];
  let skipped = 0;
  const projects = join21(qwenDir, "projects");
  if (!isDir3(projects)) return { files, skipped };
  for (const slug of readdirSync12(projects)) {
    const chats = join21(projects, slug, "chats");
    if (!isDir3(chats)) continue;
    for (const f of readdirSync12(chats)) {
      if (!/^[0-9a-fA-F-]{32,36}\.jsonl$/.test(f)) continue;
      const p = join21(chats, f);
      const old = tooOld(p, since);
      if (old === null || old) skipped++;
      else files.push({ file: p, slug, label: `qwen:${slug}` });
    }
  }
  return { files, skipped };
}
function partsText(content) {
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : content ? [content] : [];
  const texts = [];
  for (const p of parts) {
    const o = obj4(p);
    if (o && typeof o.text === "string" && o.thought !== true) texts.push(o.text);
  }
  return texts.join("\n");
}
function onlyFunctionResponses(content) {
  const parts = Array.isArray(content) ? content : [];
  return parts.length > 0 && parts.every((p) => obj4(p)?.functionResponse !== void 0);
}
function resultText(result) {
  const parts = Array.isArray(result) ? result : result ? [result] : [];
  const texts = [];
  for (const p of parts) {
    const o = obj4(p);
    if (!o) continue;
    if (typeof o.text === "string") texts.push(o.text);
    const resp = obj4(obj4(o.functionResponse)?.response);
    if (resp) {
      if (typeof resp.output === "string") texts.push(resp.output);
      else if (typeof resp.error === "string") texts.push(resp.error);
      else if (typeof resp.content === "string") texts.push(resp.content);
    }
  }
  return texts.join("\n");
}
function geminiShellOutcome(output, status, display) {
  if (status === "cancelled") return { ran: false, ok: null };
  if (/^Command (?:was )?(?:automatically )?cancelled\b|^Command moved to background\b|^Command (?:was )?(?:promoted|backgrounded)\b/m.test(output)) return { ran: false, ok: null };
  const m = /^Exit Code: (-?\d+)\s*$/m.exec(output);
  if (m) return { ran: true, ok: Number(m[1]) === 0 };
  const d = typeof display === "string" ? /^Command exited with code: (-?\d+)/.exec(display) : null;
  if (d) return { ran: true, ok: Number(d[1]) === 0 };
  if (/^Command terminated by signal|^Signal: (?!\(none\))\S/m.test(output)) return { ran: true, ok: false };
  if (status === "success") return { ran: true, ok: true };
  if (status === "error") return { ran: true, ok: false };
  return { ran: true, ok: null };
}
async function readLines2(file) {
  const stream = createReadStream2(file, { encoding: "utf8" });
  const rl = createInterface2({ input: stream, crlfDelay: Infinity });
  const lines = [];
  try {
    for await (const l of rl) lines.push(l);
  } finally {
    rl.close();
    await new Promise((resolve7) => {
      if (stream.destroyed || stream.closed) return resolve7();
      stream.once("close", () => resolve7());
      stream.destroy();
    });
  }
  return lines;
}
async function loadGeminiMessages(file) {
  const messages = /* @__PURE__ */ new Map();
  let meta = {};
  const setAll = (list) => {
    for (const m of Array.isArray(list) ? list : []) {
      const o = obj4(m);
      if (o && typeof o.id === "string") messages.set(o.id, o);
    }
  };
  const apply = (rec) => {
    if (typeof rec.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const at = ids.indexOf(rec.$rewindTo);
      if (at >= 0) for (const id2 of ids.slice(at)) messages.delete(id2);
    } else if (typeof rec.id === "string") {
      messages.set(rec.id, rec);
    } else if (obj4(rec.$set)) {
      const set = rec.$set;
      if (Array.isArray(set.messages)) {
        messages.clear();
        setAll(set.messages);
      }
      meta = { ...meta, ...set };
    } else if (typeof rec.sessionId === "string" && typeof rec.projectHash === "string") {
      meta = { ...meta, ...rec };
      if (Array.isArray(rec.messages)) setAll(rec.messages);
    }
  };
  const whole = () => {
    try {
      const j = obj4(JSON.parse(readFileSync12(file, "utf8")));
      if (!j || !Array.isArray(j.messages)) return false;
      meta = { ...meta, ...j };
      setAll(j.messages);
      return true;
    } catch {
      return false;
    }
  };
  const lines = async () => {
    for (const line of await readLines2(file)) {
      if (!line.startsWith("{")) continue;
      try {
        const rec = obj4(JSON.parse(line));
        if (rec) apply(rec);
      } catch {
      }
    }
  };
  if (file.endsWith(".json")) {
    if (!whole()) await lines();
  } else {
    await lines();
    if (messages.size === 0 && !meta.sessionId) whole();
  }
  return { messages: [...messages.values()], meta };
}
async function scanGeminiSession(file, opts, label, out3, stats) {
  const { messages, meta } = await loadGeminiMessages(file);
  if (meta.kind === "subagent" && !opts.includeSubagents) return;
  const session = basename5(file).replace(/\.jsonl?$/, "");
  const turn = new TurnTracker({ project: () => label, session, agent: "gemini", sinceMs: opts.since ? opts.since.getTime() : 0, untilMs: opts.until ? opts.until.getTime() : 0 }, out3, stats);
  for (const m of messages) {
    const at = ts(m.timestamp);
    if (m.type === "user") {
      if (onlyFunctionResponses(m.content)) continue;
      turn.finalize();
      turn.prompt();
      continue;
    }
    if (m.type !== "gemini") continue;
    const text = partsText(m.content);
    if (text.trim()) turn.text(text, at);
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const call = obj4(tc);
      if (!call) continue;
      const name = typeof call.name === "string" ? call.name : "";
      const status = typeof call.status === "string" ? call.status : void 0;
      const callAt = ts(call.timestamp) || at;
      if (EDIT_TOOLS.has(name)) {
        if (status === "success") turn.edit(callAt);
      } else if (SHELL_TOOLS.has(name)) {
        const args = obj4(call.args) ?? {};
        const cmd = typeof args.command === "string" ? args.command : "";
        if (!cmd) continue;
        const o = geminiShellOutcome(resultText(call.result), status, call.resultDisplay);
        if (o.ran) turn.ran(cmd, o.ok, callAt);
      }
    }
  }
  turn.finalize();
}
var QWEN_NON_PROMPT = /* @__PURE__ */ new Set(["goal_runtime", "notification", "cron", "mid_turn_user_message", "realtime_message"]);
async function scanQwenSession(file, opts, project, out3, stats) {
  const session = basename5(file, ".jsonl");
  let cwd = null;
  const turn = new TurnTracker({ project: () => cwd ?? project.label, session, agent: "qwen", sinceMs: opts.since ? opts.since.getTime() : 0, untilMs: opts.until ? opts.until.getTime() : 0 }, out3, stats);
  const edits = /* @__PURE__ */ new Map();
  const recs = [];
  for (const line of await readLines2(file)) {
    if (!line.startsWith("{")) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
    }
  }
  let live = null;
  if (recs.some((r) => r.subtype === "rewind")) {
    const byUuid = /* @__PURE__ */ new Map();
    for (const r of recs) if (typeof r.uuid === "string") byUuid.set(r.uuid, r);
    live = /* @__PURE__ */ new Set();
    let cur = recs[recs.length - 1];
    while (cur && typeof cur.uuid === "string" && !live.has(cur.uuid)) {
      live.add(cur.uuid);
      cur = typeof cur.parentUuid === "string" ? byUuid.get(cur.parentUuid) : void 0;
    }
  }
  for (const j of recs) {
    if (live && typeof j.uuid === "string" && !live.has(j.uuid)) continue;
    if (j.isSidechain === true && !opts.includeSubagents) continue;
    if (typeof j.cwd === "string" && j.cwd) {
      if (!cwd) project.sawCwd(j.cwd);
      cwd = j.cwd;
    }
    const at = ts(j.timestamp);
    const message = obj4(j.message);
    const parts = message && Array.isArray(message.parts) ? message.parts : [];
    if (j.type === "user") {
      if (typeof j.subtype === "string" && QWEN_NON_PROMPT.has(j.subtype)) continue;
      if (onlyFunctionResponses(parts)) continue;
      turn.finalize();
      turn.prompt();
    } else if (j.type === "assistant") {
      const text = partsText(parts);
      if (text.trim()) turn.text(text, at);
      for (const p of parts) {
        const fc = obj4(obj4(p)?.functionCall);
        if (!fc) continue;
        const name = typeof fc.name === "string" ? fc.name : "";
        const id2 = typeof fc.id === "string" && fc.id ? fc.id : name;
        if (EDIT_TOOLS.has(name)) edits.set(id2, name);
        else if (SHELL_TOOLS.has(name)) {
          const args = obj4(fc.args) ?? {};
          if (typeof args.command === "string") turn.command(id2, args.command, at);
        }
      }
    } else if (j.type === "tool_result") {
      const result = obj4(j.toolCallResult) ?? {};
      const status = typeof result.status === "string" ? result.status : void 0;
      for (const p of parts) {
        const fr = obj4(obj4(p)?.functionResponse);
        if (!fr) continue;
        const name = typeof fr.name === "string" ? fr.name : "";
        const id2 = typeof fr.id === "string" && fr.id ? fr.id : name;
        const resp = obj4(fr.response) ?? {};
        if (edits.has(id2) || EDIT_TOOLS.has(name)) {
          edits.delete(id2);
          if (status === "success" || status === void 0 && result.error === void 0 && resp.error === void 0) turn.edit(at);
        } else if (turn.isPending(id2) || SHELL_TOOLS.has(name)) {
          const o = geminiShellOutcome(resultText([p]), status, result.resultDisplay);
          if (o.ran) turn.resolve(id2, o.ok, at);
          else turn.forget(id2);
        }
      }
    } else if (j.type === "system" && j.subtype === "turn_result") {
      const sp = obj4(j.systemPayload) ?? {};
      if (sp.state === "completed" && typeof sp.resultText === "string") turn.text(sp.resultText, at);
    }
  }
  turn.finalize();
}

// src/history.ts
var EDIT_TOOLS2 = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_editor", "str_replace_based_edit_tool", "create_file", "apply_patch"]);
function projectLabel(slug, cwd) {
  if (cwd) return cwd;
  return slug.replace(/^([A-Za-z])--/, "$1:/").replace(/^-/, "/").replace(/-/g, "/");
}
async function scanSession(file, opts, project, out3, stats) {
  const stream = createReadStream3(file, { encoding: "utf8" });
  const rl = createInterface3({ input: stream, crlfDelay: Infinity });
  const session = basename6(file, ".jsonl");
  let cwd = null;
  const turn = new TurnTracker({ project: () => cwd ?? project.label, session, agent: "claude-code", sinceMs: opts.since ? opts.since.getTime() : 0, untilMs: opts.until ? opts.until.getTime() : 0 }, out3, stats);
  for await (const line of rl) {
    if (!line.startsWith("{")) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.isSidechain === true && !opts.includeSubagents) continue;
    if (typeof j.cwd === "string" && j.cwd) {
      if (!cwd) project.sawCwd(j.cwd);
      cwd = j.cwd;
    }
    const type = j.type;
    const at = ts(j.timestamp);
    const message = j.message;
    if (type === "user" && message) {
      const content = message.content;
      const blocks = Array.isArray(content) ? content : null;
      const isToolResult = blocks !== null && blocks.some((b) => b && b.type === "tool_result");
      if (isToolResult) {
        for (const b of blocks) {
          if (!b || b.type !== "tool_result") continue;
          const id2 = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
          turn.resolve(id2, b.is_error !== true, at);
        }
        continue;
      }
      turn.finalize();
      turn.prompt();
      continue;
    }
    if (type === "assistant" && message && Array.isArray(message.content)) {
      const texts = [];
      for (const b of message.content) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
        if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "";
          const input = b.input ?? {};
          const id2 = typeof b.id === "string" ? b.id : "";
          if (EDIT_TOOLS2.has(name)) turn.edit(at);
          else if (name === "Bash" || name === "PowerShell" || name === "bash" || name === "shell" || name === "exec_command") {
            const cmd = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : "";
            turn.command(id2, cmd, at);
          }
        }
      }
      if (texts.length > 0) turn.text(texts.join("\n"), at);
    }
  }
  turn.finalize();
  rl.close();
  await new Promise((resolve7) => {
    if (stream.destroyed || stream.closed) return resolve7();
    stream.once("close", () => resolve7());
    stream.destroy();
  });
}
function defaultProjectsDir() {
  return join22(homedir8(), ".claude", "projects");
}
function defaultCodexDir() {
  return process.env.CODEX_HOME && process.env.CODEX_HOME !== "" ? process.env.CODEX_HOME : join22(homedir8(), ".codex");
}
async function scanHistory(opts = {}) {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const codexDir = opts.codexDir === void 0 ? defaultCodexDir() : opts.codexDir;
  const geminiDir = opts.geminiDir === void 0 ? defaultGeminiDir() : opts.geminiDir;
  const qwenDir = opts.qwenDir === void 0 ? defaultQwenDir() : opts.qwenDir;
  const cursorDir = opts.cursorDir === void 0 ? defaultCursorDir() : opts.cursorDir;
  const cursorUserDir = opts.cursorUserDir === void 0 ? defaultCursorUserDir() : opts.cursorUserDir;
  const exclude = (opts.exclude ?? []).map((e) => e.toLowerCase()).filter(Boolean);
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const report = {
    projectsDir,
    codexDir,
    geminiDir,
    qwenDir,
    cursorDir,
    cursorUserDir,
    cursorSource: null,
    scannedFiles: 0,
    skippedFiles: 0,
    excludedDirs: [],
    sessions: 0,
    editTurns: 0,
    claims: [],
    counts: { VERIFIED: 0, STALE: 0, FAILED: 0, NEVER_RAN: 0 },
    byAgent: {},
    verifiedPct: 0,
    unbackedPct: 0,
    byProject: [],
    gate: null,
    since: since ? since.toISOString() : null,
    until: until ? until.toISOString() : null
  };
  const excludedDirs = /* @__PURE__ */ new Set();
  const excluded = (...names) => {
    const hit = names.find((n) => exclude.some((e) => n.toLowerCase().includes(e)));
    if (hit === void 0) return false;
    excludedDirs.add(names[0]);
    return true;
  };
  const items = [];
  if (existsSync16(projectsDir)) {
    for (const slug of readdirSync13(projectsDir)) {
      const dir2 = join22(projectsDir, slug);
      let isDir4 = false;
      try {
        isDir4 = statSync10(dir2).isDirectory();
      } catch {
        continue;
      }
      if (!isDir4) continue;
      if (excluded(slug)) continue;
      for (const f of readdirSync13(dir2)) {
        const p = join22(dir2, f);
        try {
          const st = statSync10(p);
          if (st.isFile() && f.endsWith(".jsonl")) {
            if (since && st.mtimeMs < since.getTime()) {
              report.skippedFiles++;
              continue;
            }
            items.push({ kind: "file", agent: "claude-code", file: p, slug, label: projectLabel(slug, null) });
          } else if (st.isDirectory() && opts.includeSubagents) {
            const sub = join22(p, "subagents");
            if (existsSync16(sub)) {
              for (const s of readdirSync13(sub)) if (s.endsWith(".jsonl")) items.push({ kind: "file", agent: "claude-code", file: join22(sub, s), slug, label: projectLabel(slug, null) });
            }
          }
        } catch {
          report.skippedFiles++;
        }
      }
    }
  }
  if (codexDir) {
    const { files: codexFiles, skipped } = codexSessionFiles(codexDir, since);
    report.skippedFiles += skipped;
    for (const f of codexFiles) items.push({ kind: "file", agent: "codex", file: f, slug: "codex", label: "codex" });
  }
  if (geminiDir) {
    const { files, skipped } = geminiSessionFiles(geminiDir, since, opts.includeSubagents);
    report.skippedFiles += skipped;
    for (const f of files) if (!excluded(f.slug, f.label)) items.push({ kind: "file", agent: "gemini", ...f });
  }
  if (qwenDir) {
    const { files, skipped } = qwenSessionFiles(qwenDir, since);
    report.skippedFiles += skipped;
    for (const f of files) if (!excluded(f.slug, f.label)) items.push({ kind: "file", agent: "qwen", ...f });
  }
  let store = null;
  const covered = /* @__PURE__ */ new Set();
  if (cursorUserDir && opts.cursorSqlite !== false) {
    try {
      store = openCursorStore(cursorUserDir);
    } catch {
      store = null;
      report.skippedFiles++;
    }
    if (store) {
      report.cursorSource = "sqlite";
      try {
        for (const c of store.composers()) {
          if (!c.project) continue;
          covered.add(c.id);
          if (!c.agentic || c.subagent && !opts.includeSubagents) continue;
          if (since && c.updatedAt && c.updatedAt < since.getTime()) {
            report.skippedFiles++;
            continue;
          }
          const label = c.project;
          if (excluded(label)) continue;
          items.push({ kind: "cursor-db", agent: "cursor", composer: c, label, store });
        }
      } catch {
        try {
          store.close();
        } catch {
        }
        store = null;
        covered.clear();
        report.cursorSource = null;
        report.skippedFiles++;
        for (let k = items.length - 1; k >= 0; k--) if (items[k]?.kind === "cursor-db") items.splice(k, 1);
      }
    }
  }
  if (cursorDir) {
    const { files, skipped } = cursorTranscriptFiles(cursorDir, since, opts.includeSubagents);
    report.skippedFiles += skipped;
    let added = 0;
    for (const f of files) {
      if (covered.has(transcriptComposerId(f.file)) || excluded(f.slug, f.label)) continue;
      items.push({ kind: "file", agent: "cursor", ...f });
      added++;
    }
    if (added > 0) report.cursorSource = store ? "sqlite+transcripts" : "transcripts";
  }
  const labels = /* @__PURE__ */ new Map();
  const stats = { editTurns: 0 };
  let done = 0;
  for (const item of items) {
    const agent = item.agent;
    const before = report.claims.length;
    let lossy = false;
    try {
      if (item.kind === "cursor-db") {
        item.store.scan(item.composer, { since, until }, item.label, report.claims, stats);
      } else if (agent === "codex") await scanCodexSession(item.file, { since, until }, report.claims, stats);
      else if (agent === "gemini") await scanGeminiSession(item.file, { since, until, includeSubagents: opts.includeSubagents }, item.label, report.claims, stats);
      else if (agent === "qwen") {
        const key = `qwen:${item.slug}`;
        await scanQwenSession(item.file, { since, until, includeSubagents: opts.includeSubagents }, { label: labels.get(key) ?? item.label, sawCwd: (cwd) => labels.set(key, cwd) }, report.claims, stats);
      } else if (agent === "cursor") {
        scanCursorTranscript(item.file, { since, until }, item.label, report.claims, stats);
        lossy = true;
      } else {
        const project = {
          label: labels.get(item.slug) ?? item.label,
          sawCwd: (cwd) => {
            if (!labels.has(item.slug)) labels.set(item.slug, cwd);
          }
        };
        await scanSession(item.file, { includeSubagents: opts.includeSubagents, since, until }, project, report.claims, stats);
      }
      report.scannedFiles++;
      report.sessions++;
      const a = report.byAgent[agent] = report.byAgent[agent] ?? { sessions: 0, claims: 0, verified: 0 };
      a.sessions++;
      a.claims += report.claims.length - before;
      a.verified += report.claims.slice(before).filter((c) => c.verdict === "VERIFIED").length;
      if (lossy) a.lossy = (a.lossy ?? 0) + 1;
    } catch {
      report.claims.length = before;
      report.skippedFiles++;
    }
    done++;
    opts.onProgress?.(done, items.length);
  }
  store?.close();
  report.excludedDirs = [...excludedDirs];
  if (exclude.length > 0) {
    const kept = report.claims.filter((c) => !exclude.some((e) => c.project.toLowerCase().includes(e)));
    if (kept.length !== report.claims.length) {
      for (const c of report.claims) {
        if (kept.includes(c)) continue;
        const a = report.byAgent[c.agent];
        if (a) {
          a.claims--;
          if (c.verdict === "VERIFIED") a.verified--;
        }
      }
      report.claims = kept;
    }
  }
  report.editTurns = stats.editTurns;
  for (const c of report.claims) report.counts[c.verdict]++;
  const total = report.claims.length;
  report.verifiedPct = total ? Math.round(100 * report.counts.VERIFIED / total) : 0;
  report.unbackedPct = total ? Math.round(100 * (total - report.counts.VERIFIED) / total) : 0;
  const by = /* @__PURE__ */ new Map();
  for (const c of report.claims) {
    const s = by.get(c.project) ?? { project: c.project, claims: 0, verified: 0, stale: 0, failed: 0, neverRan: 0, unbackedPct: 0 };
    s.claims++;
    if (c.verdict === "VERIFIED") s.verified++;
    else if (c.verdict === "STALE") s.stale++;
    else if (c.verdict === "FAILED") s.failed++;
    else s.neverRan++;
    by.set(c.project, s);
  }
  report.byProject = [...by.values()].map((s) => ({ ...s, unbackedPct: Math.round(100 * (s.claims - s.verified) / s.claims) })).sort((a, b) => b.claims - a.claims);
  const roots = /* @__PURE__ */ new Set();
  for (const p of report.byProject) {
    if (!existsSync16(p.project)) continue;
    try {
      roots.add(findRoot(p.project));
    } catch {
    }
  }
  const logs = [...roots].map((dir2) => ({ dir: dir2, records: readDecisions(dir2, since, until) })).filter((l) => l.records.length > 0);
  report.gate = logs.length ? { ...summarizeDecisions(logs.map((l) => l.records)), dirs: logs.map((l) => l.dir) } : null;
  return report;
}
function parseSince(v) {
  const m = /^(\d+)\s*([dwmh])$/i.exec(v.trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === "h" ? 36e5 : unit === "d" ? 864e5 : unit === "w" ? 7 * 864e5 : 30 * 864e5;
    return new Date(Date.now() - n * ms);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// src/mcp.ts
import { existsSync as existsSync17, statSync as statSync11 } from "node:fs";
import { dirname as dirname6, resolve as resolve5 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
var LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
var MODERN_VERSIONS = ["2026-07-28"];
var SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
var META_VERSION = "io.modelcontextprotocol/protocolVersion";
var META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
var META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
var META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var INTERNAL_ERROR = -32603;
var UNSUPPORTED_PROTOCOL_VERSION = -32022;
var CACHE_TTL_MS = 36e5;
var ROOTS_TIMEOUT_MS = 3e3;
var HEARTBEAT_MS = 1e4;
var ROOTS_STATE = "isitdone-roots";
var SERVER_INFO = { name: "isitdone", version: VERSION };
var INSTRUCTIONS = [
  "isitdone checks a coding task against the repository's real test, typecheck and lint commands.",
  "Before you tell the user that work is complete, fixed, passing or ready for review, call isitdone_verify (pass cwd: the absolute path of the repository, and claim: the sentence you are about to say) and paste its result into your reply.",
  "If the result says NOT DONE, the work is not done: fix the code and call isitdone_verify again instead of reporting completion.",
  "Never skip, delete, loosen or otherwise weaken tests or their configuration to make it pass; if a check is wrong for this repository, say so to the user.",
  "isitdone_receipt tells whether the current tree already has a PASS receipt; isitdone_detect lists the checks that would run."
].join(" ");
var ToolInputError = class extends Error {
};
var RpcFailure = class extends Error {
  constructor(rpc) {
    super(rpc.message);
    this.rpc = rpc;
  }
  rpc;
};
function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
var MAX_LINE2 = 400;
function clip(line) {
  return line.length <= MAX_LINE2 ? line : `${line.slice(0, MAX_LINE2 - 3)}...`;
}
var STRING = { type: "string" };
var STRINGS = { type: "array", items: STRING };
var NULLABLE_STRING = { type: ["string", "null"] };
var CWD_PROPERTY = {
  type: "string",
  description: "Absolute path of the repository, or of a directory inside it. Default: the client's first workspace root, else the directory the server was started in."
};
var CHECK_RESULT = {
  type: "object",
  properties: {
    id: STRING,
    cmd: STRING,
    status: { type: "string", enum: ["PASS", "FAIL", "TIMEOUT", "ERROR"] },
    exitCode: { type: ["integer", "null"] },
    durationMs: { type: "number" },
    summary: NULLABLE_STRING,
    tail: { ...STRINGS, description: "Last lines of the combined output; empty for checks that passed." },
    reused: {
      type: ["object", "null"],
      description: 'Set when the check was not run because none of the files it reads changed since an earlier pass (its "ignore" list in .isitdone.json): when that run started, its tree and duration.',
      properties: { at: STRING, tree: STRING, durationMs: { type: "number" } }
    }
  },
  required: ["id", "cmd", "status", "tail"]
};
var VERIFY_OUTPUT = {
  type: "object",
  properties: {
    done: { type: "boolean", description: "True only when every full check passed on exactly this working tree and no test-integrity finding blocks." },
    ok: { type: "boolean", description: "Every check that ran passed. With profile lite this can be true while done is false." },
    noChecks: { type: "boolean", description: "No checks were detected, so nothing was verified." },
    state: { type: "string", enum: ["PASS", "FAIL", "NONE"], description: "The receipt this run wrote or reused." },
    profile: { type: "string", enum: ["lite", "full"] },
    cached: { type: "boolean", description: "A PASS receipt already proved this exact tree; nothing was re-run." },
    claim: NULLABLE_STRING,
    git: { type: "object" },
    checks: { type: "array", items: CHECK_RESULT },
    skipped: { type: "array", items: { type: "object", properties: { id: STRING, cmd: STRING, reason: STRING }, required: ["id", "cmd", "reason"] } },
    integrity: {
      type: ["object", "null"],
      description: "Scan of the change set for weakened tests (deleted tests, new skips, dropped or downgraded assertions, neutered configuration).",
      properties: {
        mode: { type: "string", enum: ["warn", "strict", "off"] },
        summary: { type: "object" },
        testFiles: { type: "integer" },
        findings: { type: "array", items: { type: "object" } },
        blocking: { type: "integer", description: "Findings that block in strict mode." }
      }
    },
    stacks: STRINGS,
    notes: STRINGS,
    warnings: STRINGS,
    receipt: { type: ["object", "null"], properties: { createdAt: STRING, status: STRING, profile: STRING, tree: STRING } },
    durationMs: { type: "number" },
    version: STRING
  },
  required: ["done", "ok", "noChecks", "state", "profile", "cached", "checks", "skipped", "integrity", "receipt"]
};
var RECEIPT_OUTPUT = {
  type: "object",
  properties: {
    state: { type: "string", enum: ["PASS", "FAIL", "STALE", "NONE"] },
    done: { type: "boolean", description: "True only for a PASS receipt of a full run on exactly this tree." },
    reason: STRING,
    root: STRING,
    tree: { type: "string", description: "Hash of the current working tree." },
    receipt: {
      type: ["object", "null"],
      properties: {
        createdAt: STRING,
        status: { type: "string", enum: ["PASS", "FAIL"] },
        profile: { type: "string", enum: ["lite", "full"] },
        tree: STRING,
        head: NULLABLE_STRING,
        branch: NULLABLE_STRING,
        claim: NULLABLE_STRING,
        host: NULLABLE_STRING,
        checks: { type: "array", items: CHECK_RESULT }
      }
    }
  },
  required: ["state", "done", "reason", "receipt"]
};
var DETECT_OUTPUT = {
  type: "object",
  properties: {
    root: STRING,
    configSource: NULLABLE_STRING,
    stacks: STRINGS,
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: STRING,
          cmd: STRING,
          kind: { type: "string", enum: ["lite", "full"], description: "lite = typecheck/lint, full = tests/build." },
          source: STRING,
          timeoutSeconds: { type: "number" },
          cwd: STRING
        },
        required: ["id", "cmd", "kind", "source", "timeoutSeconds"]
      }
    },
    notes: STRINGS
  },
  required: ["root", "configSource", "stacks", "checks", "notes"]
};
var TOOLS = [
  {
    name: "isitdone_verify",
    title: "isitdone: verify before claiming done",
    description: "Run this repository's real test, typecheck and lint commands on the current working tree, scan the diff for weakened tests, and write a receipt bound to that exact tree. Call it before you tell the user that work is complete, fixed, passing or ready for review, and paste the result. NOT DONE (done: false) is an answer, not a tool failure: fix the code and call again. Never skip, delete or weaken tests to make it pass. A PASS receipt for an unchanged tree is reused, so calling again is cheap.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: CWD_PROPERTY,
        profile: { type: "string", enum: ["lite", "full"], description: "full (default) runs every check. lite runs only typecheck and lint and never reports done: true." },
        claim: { type: "string", description: "The completion claim you are about to make, quoted; it is recorded in the receipt." },
        base: { type: "string", description: "Git ref to diff against for the test-integrity scan. Default: HEAD, i.e. the uncommitted changes." },
        strict: { type: "boolean", description: "Also answer NOT DONE when the change weakened tests (high or critical findings), even if the checks pass." }
      }
    },
    outputSchema: VERIFY_OUTPUT,
    annotations: { title: "isitdone: verify before claiming done", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "isitdone_receipt",
    title: "isitdone: receipt for the current tree",
    description: "Read-only, runs nothing. Whether the current working tree already has a verification receipt: PASS (the checks passed on exactly this tree), FAIL, STALE (files or the check configuration changed since) or NONE.",
    inputSchema: { type: "object", properties: { cwd: CWD_PROPERTY } },
    outputSchema: RECEIPT_OUTPUT,
    annotations: { title: "isitdone: receipt for the current tree", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: "isitdone_detect",
    title: "isitdone: which checks would run",
    description: "Read-only, runs nothing. The check commands isitdone_verify would run in this repository: id, command, lite or full, timeout, and where each one was detected.",
    inputSchema: { type: "object", properties: { cwd: CWD_PROPERTY } },
    outputSchema: DETECT_OUTPUT,
    annotations: { title: "isitdone: which checks would run", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }
];
function toolsFor(version) {
  return TOOLS.map((t) => {
    const tool = { name: t.name };
    if (version >= "2025-06-18") tool.title = t.title;
    tool.description = t.description;
    tool.inputSchema = t.inputSchema;
    if (version >= "2025-06-18") tool.outputSchema = t.outputSchema;
    if (version >= "2025-03-26") tool.annotations = t.annotations;
    return tool;
  });
}
function firstFileRoot(roots) {
  if (!Array.isArray(roots)) return null;
  for (const r of roots) {
    const uri = isObject(r) ? r.uri : null;
    if (typeof uri !== "string" || !uri.toLowerCase().startsWith("file://")) continue;
    try {
      const p = fileURLToPath3(uri);
      const st = statSync11(p);
      return st.isDirectory() ? p : dirname6(p);
    } catch {
    }
  }
  return null;
}
var McpServer = class {
  send;
  log;
  cwd;
  env;
  rootsTimeoutMs;
  /** Set by `initialize`; scoped to this process, as the legacy revisions specify. */
  legacy = null;
  rootsPromise = null;
  seq = 0;
  pending = /* @__PURE__ */ new Map();
  /** Requests being worked on, and the ones among them the client no longer wants an answer to. */
  active = /* @__PURE__ */ new Set();
  cancelled = /* @__PURE__ */ new Set();
  /** One verification at a time per project root. */
  flights = /* @__PURE__ */ new Map();
  closed = false;
  constructor(opts) {
    this.send = opts.send;
    this.log = opts.log ?? (() => void 0);
    this.cwd = opts.cwd ?? process.cwd();
    this.env = opts.env ?? process.env;
    this.rootsTimeoutMs = opts.rootsTimeoutMs ?? ROOTS_TIMEOUT_MS;
  }
  /** One line of stdin. Never throws; every failure becomes a JSON-RPC error or a log line. */
  async handleLine(raw) {
    const line = (raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw).trim();
    if (line === "") return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error: the line is not valid JSON" } });
      return;
    }
    if (Array.isArray(msg)) {
      if (msg.length === 0) return this.write({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request: empty batch" } });
      const answers = (await Promise.all(msg.map((m) => this.handleMessage(m)))).filter((a) => a !== null);
      if (answers.length > 0) this.write(answers);
      return;
    }
    const answer = await this.handleMessage(msg);
    if (answer) this.write(answer);
  }
  /** The client is gone (stdin closed): kill running checks, drop what is queued, and let the process exit. */
  async close() {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("connection closed"));
    this.pending.clear();
    const running = [...this.flights.values()];
    for (const f of running) f.abort.abort();
    await Promise.allSettled(running.map((f) => f.promise));
  }
  write(message) {
    if (this.closed) return;
    this.send(message);
  }
  async handleMessage(msg) {
    if (!isObject(msg) || msg.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request: expected a JSON-RPC 2.0 message" } };
    }
    const hasId = typeof msg.id === "string" || typeof msg.id === "number";
    if (typeof msg.method !== "string") {
      if (hasId && ("result" in msg || "error" in msg)) {
        const waiter = this.pending.get(String(msg.id));
        this.pending.delete(String(msg.id));
        if (waiter && "error" in msg) waiter.reject(new Error("the client answered with an error"));
        else if (waiter) waiter.resolve(msg.result);
        return null;
      }
      return { jsonrpc: "2.0", id: hasId ? msg.id : null, error: { code: INVALID_REQUEST, message: "Invalid Request: no method" } };
    }
    const params = isObject(msg.params) ? msg.params : {};
    if (msg.id === void 0) {
      this.handleNotification(msg.method, params);
      return null;
    }
    if (!hasId) return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Invalid Request: id must be a string or a number" } };
    const id2 = msg.id;
    this.active.add(id2);
    try {
      const result = await this.handleRequest(id2, msg.method, params);
      return this.cancelled.has(id2) || result === null ? null : { jsonrpc: "2.0", id: id2, result };
    } catch (err2) {
      if (this.cancelled.has(id2)) return null;
      const rpc = err2 instanceof RpcFailure ? err2.rpc : { code: INTERNAL_ERROR, message: `Internal error: ${err2.message ?? String(err2)}` };
      if (!(err2 instanceof RpcFailure)) this.log(`isitdone mcp: ${msg.method} failed: ${err2.stack ?? String(err2)}`);
      return { jsonrpc: "2.0", id: id2, error: rpc };
    } finally {
      this.active.delete(id2);
      this.cancelled.delete(id2);
    }
  }
  handleNotification(method, params) {
    if (method === "notifications/initialized") {
      void this.legacyRoots();
    } else if (method === "notifications/roots/list_changed") {
      this.rootsPromise = null;
    } else if (method === "notifications/cancelled") {
      const id2 = params.requestId;
      if ((typeof id2 === "string" || typeof id2 === "number") && this.active.has(id2)) this.cancelled.add(id2);
    }
  }
  /** Which era and revision serves this request. */
  context(method, params) {
    const meta = isObject(params._meta) ? params._meta : {};
    const requested = meta[META_VERSION];
    if (requested !== void 0 && method !== "initialize") {
      if (typeof requested !== "string") throw new RpcFailure({ code: INVALID_PARAMS, message: `Invalid params: _meta["${META_VERSION}"] must be a string` });
      if (MODERN_VERSIONS.includes(requested)) {
        const caps = meta[META_CLIENT_CAPS];
        if (!isObject(caps)) throw new RpcFailure({ code: INVALID_PARAMS, message: `Invalid params: _meta["${META_CLIENT_CAPS}"] is required on every request` });
        const info = meta[META_CLIENT_INFO];
        return { version: requested, modern: true, roots: isObject(caps.roots), clientName: isObject(info) && typeof info.name === "string" ? info.name : null };
      }
      if (!(this.legacy && this.legacy.version === requested)) {
        throw new RpcFailure({ code: UNSUPPORTED_PROTOCOL_VERSION, message: "Unsupported protocol version", data: { supported: SUPPORTED_VERSIONS, requested } });
      }
    }
    return { version: this.legacy?.version ?? LEGACY_VERSIONS[0], modern: false, roots: this.legacy?.roots ?? false, clientName: this.legacy?.clientName ?? null };
  }
  /** Modern results say what they are and who sent them. */
  wrap(ctx, result, cacheable = false) {
    if (!ctx.modern) return result;
    return { resultType: "complete", ...result, ...cacheable ? { ttlMs: CACHE_TTL_MS, cacheScope: "public" } : {}, _meta: { [META_SERVER_INFO]: SERVER_INFO } };
  }
  async handleRequest(id2, method, params) {
    switch (method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
        const caps = isObject(params.capabilities) ? params.capabilities : {};
        const info = isObject(params.clientInfo) ? params.clientInfo : {};
        this.legacy = { version, roots: isObject(caps.roots), clientName: typeof info.name === "string" ? info.name : null };
        this.rootsPromise = null;
        return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case "server/discover": {
        const ctx = this.context(method, params);
        return this.wrap({ ...ctx, modern: true }, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS }, true);
      }
      case "ping":
        return this.wrap(this.context(method, params), {});
      case "tools/list": {
        const ctx = this.context(method, params);
        return this.wrap(ctx, { tools: toolsFor(ctx.version) }, true);
      }
      case "tools/call":
        return this.toolsCall(id2, this.context(method, params), params);
      default:
        throw new RpcFailure({ code: METHOD_NOT_FOUND, message: `Method not found: ${method}` });
    }
  }
  async toolsCall(id2, ctx, params) {
    const name = params.name;
    if (typeof name !== "string") throw new RpcFailure({ code: INVALID_PARAMS, message: "Invalid params: name must be a string" });
    if (!TOOLS.some((t) => t.name === name)) throw new RpcFailure({ code: INVALID_PARAMS, message: `Unknown tool: ${name}` });
    if (params.arguments !== void 0 && !isObject(params.arguments)) throw new RpcFailure({ code: INVALID_PARAMS, message: "Invalid params: arguments must be an object" });
    const args = params.arguments ?? {};
    let outcome;
    try {
      const dir2 = await this.resolveDir(ctx, params, args);
      if (typeof dir2 !== "string") outcome = dir2;
      else if (name === "isitdone_verify") outcome = await this.toolVerify(id2, ctx, params, args, dir2);
      else if (name === "isitdone_receipt") outcome = this.toolReceipt(dir2);
      else outcome = this.toolDetect(dir2);
    } catch (err2) {
      if (err2 instanceof RpcFailure) throw err2;
      outcome = { text: `isitdone: ${err2.message ?? String(err2)}`, isError: true };
    }
    if (outcome === null) return null;
    if ("raw" in outcome) return outcome.raw;
    const result = { content: [{ type: "text", text: outcome.text }], isError: outcome.isError };
    if (outcome.structured && !outcome.isError && ctx.version >= "2025-06-18") result.structuredContent = outcome.structured;
    return this.wrap(ctx, result);
  }
  /** The directory a call is about: its `cwd` argument, else the client's first file:// root, else the server's cwd. */
  async resolveDir(ctx, params, args) {
    if (args.cwd !== void 0 && typeof args.cwd !== "string") throw new ToolInputError("cwd must be a string (an absolute path)");
    if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
      const dir2 = resolve5(this.cwd, args.cwd);
      if (!existsSync17(dir2) || !statSync11(dir2).isDirectory()) throw new ToolInputError(`cwd is not a directory on this machine: ${dir2}`);
      return dir2;
    }
    if (!ctx.roots) return this.cwd;
    if (!ctx.modern) return firstFileRoot(await this.legacyRoots()) ?? this.cwd;
    const responses = isObject(params.inputResponses) ? params.inputResponses : null;
    if (!responses && params.requestState !== ROOTS_STATE) {
      return { raw: this.wrap(ctx, { resultType: "input_required", inputRequests: { roots: { method: "roots/list" } }, requestState: ROOTS_STATE }) };
    }
    const answer = responses && isObject(responses.roots) ? responses.roots.roots : null;
    return firstFileRoot(answer) ?? this.cwd;
  }
  /** Legacy eras: one `roots/list` request to the client, cached until it says the list changed. Never rejects. */
  legacyRoots() {
    if (!this.legacy?.roots || this.closed) return Promise.resolve([]);
    this.rootsPromise ??= this.request("roots/list").then(
      (r) => isObject(r) && Array.isArray(r.roots) ? r.roots : [],
      (err2) => {
        this.log(`isitdone mcp: roots/list: ${err2.message}; using ${this.cwd}`);
        return [];
      }
    );
    return this.rootsPromise;
  }
  request(method) {
    const id2 = `isitdone-${++this.seq}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id2);
        reject(new Error(`no answer within ${this.rootsTimeoutMs}ms`));
      }, this.rootsTimeoutMs);
      timer.unref();
      this.pending.set(id2, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveRequest(result);
        },
        reject: (err2) => {
          clearTimeout(timer);
          reject(err2);
        }
      });
      this.write({ jsonrpc: "2.0", id: id2, method });
    });
  }
  /**
   * One verification at a time per project root. A second call asking the same question gets the answer of the run in
   * flight; a different question (another profile, base or strictness) waits its turn, and usually finds a fresh receipt.
   */
  async exclusive(root, key, run) {
    for (; ; ) {
      const current = this.flights.get(root);
      if (!current) break;
      if (current.key === key) return current.promise;
      await current.promise.catch(() => void 0);
    }
    if (this.closed) return null;
    const abort = new AbortController();
    const flight = { key, abort, promise: Promise.resolve(null) };
    flight.promise = run(abort.signal).finally(() => {
      if (this.flights.get(root) === flight) this.flights.delete(root);
    });
    this.flights.set(root, flight);
    return flight.promise;
  }
  async toolVerify(id2, ctx, params, args, dir2) {
    if (this.env.ISITDONE === "1") {
      return { text: "isitdone: refusing to run nested inside an isitdone check (remove isitdone from that check command, or disable the check in .isitdone.json)", isError: true };
    }
    if (args.profile !== void 0 && args.profile !== "lite" && args.profile !== "full") throw new ToolInputError(`profile must be "lite" or "full" (got ${JSON.stringify(args.profile)})`);
    for (const key of ["claim", "base"]) {
      if (args[key] !== void 0 && typeof args[key] !== "string") throw new ToolInputError(`${key} must be a string`);
    }
    if (args.strict !== void 0 && typeof args.strict !== "boolean") throw new ToolInputError("strict must be true or false");
    const profile = args.profile === "lite" ? "lite" : "full";
    const claim = typeof args.claim === "string" && args.claim.trim() !== "" ? args.claim.trim() : null;
    const base = typeof args.base === "string" && args.base.trim() !== "" ? args.base.trim() : void 0;
    const strict = args.strict === true;
    const root = findRoot(dir2);
    const { config } = loadConfig(root);
    const meta = isObject(params._meta) ? params._meta : {};
    const token = typeof meta.progressToken === "string" || typeof meta.progressToken === "number" ? meta.progressToken : null;
    let progress = 0;
    const tell = (message) => {
      if (token === null || this.cancelled.has(id2)) return;
      this.write({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++progress, ...ctx.version >= "2025-03-26" ? { message } : {} } });
    };
    let heartbeat = null;
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };
    const res = await this.exclusive(
      root,
      JSON.stringify([profile, base ?? null, strict]),
      (signal) => verify({
        root,
        config: strict ? { ...config, integrity: "strict" } : config,
        profile,
        claim,
        host: ctx.clientName ? `mcp:${ctx.clientName.replace(/[^\x20-\x7e]/g, "").slice(0, 60)}` : "mcp",
        base,
        signal,
        lockWaitMs: config.otherSessions === "ignore" ? 0 : LOCK_WAIT_MS,
        onLockWait: () => tell("waiting for another check run in this directory"),
        onCheckStart: (check) => {
          const started = Date.now();
          tell(`running ${check.cmd}`);
          stopHeartbeat();
          heartbeat = setInterval(() => tell(`still running ${check.cmd} (${formatDuration(Date.now() - started)})`), HEARTBEAT_MS);
          heartbeat.unref();
        },
        onCheckDone: stopHeartbeat
      }).finally(stopHeartbeat)
    );
    if (res === null || this.closed) return null;
    const state = receiptStateOf(res);
    const json = toJson(res, state);
    const checks = json.checks.map((c) => ({ ...c, tail: c.status === "PASS" ? [] : c.tail.map(clip) }));
    const structured = { ...json, checks };
    const report = formatReport(res, plain).split("\n").map(clip).join("\n");
    return { text: `${report}

${adviceFor(res, json.done === true)}`, structured, isError: false };
  }
  toolReceipt(dir2) {
    const root = findRoot(dir2);
    const git3 = gitInfo(root);
    const ev = evaluateReceipt(root, git3, configHash(root));
    const done = ev.state === "PASS" && ev.receipt?.profile === "full";
    const r = ev.receipt;
    const receipt = r ? {
      createdAt: r.createdAt,
      status: r.status,
      profile: r.profile,
      tree: r.tree,
      head: r.head,
      branch: r.branch,
      claim: r.claim,
      host: r.host,
      checks: r.checks.map((c) => ({ id: c.id, cmd: c.cmd, status: c.status, exitCode: c.exitCode, durationMs: c.durationMs, summary: c.summary ?? null, tail: c.status === "PASS" ? [] : c.tail.map(clip), reused: c.reused ?? null }))
    } : null;
    const advice = done ? "This exact tree is verified." : "This tree is not verified. Call isitdone_verify before telling the user the work is complete.";
    return {
      text: `${formatReceiptState(ev, plain, 'call isitdone_verify with profile "full"')}

${advice}`,
      structured: { state: ev.state, done, reason: ev.reason, root, tree: git3.tree, receipt },
      isError: false
    };
  }
  toolDetect(dir2) {
    const root = findRoot(dir2);
    const { config, source } = loadConfig(root);
    const d = detectChecks(root, config);
    const checks = d.checks.map((c) => ({ id: c.id, cmd: c.cmd, kind: c.kind, source: c.source, timeoutSeconds: timeoutFor(c, config) / 1e3, ...c.cwd ? { cwd: c.cwd } : {} }));
    return { text: formatDetection(root, d, config, source, plain), structured: { root, configSource: source, stacks: d.stacks, checks, notes: d.notes }, isError: false };
  }
};
function adviceFor(res, done) {
  if (done) return "Verified. Paste this result when you tell the user the work is complete.";
  if (res.detection.checks.length === 0) {
    return "NOT VERIFIED: no checks were detected, so nothing proves the work is done. Do not tell the user it is verified; say which commands you ran yourself, or define checks in .isitdone.json.";
  }
  if (res.ok && integrityBlocks(res)) {
    return "Restore the removed or weakened tests (or explain to the user why the change to the tests is correct), then call isitdone_verify again before telling the user the work is complete.";
  }
  if (res.ok && res.profile === "lite") return 'Only the lite checks (typecheck, lint) ran, so this is not "done" yet. Call isitdone_verify with profile "full" before telling the user the work is complete.';
  if (res.ok) return "The checks passed, but no receipt could be written for this tree (see the warning above), so it is not recorded as verified. Tell the user about the warning.";
  return "Fix the failures, then call isitdone_verify again before telling the user the work is complete. Do not skip, delete or weaken tests to make this pass; if a check is wrong for this repo, say so explicitly to the user.";
}
function runMcpServer(opts = {}) {
  return new Promise((done) => {
    const log = (line) => process.stderr.write(line + "\n");
    const protocol = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((...a) => process.stderr.write(...a));
    const server = new McpServer({ send: (message) => protocol(JSON.stringify(message) + "\n"), log: process.env.ISITDONE_DEBUG ? log : void 0, cwd: opts.cwd });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => process.exit(0), 5e3).unref();
      void server.close().then(() => done(0));
    };
    if (process.stdin.isTTY) log('isitdone mcp: serving the Model Context Protocol on stdio. An MCP client starts this command; see "MCP server" in the README. Ctrl+C to quit.');
    let buffer = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        void server.handleLine(line);
      }
    });
    process.stdin.on("end", () => {
      void server.handleLine(buffer);
      setImmediate(finish);
    });
    process.stdin.on("error", finish);
    process.stdout.on("error", finish);
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

// src/cli.ts
var NPX = "npx isitdone";
var HELP = `isitdone ${VERSION} - don't let your coding agent say "done" until the checks actually pass.

Usage
  ${NPX}                      run the repo's test/typecheck/lint checks, write a receipt
  ${NPX} init                 install the Stop hook into Claude Code (and other detected agents)
  ${NPX} doctor               prove the hook fires and blocks, and that the checks start green
  ${NPX} receipt              show whether the current tree has a PASS receipt
  ${NPX} detect               show which checks would run
  ${NPX} hook --host <name>   (used by the agent) read the Stop payload on stdin, block if needed;
                          <name> is one of ${HOST_NAMES.join(", ")}
  ${NPX} uninstall            remove the hook(s)
  ${NPX} pause                (you, not the agent) let every stop through unchecked for a while, then switch back on
  ${NPX} resume               end this repository's pause early (--global: the user-wide one)
  ${NPX} history              how many of your agent's past "done" claims had a test run behind them
  ${NPX} update               refresh the npx-cached hook to the latest release (--check only reports)
  ${NPX} mcp                  (used by the IDE) Model Context Protocol server on stdio, for agents without a stop hook:
                          tools isitdone_verify, isitdone_receipt, isitdone_detect

Options for run
  --profile <lite|full>   lite = typecheck+lint only, full = everything (default: full)
  --all                   keep running full checks even if a lite check failed
  --no-cache              re-run even if a PASS receipt exists for this exact tree (or a check's pass could be reused)
  --json                  machine-readable output (done: true|false)
  --claim "<text>"        record the completion claim being verified
  --base <ref>            diff against <ref> for the test-integrity scan (default: HEAD)
  --strict                block when the change weakened tests (high/critical findings)
  --ci                    strict, and new "isitdone: allow" suppressions count as findings
  --sarif <file>          also write the integrity findings as SARIF 2.1.0 (GitHub code scanning)
  --report <file>         also write a markdown report (job summaries, PR comments)
  --json-file <file>      also write the JSON result to a file

Options for history  (reads Claude Code, Codex, Gemini CLI, Qwen Code and Cursor transcripts locally; nothing leaves the machine)
  --since <30d|2w|2026-01-01>   only sessions after this point
  --until <2026-01-31>    only turns up to this point (a bare date includes the whole day, UTC)
  --exclude <substring>   skip projects whose path contains this (repeatable; also .isitdone.json history.exclude)
  --verbose               list every claim with its verdict
  --min <pct>             exit 1 if fewer than <pct>% of claims were verified
  --json                  machine-readable
  --include-subagents     also scan subagent transcripts

Options for init
  --agent <name>          ${HOST_NAMES.join(" | ")} | all | auto
                          (default: auto = every agent with a settings dir in the repo; comma-separate to name several;
                          opencode gets a plugin file instead of a hook entry, junie is user-level only)
  --user                  install into the user-level settings instead of the project
  --no-npx, --npx         run the hook from a local copy (~/.isitdone/bin) with node, or through npx; node skips
                          npm's start-up on every call (default: local copy with --user, npx for a project)
  --timeout <seconds>     hook timeout (default: sized to the detected checks, at least 600)
  --command "<cmd>"       hook command to register (default: see --npx; npx -y ${PACKAGE_NAME} hook --host <name>); it must
                          forward extra arguments, since the edit hook is the same command plus --event edit
  --remove                uninstall the hook(s)
  --no-edit-hook          only the Stop hook; skip the warn-only hook that runs after each test-file edit
  --no-doctor             skip the post-install doctor run
  --no-baseline           skip running the detected checks once on the current tree (doctor accepts it too)
  --json                  machine-readable output

Options for pause  (the Stop hook only, in this repository and its worktrees; running sessions pick it up at their next stop)
  --for <30m|2h|3d|1w>    how long (default 1h, at most 30 days; m is minutes here)
  --until <time>          2026-11-02 (end of that day), 2026-11-02T11:00 (local time) or 2026-11-02T11:00Z
  --global                every repository of this user (this home directory), not just this one

Options for receipt
  --md                    markdown table for a PR body
  --json                  machine-readable

Common
  --cwd <dir>             run as if started in <dir>
  --version, --help

Exit codes: 0 done/ok, 1 not done, 3 usage or internal error.
Config: .isitdone.json or "isitdone" in package.json. Docs: https://github.com/raimondasl/isitdone
`;
var VALUE_FLAGS = /* @__PURE__ */ new Set(["profile", "claim", "host", "agent", "timeout", "command", "cwd", "base", "since", "until", "exclude", "min", "sarif", "event", "file", "report", "json-file", "for"]);
var BOOL_FLAGS = /* @__PURE__ */ new Set(["all", "cache", "json", "md", "user", "remove", "doctor", "probe", "version", "help", "strict", "ci", "verbose", "include-subagents", "check", "warm", "latest", "edit-hook", "baseline", "global", "npx"]);
var MULTI_FLAGS = /* @__PURE__ */ new Set(["exclude"]);
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  const setValue = (key, value) => {
    if (MULTI_FLAGS.has(key)) {
      const prev = flags[key];
      flags[key] = Array.isArray(prev) ? [...prev, value] : [value];
    } else {
      flags[key] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        setValue(key, a.slice(eq + 1));
      } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        setValue(key, argv[++i]);
      } else if (key.startsWith("no-")) {
        flags[key.slice(3)] = false;
      } else {
        flags[key] = true;
      }
    } else if (a === "-v") {
      flags.version = true;
    } else if (a === "-h") {
      flags.help = true;
    } else {
      rest.push(a);
    }
  }
  const command = rest.shift() ?? "run";
  return { command, flags, rest };
}
function unknownFlags(args) {
  return Object.keys(args.flags).filter((k) => !VALUE_FLAGS.has(k) && !BOOL_FLAGS.has(k));
}
function out2(s) {
  process.stdout.write(s + "\n");
}
function err(s) {
  process.stderr.write(s + "\n");
}
function repoRoot(flags) {
  const cwd = typeof flags.cwd === "string" ? resolve6(flags.cwd) : process.cwd();
  return findRoot(cwd);
}
async function cmdRun(args) {
  if (process.env.ISITDONE === "1") {
    err("isitdone: refusing to run nested inside an isitdone check (remove isitdone from that check command, or disable the check in .isitdone.json)");
    return 3;
  }
  const root = repoRoot(args.flags);
  const { config } = loadConfig(root);
  const profileFlag = args.flags.profile;
  const profile = profileFlag === "lite" ? "lite" : "full";
  if (profileFlag !== void 0 && profileFlag !== "lite" && profileFlag !== "full") {
    err(`--profile must be lite or full (got ${String(profileFlag)})`);
    return 3;
  }
  const json = args.flags.json === true;
  const s = styleFor(process.stdout);
  const live = !json && Boolean(process.stdout.isTTY);
  const ci = args.flags.ci === true;
  const strict = ci || args.flags.strict === true;
  const res = await verify({
    root,
    config: strict ? { ...config, integrity: "strict" } : config,
    profile,
    claim: typeof args.flags.claim === "string" ? args.flags.claim : null,
    host: typeof args.flags.host === "string" ? args.flags.host : null,
    all: args.flags.all === true,
    useCache: args.flags.cache !== false,
    base: typeof args.flags.base === "string" ? args.flags.base : void 0,
    ci,
    // The agent a Stop hook just sent here must not run the suite on top of the other session's hook run.
    lockWaitMs: config.otherSessions === "ignore" ? 0 : LOCK_WAIT_MS,
    onLockWait: () => err("isitdone: another check run is in progress in this directory; waiting for it (up to 3 minutes) ..."),
    onCheckStart: live ? (c) => process.stdout.write(s.dim(`  running ${c.cmd} ...`)) : void 0,
    onCheckDone: live ? () => process.stdout.write(`\r${" ".repeat(70)}\r`) : void 0
  });
  const state = receiptStateOf(res);
  if (typeof args.flags.sarif === "string" && res.integrity) {
    writeFileSync8(resolve6(args.flags.sarif), JSON.stringify(toSarif(res.integrity, { base: typeof args.flags.base === "string" ? args.flags.base : "HEAD" }), null, 2) + "\n");
  }
  if (typeof args.flags.report === "string") {
    writeFileSync8(resolve6(args.flags.report), formatReportMarkdown(res, state) + "\n");
  }
  if (typeof args.flags["json-file"] === "string") {
    writeFileSync8(resolve6(args.flags["json-file"]), JSON.stringify(toJson(res, state), null, 2) + "\n");
  }
  if (json) out2(JSON.stringify(toJson(res, state), null, 2));
  else {
    out2(formatReport(res, s));
    const sessions = !res.ok && res.git.isRepo && config.otherSessions !== "ignore" ? liveSessionsNote([res.git.root, root], () => dirtyPathSet(res.git.root)) : null;
    if (sessions) out2(s.yellow(sessions));
    const pause = activePause(pauseFiles(res.git.isRepo ? res.git.root : root));
    if (pause) out2(s.yellow(`note: the Stop hook is paused ${describePause(pause)}: agents' stops go through unchecked until then (\`${NPX} resume\` ends it)`));
  }
  return res.ok && !integrityBlocks(res) ? 0 : 1;
}
var pct = share;
async function cmdHistory(args) {
  const root = repoRoot(args.flags);
  let configExclude = [];
  try {
    configExclude = loadConfig(root).config.history?.exclude ?? [];
  } catch {
  }
  const flagExclude = Array.isArray(args.flags.exclude) ? args.flags.exclude : typeof args.flags.exclude === "string" ? [args.flags.exclude] : [];
  const sinceRaw = typeof args.flags.since === "string" ? args.flags.since : null;
  const since = sinceRaw ? parseSince(sinceRaw) : null;
  if (sinceRaw && !since) {
    err(`--since must look like 30d, 2w, 12h or an ISO date (got ${sinceRaw})`);
    return 3;
  }
  const untilRaw = typeof args.flags.until === "string" ? args.flags.until : null;
  const until = untilRaw ? /^\d{4}-\d{2}-\d{2}$/.test(untilRaw.trim()) ? new Date(Date.parse(`${untilRaw.trim()}T23:59:59.999Z`)) : parseSince(untilRaw) : null;
  if (untilRaw && (!until || Number.isNaN(until.getTime()))) {
    err(`--until must be an ISO date or time, or look like 30d, 2w, 12h (got ${untilRaw})`);
    return 3;
  }
  const min = typeof args.flags.min === "string" ? Number(args.flags.min) : null;
  if (min !== null && !(min >= 0 && min <= 100)) {
    err("--min must be a percentage between 0 and 100");
    return 3;
  }
  const json = args.flags.json === true;
  const s = styleFor(process.stdout);
  const live = !json && Boolean(process.stdout.isTTY);
  const report = await scanHistory({
    since,
    until,
    exclude: [...configExclude, ...flagExclude],
    includeSubagents: args.flags["include-subagents"] === true,
    onProgress: live ? (done, total2) => process.stdout.write(`\r  scanning ${done}/${total2} sessions ...`) : void 0
  });
  if (live) process.stdout.write(`\r${" ".repeat(50)}\r`);
  const total = report.claims.length;
  const verified = report.counts.VERIFIED;
  if (json) {
    out2(JSON.stringify({ ...report, claims: args.flags.verbose === true ? report.claims : void 0 }, null, 2));
  } else {
    out2(`${s.bold("isitdone history")}  ${s.dim(report.projectsDir)}${report.since ? s.dim(`  since ${report.since.slice(0, 10)}`) : ""}${report.until ? s.dim(`  until ${report.until.slice(0, 10)}`) : ""}`);
    out2(`  scanned ${report.scannedFiles} session${report.scannedFiles === 1 ? "" : "s"} in ${report.byProject.length || "no"} project${report.byProject.length === 1 ? "" : "s"}; ${report.editTurns} turns edited files; ${total} of those ended with a completion claim${report.excludedDirs.length ? s.dim(`; ${report.excludedDirs.length} project dir${report.excludedDirs.length === 1 ? "" : "s"} excluded`) : ""}`);
    for (const [agent, a] of Object.entries(report.byAgent)) {
      if (a.sessions === 0) continue;
      const lossy = a.lossy ? s.yellow(`  exit codes unavailable in ${a.lossy} session${a.lossy === 1 ? "" : "s"} (test runs assumed to pass)`) : "";
      out2(`  ${s.dim(pad2(agent, 12))} ${pad2(`${a.sessions} session${a.sessions === 1 ? "" : "s"}`, 13)} ${pad2(`${a.claims} claim${a.claims === 1 ? "" : "s"}`, 11)} ${pad2(pct(a.verified, a.claims), 5)} verified${lossy}`);
    }
    if (total === 0) {
      out2(`  ${s.yellow("no completion claims found")}  ${s.dim("(no Claude Code, Codex, Gemini CLI, Qwen Code or Cursor transcripts found, or none with file edits)")}`);
      return 0;
    }
    out2("");
    out2(`  ${s.green("VERIFIED")}   ${pad2(pct(verified, total), 5)} ${s.dim(pad2(`(${verified})`, 7))} a test command passed after the last edit`);
    out2(`  ${s.yellow("STALE")}      ${pad2(pct(report.counts.STALE, total), 5)} ${s.dim(pad2(`(${report.counts.STALE})`, 7))} tests passed, then more edits, no re-run`);
    out2(`  ${s.red("FAILED")}     ${pad2(pct(report.counts.FAILED, total), 5)} ${s.dim(pad2(`(${report.counts.FAILED})`, 7))} the last test run failed, "done" claimed anyway`);
    out2(`  ${s.red("NEVER RAN")}  ${pad2(pct(report.counts.NEVER_RAN, total), 5)} ${s.dim(pad2(`(${report.counts.NEVER_RAN})`, 7))} no test command in the turn at all`);
    out2("");
    out2(`  ${s.bold(`${pct(total - verified, total)} of "done" claims (${total - verified} of ${total}) had no passing test run behind them.`)}`);
    const mixed = report.claims.filter((c) => c.verdict === "VERIFIED" && c.testFails > 0).length;
    if (mixed > 0) out2(`  ${s.yellow(`${mixed} of the verified claims had a failed test run earlier in the same turn; only the last command passed, and it may have been a narrower one (--verbose marks them).`)}`);
    const g = report.gate;
    if (g) {
      out2("");
      out2(`  ${s.bold("gate")}  the isitdone Stop hook decided ${g.checked} stop${g.checked === 1 ? "" : "s"} in ${g.projects} project${g.projects === 1 ? "" : "s"} ${s.dim("(.isitdone/decisions.jsonl)")}`);
      out2(`        ${g.passed} passed; ${g.blockedTurns} turn${g.blockedTurns === 1 ? "" : "s"} blocked: ${g.fixed} fixed and then passed, ${g.gaveUp} gave up after the cap, ${g.released} released${g.pausedTurns ? `, ${g.pausedTurns} let go by a pause` : ""}${g.cutOffTurns ? `, ${g.cutOffTurns} cut off by the host` : ""}${g.open ? `, ${g.open} still open` : ""}`);
      if (g.cutOff) out2(`        ${s.yellow(`${g.cutOff} check run${g.cutOff === 1 ? "" : "s"} never finished, cut off by the host (its hook timeout, or an interrupted turn): nothing was verified`)} ${s.dim("(`npx isitdone doctor` compares the timeouts)")}`);
      if (g.claims) out2(`        ${g.claims} stop${g.claims === 1 ? "" : "s"} claimed done; ${g.claimsBlocked} of them ${g.claimsBlocked === 1 ? "was" : "were"} refused (${pct(g.claimsBlocked, g.claims)})`);
      if (g.pausedStops) out2(`        ${g.pausedStops} stop${g.pausedStops === 1 ? " was" : "s were"} let through unchecked while the gate was paused (\`isitdone pause\`)`);
      out2(`        ${s.dim("transcripts only show the tests the agent ran itself; the hook's own runs in these projects are counted here, not above")}`);
    }
    const worst = [...report.byProject].filter((p) => p.claims >= 5).sort((a, b) => b.unbackedPct - a.unbackedPct)[0];
    if (worst) out2(`  worst project  ${worst.project}  ${pct(worst.claims - worst.verified, worst.claims)} unbacked (${worst.claims - worst.verified} of ${worst.claims} claims)`);
    if (args.flags.verbose === true) {
      out2("");
      for (const c of report.claims) out2(`  ${pad2(c.verdict, 9)} ${s.dim(c.at.slice(0, 10))}  ${s.dim(c.project)}  ${JSON.stringify(c.claim)}${c.lossy ? s.yellow("  (no exit codes)") : ""}${c.verdict === "VERIFIED" && c.testFails > 0 ? s.yellow(`  (after ${c.testFails} failed run${c.testFails === 1 ? "" : "s"})`) : ""}`);
    } else {
      out2("");
      out2(`  ${s.dim("per project:")}`);
      for (const p of report.byProject.slice(0, 10)) out2(`  ${pad2(pct(p.verified, p.claims), 5)} verified  ${pad2(String(p.claims), 4)} claims  ${s.dim(p.project)}`);
      if (report.byProject.length > 10) out2(`  ${s.dim(`... ${report.byProject.length - 10} more`)}`);
    }
    out2("");
    out2(`  ${s.dim("make the agent prove it:")}  ${NPX} init`);
  }
  if (min !== null && total > 0 && Math.round(100 * verified / total) < min) return 1;
  return 0;
}
function pad2(s, width) {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}
async function cmdReceipt(args) {
  const root = repoRoot(args.flags);
  const git3 = gitInfo(root);
  const ev = evaluateReceipt(root, git3, configHash(root));
  const s = styleFor(process.stdout);
  const done = ev.state === "PASS" && ev.receipt?.profile === "full";
  if (args.flags.json === true) {
    out2(JSON.stringify({ state: ev.state, reason: ev.reason, done, receipt: ev.receipt, tree: git3.tree }, null, 2));
  } else if (args.flags.md === true) {
    if (!ev.receipt) out2(`No isitdone receipt (${ev.reason}). Run \`${NPX}\`.`);
    else out2(formatMarkdown(ev.receipt, ev.state));
  } else {
    out2(formatReceiptState(ev, s, `run \`${NPX}\``));
  }
  return done ? 0 : 1;
}
function cmdDetect(args) {
  const root = repoRoot(args.flags);
  const { config, source } = loadConfig(root);
  const d = detectChecks(root, config);
  if (args.flags.json === true) {
    out2(JSON.stringify({ root, configSource: source, stacks: d.stacks, checks: d.checks.map((c) => ({ ...c, timeoutSeconds: timeoutFor(c, config) / 1e3 })), env: d.env, notes: d.notes }, null, 2));
    return 0;
  }
  out2(formatDetection(root, d, config, source, styleFor(process.stdout)));
  return 0;
}
async function cmdMcp(args) {
  return runMcpServer({ cwd: typeof args.flags.cwd === "string" ? resolve6(args.flags.cwd) : void 0 });
}
async function cmdHook(args) {
  const host = typeof args.flags.host === "string" ? args.flags.host : "";
  if (!HOST_NAMES.includes(host)) {
    err(`isitdone hook: --host must be one of ${HOST_NAMES.join(", ")}`);
    return 3;
  }
  const stdin = await readStdin();
  if (args.flags.event === "edit") {
    const o = runEditHook({ host, stdin, cwd: typeof args.flags.cwd === "string" ? resolve6(args.flags.cwd) : process.cwd() });
    if (process.env.ISITDONE_DEBUG) err(`isitdone edit hook: ${o.why}`);
    if (o.stdout !== "") process.stdout.write(o.stdout + "\n");
    return 0;
  }
  const profile = args.flags.profile;
  const outcome = await runHook({
    host,
    stdin,
    cwd: typeof args.flags.cwd === "string" ? resolve6(args.flags.cwd) : process.cwd(),
    doctor: process.env.ISITDONE_DOCTOR === "1",
    profile: profile === "lite" || profile === "full" || profile === "claim-gated" ? profile : void 0
  });
  if (process.env.ISITDONE_DEBUG) err(`isitdone hook: ${outcome.decision} - ${outcome.why}`);
  if (outcome.stdout !== "") process.stdout.write(outcome.stdout + "\n");
  if (outcome.stderr !== "") process.stderr.write(outcome.stderr + "\n");
  return outcome.exitCode;
}
async function cmdInit(args) {
  const root = repoRoot(args.flags);
  const s = styleFor(process.stdout);
  const json = args.flags.json === true;
  const agentFlag = typeof args.flags.agent === "string" ? args.flags.agent : "auto";
  let hosts;
  if (agentFlag === "auto" || agentFlag === "all") hosts = agentFlag;
  else {
    const names = agentFlag.split(",").map((x) => x.trim());
    for (const n of names) {
      if (!HOST_NAMES.includes(n)) {
        err(`--agent must be one of ${HOST_NAMES.join(", ")}, all, auto (got ${n})`);
        return 3;
      }
    }
    hosts = names;
  }
  const timeout = typeof args.flags.timeout === "string" ? Number(args.flags.timeout) : void 0;
  if (timeout !== void 0 && !(Number.isInteger(timeout) && timeout > 0)) {
    err("--timeout must be a positive whole number of seconds");
    return 3;
  }
  const remove = args.flags.remove === true;
  const command = typeof args.flags.command === "string" ? args.flags.command : void 0;
  const scope = args.flags.user === true ? "user" : "project";
  const useNpx = typeof args.flags.npx === "boolean" ? args.flags.npx : scope === "project";
  let hookCommand = command ? () => command : void 0;
  let localCopy = null;
  if (!command && !useNpx && !remove) {
    localCopy = installLocalCopy();
    const path = localCopy.action === "unavailable" ? null : localCopy.path;
    if (path) hookCommand = (h) => directCommand(path, h.name);
  }
  let results;
  try {
    results = init({
      root,
      hosts,
      scope,
      timeout,
      remove,
      command: hookCommand,
      editHook: args.flags["edit-hook"] !== false
    });
  } catch (e) {
    err(`isitdone init: ${e.message}`);
    return 3;
  }
  const { config } = loadConfig(root);
  const d = detectChecks(root, config);
  let gi = "skipped";
  if (!remove) gi = ensureGitignore(root);
  if (json) {
    const report = !remove && args.flags.doctor !== false ? await doctor({ root, probeHooks: args.flags.probe !== false, checkLatest: args.flags.latest !== false, baseline: args.flags.baseline !== false }) : null;
    out2(JSON.stringify({ root, hooks: results, detected: d.checks, notes: d.notes, gitignore: gi, localCopy, doctor: report }, null, 2));
    return report ? report.ok ? 0 : 1 : 0;
  }
  out2(`${s.bold("isitdone init")}  ${s.dim(root)}`);
  if (!remove) {
    if (d.checks.length === 0) out2(`  ${s.yellow("detected   no checks")}  ${s.dim("(add package.json scripts or a .isitdone.json; the hook allows every stop until then)")}`);
    else out2(`  detected   ${d.checks.map((c) => c.cmd).join(", ")}`);
    out2(`  profile    ${config.profile ?? "claim-gated"}  ${s.dim("(lite checks on every stop, full checks when the agent claims done)")}`);
    if (gi === "added") out2(`  gitignore  added .isitdone/`);
  }
  const nameWidth = Math.max(12, ...results.map((r) => r.displayName.length + 1));
  for (const r of results) {
    const verb = r.action === "added" ? s.green("added") : r.action === "updated" ? s.cyan("updated") : r.action === "removed" ? s.yellow("removed") : r.action === "skipped" ? s.yellow("skipped") : s.dim(r.action);
    out2(`  ${r.displayName.padEnd(nameWidth)}${verb}${" ".repeat(Math.max(1, 11 - r.action.length))}${s.dim(`${r.hostEvent.padEnd(18)} ${r.path}${r.action === "added" || r.action === "updated" ? ` (timeout ${r.timeout}s)` : ""}`)}`);
  }
  const notes = results.filter((r) => r.note && r.action !== "removed" && r.action !== "absent");
  for (const r of notes) out2(`  ${s.dim("note:")} ${r.note}`);
  if (localCopy?.action === "unavailable") out2(`  ${s.yellow("note:")} the hook runs through npx after all: ${localCopy.note}`);
  else if (localCopy) {
    out2(`  ${s.dim("note:")} the hook runs ${localCopy.path} (isitdone ${localCopy.version}) with node, which skips npx's start-up on every call; \`${NPX} update\` refreshes that copy`);
    if (scope === "project") out2(`  ${s.yellow("note:")} the project settings now hold a path into your home directory; keep them out of git, or re-run init with --npx`);
  }
  if (!remove && args.flags.doctor !== false) {
    out2("");
    return await cmdDoctor(args);
  }
  return 0;
}
async function cmdDoctor(args) {
  const root = repoRoot(args.flags);
  const s = styleFor(process.stdout);
  const live = args.flags.json !== true && Boolean(process.stdout.isTTY);
  const report = await doctor({
    root,
    probeHooks: args.flags.probe !== false,
    checkLatest: args.flags.latest !== false,
    baseline: args.flags.baseline !== false,
    onCheckStart: live ? (c) => process.stdout.write(s.dim(`  baseline: running ${c.cmd} ...`)) : void 0,
    onCheckDone: live ? () => process.stdout.write(`\r${" ".repeat(70)}\r`) : void 0
  });
  if (args.flags.json === true) {
    out2(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  out2(`${s.bold("isitdone doctor")}  ${s.dim(root)}`);
  for (const c of report.checks) {
    const mark = c.name.startsWith("note") ? s.dim("i") : c.ok ? s.green("ok") : s.red("!!");
    out2(`  ${mark.padEnd(c.name.startsWith("note") ? 11 : 12)} ${s.bold(c.name.padEnd(14))} ${c.detail}`);
    if (c.hint && !c.ok) out2(`  ${" ".repeat(2)} ${s.dim("-> " + c.hint)}`);
  }
  out2("");
  if (!report.ok) out2(`  ${s.yellow(s.bold("ATTENTION"))}   fix the items marked !! above`);
  else if (report.paused) out2(`  ${s.yellow(s.bold("PAUSED"))}   the hook works, but lets every stop through until ${formatPauseTime(Date.parse(report.paused.until))} (\`${NPX} resume${report.paused.scope === "global" ? " --global" : ""}\` ends it)`);
  else out2(`  ${s.green(s.bold("OK"))}   the agent cannot claim done with failing checks in this repo`);
  return report.ok ? 0 : 1;
}
var PAUSE_SINCE = "0.9.0";
function pauseCwd(flags) {
  const cwd = typeof flags.cwd === "string" ? resolve6(flags.cwd) : process.cwd();
  return existsSync18(cwd) ? cwd : null;
}
function pinnedPluginHooks(dir2) {
  const found = [];
  let budget = 5e3;
  const walk = (d, depth) => {
    let entries;
    try {
      entries = readdirSync14(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (--budget < 0) return;
      const p = join23(d, e.name);
      if (e.isDirectory() && depth < 7 && e.name !== "node_modules" && e.name !== ".git") walk(p, depth + 1);
      else if (e.isFile() && e.name === "hooks.json") {
        const pinned = /@aivolution\/isitdone@(\d+\.\d+\.\d+)/.exec(readFileSync13(p, "utf8"))?.[1];
        if (pinned) found.push([p, pinned]);
      }
    }
  };
  walk(dir2, 0);
  return found;
}
function stalePauseReaders(cwd, top) {
  const found = [];
  try {
    const cache = npmCacheDir();
    const old = /* @__PURE__ */ new Set();
    for (const dir2 of cache ? findNpxEntries(cache) : []) {
      const v = tryReadJsonFile(join23(dir2, "node_modules", "@aivolution", "isitdone", "package.json"))?.version;
      if (typeof v === "string" && isNewer(PAUSE_SINCE, v)) old.add(v);
    }
    if (old.size) found.push(`npx has isitdone ${[...old].join(", ")} cached; a hook that runs \`npx -y ${PACKAGE_NAME} hook\` may keep using it and ignore the pause until \`${NPX} update\` refreshes the cache (a hook pinned to an older version has to be updated itself)`);
  } catch {
  }
  try {
    const root = findRoot(cwd, top);
    for (const h of installedHooks(root)) {
      const pinned = h.event === "stop" ? /@aivolution\/isitdone@(\d+\.\d+\.\d+)/.exec(h.command)?.[1] : void 0;
      if (pinned && isNewer(PAUSE_SINCE, pinned)) found.push(`the ${h.host.displayName} hook in ${h.path} is pinned to isitdone ${pinned}, which ignores pauses; re-run \`${NPX} init\` there and restart its sessions`);
    }
    for (const h of pluginHooks(root)) {
      const pinned = h.event === "stop" ? /@aivolution\/isitdone@(\d+\.\d+\.\d+)/.exec(h.command)?.[1] : void 0;
      if (pinned && isNewer(PAUSE_SINCE, pinned)) found.push(`the Claude Code plugin hook in ${h.path} is pinned to isitdone ${pinned}, which ignores pauses; update the plugin and restart its sessions`);
    }
    const copy = localCopyPath();
    const copyVersion = copy && existsSync18(copy) ? bundleVersion(copy) : null;
    if (copyVersion && isNewer(PAUSE_SINCE, copyVersion)) found.push(`the local copy ${copy} is isitdone ${copyVersion}, which ignores pauses; \`${NPX} update\` refreshes it`);
    for (const [file, pinned] of pinnedPluginHooks(join23(homedir9(), ".claude", "plugins"))) {
      if (isNewer(PAUSE_SINCE, pinned)) found.push(`the Claude Code plugin copy at ${file} pins isitdone ${pinned}, which ignores pauses; if that plugin is installed, update it (/plugin) and restart its sessions`);
    }
    const local = tryReadJsonFile(join23(root, "node_modules", "@aivolution", "isitdone", "package.json"))?.version;
    if (typeof local === "string" && isNewer(PAUSE_SINCE, local)) found.push(`this project has isitdone ${local} in node_modules, which ignores pauses; \`npm update ${PACKAGE_NAME}\``);
  } catch {
  }
  return found;
}
function cmdPause(args) {
  const s = styleFor(process.stdout);
  if (isAgentShell()) {
    err(`isitdone pause: this is the user's switch, and this shell looks like one an agent host started (a terminal opened from inside an agent's app counts too). If you are the agent: ask the user to run \`${NPX} pause\` in a terminal of their own, and do not try to get around this.`);
    return 3;
  }
  if (args.rest.length > 0) {
    err(`isitdone pause: unexpected argument${args.rest.length === 1 ? "" : "s"} ${args.rest.map((a) => JSON.stringify(a)).join(" ")} (a length goes after --for; quote a time that has a space: --until "2026-11-02 11:00")`);
    return 3;
  }
  if (args.flags.for === true || args.flags.until === true) {
    err(`isitdone pause: --${args.flags.for === true ? "for" : "until"} needs a value`);
    return 3;
  }
  const forRaw = typeof args.flags.for === "string" ? args.flags.for : null;
  const untilRaw = typeof args.flags.until === "string" ? args.flags.until : null;
  if (forRaw !== null && untilRaw !== null) {
    err("isitdone pause: give --for or --until, not both");
    return 3;
  }
  const now = Date.now();
  let untilMs = now + DEFAULT_PAUSE_MS;
  if (forRaw !== null) {
    const d = parseDuration(forRaw);
    if (d === null) {
      err(`isitdone pause: --for must look like 30m, 2h, 3d or 1w (got ${forRaw})`);
      return 3;
    }
    untilMs = now + d;
  } else if (untilRaw !== null) {
    const u = parseUntil(untilRaw);
    if (u === null) {
      err(`isitdone pause: --until must be a real date or time, e.g. 2026-11-02, 2026-11-02T11:00 (local) or 2026-11-02T11:00Z (got ${untilRaw})`);
      return 3;
    }
    if (u <= now) {
      err(`isitdone pause: ${untilRaw} is already past`);
      return 3;
    }
    untilMs = u;
  }
  if (untilMs - now > MAX_PAUSE_MS) {
    err(`isitdone pause: a pause lasts at most 30 days, and this one would end ${formatPauseTime(untilMs)}; \`${NPX} uninstall\` removes the hook for longer`);
    return 3;
  }
  const cwd = pauseCwd(args.flags);
  if (!cwd) {
    err(`isitdone pause: --cwd ${String(args.flags.cwd)} does not exist`);
    return 3;
  }
  const global = args.flags.global === true;
  const top = gitTopLevel(cwd);
  if (!global && !top) {
    err(`isitdone pause: ${cwd} is not inside a git repository; add --global to pause the hook in every repository`);
    return 3;
  }
  let p;
  try {
    p = writePause(global ? "global" : "repo", cwd, untilMs, VERSION, now, top ?? void 0);
  } catch (e) {
    err(`isitdone pause: ${e.message}`);
    return 3;
  }
  const stale = stalePauseReaders(cwd, top);
  if (args.flags.json === true) {
    out2(JSON.stringify({ paused: true, scope: p.scope, until: p.until, file: p.file, repository: global ? null : top, notYetInForce: stale }, null, 2));
    return 0;
  }
  out2(`${s.bold("isitdone paused")}  ${describePause(p, now)}${global ? "" : s.dim(`  ${top} and its worktrees`)}`);
  out2("  Agents' stops go through without running the checks, and a check run already going is stopped. Every stop that");
  out2(`  claims to be done says so in the session, on hosts that can show a message. \`${NPX} resume${global ? " --global" : ""}\` ends it early.`);
  if (stale.length) for (const w of stale) out2(s.yellow(`  not in force yet: ${w}`));
  else out2(`  Hooks running isitdone ${PAUSE_SINCE} or later pick it up at their next stop, in sessions already running too.`);
  out2(s.dim(`  ${p.file}; \`${NPX}\` by hand, the MCP tools and CI still run the checks.`));
  return 0;
}
function cmdResume(args) {
  const s = styleFor(process.stdout);
  if (args.rest.length > 0) {
    err(`isitdone resume: unexpected argument${args.rest.length === 1 ? "" : "s"} ${args.rest.map((a) => JSON.stringify(a)).join(" ")} (--global ends the user-wide pause)`);
    return 3;
  }
  const cwd = pauseCwd(args.flags);
  if (!cwd) {
    err(`isitdone resume: --cwd ${String(args.flags.cwd)} does not exist`);
    return 3;
  }
  const global = args.flags.global === true;
  if (!global && !gitTopLevel(cwd)) {
    err(`isitdone resume: ${cwd} is not inside a git repository; \`${NPX} resume --global\` ends the user-wide pause`);
    return 3;
  }
  const files = pauseFiles(cwd);
  let ended;
  try {
    ended = global ? clearPause(files.global, "global") : clearPause(files.repo, "repo");
  } catch (e) {
    err(`isitdone resume: ${e.message}`);
    return 1;
  }
  const still = activePause(pauseFiles(cwd));
  if (args.flags.json === true) {
    out2(JSON.stringify({ resumed: ended ? { scope: ended.scope, until: ended.until, file: ended.file } : null, stillPaused: still ? { scope: still.scope, until: still.until, file: still.file } : null }, null, 2));
    return 0;
  }
  if (ended) out2(`${s.bold("isitdone resumed")}  ${global ? "the user-wide pause is over" : "in this repository"}${s.dim(`  (it was to last until ${formatPauseTime(ended.untilMs)})`)}`);
  else out2(`isitdone resume: no ${global ? "user-wide pause" : "pause for this repository"} was in force`);
  if (still) out2(s.yellow(`  still paused ${describePause(still)}; \`${NPX} resume${still.scope === "global" ? " --global" : ""}\` ends that one`));
  return 0;
}
function cmdUpdate(args) {
  const s = styleFor(process.stdout);
  const json = args.flags.json === true;
  const checkOnly = args.flags.check === true;
  const r = runUpdate({ checkOnly, warm: args.flags.warm !== false });
  if (json) {
    out2(JSON.stringify(r, null, 2));
    return 0;
  }
  out2(`${s.bold("isitdone update")}  ${s.dim(`running ${r.running}${r.latest ? `, latest ${r.latest}` : ", registry unreachable"}`)}`);
  if (checkOnly) {
    if (r.latest && isNewer(r.latest, r.running)) out2(`  ${s.yellow("outdated")}   ${r.latest} is available; run \`${NPX} update\``);
    else if (r.latest) out2(`  ${s.green("up to date")}`);
    return 0;
  }
  if (r.removed.length === 0) out2(`  ${s.dim("no cached npx copies found")}${r.cacheDir ? s.dim(` under ${r.cacheDir}`) : ""}`);
  for (const d of r.removed) out2(`  removed    ${s.dim(d)}`);
  for (const w of r.warmed) out2(`  ${w.version ? s.green("warmed ") : s.red("failed ")}    ${w.pkg.padEnd(24)} ${w.version ?? ""}${w.error ? s.dim("  " + w.error) : ""}`);
  if (r.localCopy) out2(`  local copy ${s.dim(r.localCopy.path)}  ${r.localCopy.action === "updated" || r.localCopy.action === "installed" ? s.green(`now ${r.localCopy.version}`) : r.localCopy.action === "unchanged" ? `already ${r.localCopy.version ?? "current"}` : s.red("could not be refreshed")}`);
  out2(`  ${s.dim("hooks that run `npx -y " + PACKAGE_NAME + " hook ...` now use the refreshed copy; `npm i -D " + PACKAGE_NAME + "` projects should run `npm update " + PACKAGE_NAME + "`.")}`);
  return r.warmed.some((w) => w.error) || r.localCopy?.action === "unavailable" ? 1 : 0;
}
async function main(argv) {
  const args = parseArgs(argv);
  if (args.flags.version === true || args.command === "version") {
    out2(VERSION);
    return 0;
  }
  if (args.flags.help === true || args.command === "help") {
    out2(HELP);
    return 0;
  }
  const isHook = args.command === "hook";
  if (!isHook) {
    const bad = unknownFlags(args);
    if (bad.length > 0) {
      err(`isitdone: unknown option${bad.length === 1 ? "" : "s"} ${bad.map((b) => "--" + b).join(", ")} (see --help)`);
      return 3;
    }
  }
  try {
    switch (args.command) {
      case "run":
      case "check":
      case "verify":
        return await cmdRun(args);
      case "receipt":
        return await cmdReceipt(args);
      case "detect":
        return cmdDetect(args);
      case "hook":
        return await cmdHook(args);
      case "init":
      case "install":
        return await cmdInit(args);
      case "uninstall":
        args.flags.remove = true;
        return await cmdInit(args);
      case "doctor":
        return await cmdDoctor(args);
      case "history":
        return await cmdHistory(args);
      case "update":
        return cmdUpdate(args);
      case "pause":
        return cmdPause(args);
      case "resume":
        return cmdResume(args);
      case "mcp":
        return await cmdMcp(args);
      default:
        err(`isitdone: unknown command "${args.command}"
`);
        err(HELP);
        return 3;
    }
  } catch (e) {
    const msg = e.message ?? String(e);
    if (isHook) {
      if (process.env.ISITDONE_DEBUG) err(`isitdone hook: internal error: ${msg}`);
      const host = typeof args.flags.host === "string" && HOST_NAMES.includes(args.flags.host) ? getHost(args.flags.host) : null;
      const text = host?.allow(`isitdone: internal error (${msg}); the stop was allowed without verification. Run \`${NPX} doctor\`.`) ?? "";
      if (text !== "") process.stdout.write(text + "\n");
      return 0;
    }
    err(`isitdone: ${msg}`);
    return 3;
  }
}
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`isitdone: ${e.message ?? String(e)}`);
    process.exitCode = 3;
  }
);
export {
  main
};
