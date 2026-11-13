"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../engine/src/envutil/index.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var MissingToolPrefix = "\u7F3A\u5C11\u5FC5\u9700\u5DE5\u5177";
var MissingToolError = class extends Error {
  constructor(tool) {
    super(`${MissingToolPrefix}\uFF1A${tool}`);
    this.tool = tool;
  }
  tool;
};
function lookPath(name, pathValue) {
  if (name.includes(import_node_path.default.sep)) return name;
  for (const dir of pathValue.split(import_node_path.default.delimiter)) {
    const candidate = import_node_path.default.join(dir || ".", name);
    try {
      const stat = import_node_fs.default.statSync(candidate);
      if (stat.isFile() && (stat.mode & 73) !== 0) return candidate;
    } catch {
    }
  }
  throw new MissingToolError(name);
}
function envMap() {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== void 0) out[key] = value;
  return out;
}

// ../engine/src/gofmt/index.ts
function goQuote(value) {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch === "\x07") out += "\\a";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\v") out += "\\v";
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}
function isGoSpace(c) {
  switch (c) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 13:
    case 32:
    case 133:
    case 160:
    case 5760:
    case 8232:
    case 8233:
    case 8239:
    case 8287:
    case 12288:
      return true;
  }
  return c >= 8192 && c <= 8202;
}
function goTrimSpace(s) {
  let start = 0;
  let end = s.length;
  while (start < end && isGoSpace(s.charCodeAt(start))) start++;
  while (end > start && isGoSpace(s.charCodeAt(end - 1))) end--;
  return s.slice(start, end);
}
function goClean(p) {
  if (p === "") return ".";
  const rooted = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (rooted) return "/" + joined;
  return joined === "" ? "." : joined;
}
function goJoin(...elems) {
  const parts = elems.filter((e) => e !== "");
  if (parts.length === 0) return "";
  return goClean(parts.join("/"));
}
function goDir(p) {
  const i = p.lastIndexOf("/");
  return goClean(p.slice(0, i + 1));
}
function goExt(p) {
  for (let i = p.length - 1; i >= 0 && p[i] !== "/"; i--) {
    if (p[i] === ".") return p.slice(i);
  }
  return "";
}
var errnoText = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOTDIR: "not a directory",
  EISDIR: "is a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  EXDEV: "cross-device link",
  ELOOP: "too many levels of symbolic links",
  ENAMETOOLONG: "file name too long"
};
function goPathError(op, file, err) {
  const code = err?.code;
  const reason = code && errnoText[code] || (err instanceof Error ? err.message : String(err));
  return `${op} ${file}: ${reason}`;
}

// ../engine/src/hyperframes/constants.ts
var SkillsSubdir = ".agents/skills";
var PinnedVersion = "0.8.225";
var SkillsRepoURL = "https://github.com/heygen-com/hyperframes.git";
var PinnedSkillsCommit = "b687d062353f2dd43a9a4b8b77aafeb1077b3875";
var PinnedSkillsCount = 14;
var skillsSubdirsInRepo = ["skills", SkillsSubdir];
var manifestFile = "SKILL.md";

// ../engine/src/hyperframes/hyperframes.ts
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);

// ../engine/src/gojson/index.ts
var hex = "0123456789abcdef";
function encodeString(s, escapeHTML) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34) out += '\\"';
    else if (c === 92) out += "\\\\";
    else if (c === 10) out += "\\n";
    else if (c === 13) out += "\\r";
    else if (c === 9) out += "\\t";
    else if (c === 8) out += "\\b";
    else if (c === 12) out += "\\f";
    else if (c < 32 || c === 8232 || c === 8233 || escapeHTML && (c === 60 || c === 62 || c === 38)) {
      out += "\\u" + (c < 256 ? "00" + hex[c >> 4] + hex[c & 15] : c.toString(16));
    } else if (c >= 55296 && c <= 56319) {
      const next = s.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        out += s[i] + s[i + 1];
        i++;
      } else out += "\\ufffd";
    } else if (c >= 56320 && c <= 57343) {
      out += "\\ufffd";
    } else out += s[i];
  }
  return out + '"';
}
function encodeNumber(n) {
  if (!Number.isFinite(n)) throw new Error(`json: unsupported value: ${n}`);
  if (Object.is(n, -0)) return "-0";
  return String(n);
}
function encode(value, escapeHTML, indent, prefix) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return encodeString(value, escapeHTML);
    case "number":
      return encodeNumber(value);
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
    case "function":
    case "symbol":
      return void 0;
  }
  const v = value;
  if (typeof v.toJSON === "function" && !(value instanceof Date)) return encode(v.toJSON(), escapeHTML, indent, prefix);
  if (value instanceof Date) return encodeString(value.toISOString(), escapeHTML);
  const inner = prefix + indent;
  const nl = indent ? "\n" : "";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items2 = value.map((item) => (indent ? inner : "") + (encode(item, escapeHTML, indent, inner) ?? "null"));
    return "[" + nl + items2.join("," + nl) + nl + (indent ? prefix : "") + "]";
  }
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    const encoded = encode(item, escapeHTML, indent, inner);
    if (encoded === void 0) continue;
    entries.push((indent ? inner : "") + encodeString(key, escapeHTML) + (indent ? ": " : ":") + encoded);
  }
  if (entries.length === 0) return "{}";
  return "{" + nl + entries.join("," + nl) + nl + (indent ? prefix : "") + "}";
}
function marshal(value, options = {}) {
  return encode(value, options.escapeHTML ?? true, options.indent ?? "", "") ?? "null";
}
function marshalIndent(value, indent = "  ", escapeHTML = true) {
  return marshal(value, { indent, escapeHTML });
}
function encodeLine(value, options = {}) {
  return marshal(value, options) + "\n";
}
function compareBytes(a, b) {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const x = ca[i].codePointAt(0);
    const y = cb[i].codePointAt(0);
    if (x !== y) return x - y;
  }
  return ca.length - cb.length;
}

// ../engine/src/prereq/index.ts
var SetupCommand = "am setup";
var MissingError = class extends Error {
  /**
   * @param what 资源名，例如「HyperFrames CLI 0.8.225」。
   * @param detail 补充说明（缺在哪里），可以为空。
   */
  constructor(what, detail = "") {
    super(
      `\u7F3A\u5C11\u524D\u7F6E\u8D44\u6E90\uFF1A${what}${detail !== "" ? "\uFF08" + detail + "\uFF09" : ""}\u3002\u5148\u5728\u7EC8\u7AEF\u8FD0\u884C ${SetupCommand} \u51C6\u5907\u597D\uFF08\u53EF\u4EE5\u52A0 --proxy \u8D70\u4EE3\u7406\uFF0C\u65AD\u4E86\u91CD\u8DD1\u4F1A\u63A5\u7740\u4E0B\uFF09\uFF0C\u518D\u91CD\u8BD5`
    );
    this.what = what;
    this.detail = detail;
    this.name = "MissingError";
  }
  what;
  detail;
};
function missing(what, detail) {
  return new MissingError(what, detail);
}

// ../engine/src/hyperframes/util.ts
var import_node_child_process = require("node:child_process");

// ../engine/src/procgroup/index.ts
var ExitError = class extends Error {
  constructor(code, signal) {
    super(signal ? `signal: ${signal}` : `exit status ${code}`);
    this.code = code;
    this.signal = signal;
    this.name = "ExitError";
  }
  code;
  signal;
  exitCode() {
    return this.code;
  }
};
function abortReason(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(reason === void 0 ? "context canceled" : String(reason));
  err.name = "AbortError";
  return err;
}

// ../engine/src/hyperframes/util.ts
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
function goQuote2(s) {
  return JSON.stringify(s);
}
function goList(values) {
  return "[" + values.join(" ") + "]";
}
function runCommand(file, args, options = {}) {
  const { signal } = options;
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = (0, import_node_child_process.spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", options.stderr ? "pipe" : "ignore"]
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => options.stderr.write(chunk));
    }
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let failed = false;
    child.once("error", (err) => {
      failed = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve3(out);
    });
  });
}

// ../engine/src/hyperframes/progress.ts
var cloneStages = [
  { prefix: "remote: Counting objects", label: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", from: 0, to: 4 },
  { prefix: "remote: Compressing objects", label: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", from: 4, to: 8 },
  { prefix: "Receiving objects", label: "\u4E0B\u8F7D\u6280\u80FD\u4ED3\u5E93", from: 8, to: 62 },
  { prefix: "Resolving deltas", label: "\u6574\u7406\u4E0B\u8F7D\u5185\u5BB9", from: 62, to: 68 },
  { prefix: "Updating files", label: "\u6574\u7406\u4E0B\u8F7D\u5185\u5BB9", from: 68, to: 72 }
];
var checkoutStart = 72;
var copyStart = 95;
var percentPattern = /(\d{1,3})%/;
var GitProgress = class {
  constructor(report, next) {
    this.report = report;
    this.next = next;
  }
  report;
  next;
  buf = "";
  last = 0;
  write(chunk) {
    this.next?.write(chunk);
    this.buf += chunk;
    for (; ; ) {
      const i = this.buf.search(/[\r\n]/);
      if (i < 0) break;
      this.line(this.buf.slice(0, i));
      this.buf = this.buf.slice(i + 1);
    }
    return chunk.length;
  }
  line(line) {
    for (const stage of cloneStages) {
      if (!line.startsWith(stage.prefix)) continue;
      const match = percentPattern.exec(line);
      if (!match) return;
      const percent = Number.parseInt(match[1], 10);
      const overall = stage.from + (stage.to - stage.from) * Math.min(percent, 100) / 100;
      if (overall < this.last) return;
      this.last = overall;
      this.report({ stage: stage.label, percent: overall });
      return;
    }
  }
};

// ../engine/src/hyperframes/hyperframes.ts
function resolve(opts, defaultVersion) {
  return {
    ...opts,
    version: opts.version || defaultVersion,
    repoURL: opts.repoURL || SkillsRepoURL,
    expectCommit: opts.expectCommit || PinnedSkillsCommit,
    expectSkills: opts.expectSkills || PinnedSkillsCount,
    env: opts.env ?? {}
  };
}
function defaultCacheDir(env) {
  if (env.XDG_DATA_HOME) return import_node_path2.default.join(env.XDG_DATA_HOME, "am", "hyperframes");
  if (env.HOME) return import_node_path2.default.join(env.HOME, ".local", "share", "am", "hyperframes");
  return "";
}
function skillsReady(cacheDir) {
  return cachedTree(cacheDir, PinnedSkillsCommit, PinnedSkillsCount) !== "";
}
function exists(file) {
  try {
    import_node_fs2.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
async function prepareSkills(options, signal) {
  const opts = resolve(options, PinnedVersion);
  if (!opts.cacheDir) throw new Error("\u65E0\u6CD5\u786E\u5B9A HyperFrames \u6280\u80FD\u7684\u7F13\u5B58\u76EE\u5F55\uFF1A\u73AF\u5883\u91CC\u6CA1\u6709 HOME");
  if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) !== "") return;
  const report = opts.progress ?? (() => {
  });
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D HyperFrames \u6280\u80FD\uFF1A${errorText(err)}`, { cause: err });
  }
  const tmp = makeTemp();
  try {
    report({ stage: "\u8FDE\u63A5\u4E0A\u6E38\u4ED3\u5E93", percent: 0 });
    const commit = await cloneSkills(git, tmp, opts, report, signal);
    report({ stage: "\u5B58\u8FDB\u672C\u673A\u7F13\u5B58", percent: copyStart });
    try {
      storeCache(opts.cacheDir, commit, tmp);
    } catch (err) {
      throw new Error(`\u5B58\u8FDB\u672C\u673A\u7F13\u5B58\uFF1A${errorText(err)}`, { cause: err });
    }
    if (cachedTree(opts.cacheDir, opts.expectCommit, opts.expectSkills) === "") {
      import_node_fs2.default.rmSync(import_node_path2.default.join(opts.cacheDir, commit), { recursive: true, force: true });
      throw new Error(
        `\u4E0A\u6E38 ${commit} \u62FC\u88C5\u51FA\u7684\u6280\u80FD\u6570\u4E0D\u662F ${opts.expectSkills}\uFF1A\u6280\u80FD\u76EE\u5F55\u7ED3\u6784\u53EF\u80FD\u5DF2\u53D8\uFF0C\u6838\u5BF9 ${goList(skillsSubdirsInRepo)} \u4E24\u5904\u540E\u540C\u6B65 PinnedSkillsCount`
      );
    }
    report({ stage: "\u5B8C\u6210", percent: 100 });
  } finally {
    import_node_fs2.default.rmSync(tmp, { recursive: true, force: true });
  }
}
function makeTemp() {
  try {
    return import_node_fs2.default.mkdtempSync(import_node_path2.default.join(import_node_os.default.tmpdir(), "am-hyperframes-"));
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u521B\u5EFA\u4E34\u65F6\u76EE\u5F55\uFF1A${errorText(err)}`, { cause: err });
  }
}
var cacheMarker = ".am-commit";
function cachedTree(cacheRoot, commit, expectSkills) {
  if (!cacheRoot || commit === "" || commit === "-") return "";
  const dir = import_node_path2.default.join(cacheRoot, commit);
  let body;
  try {
    body = import_node_fs2.default.readFileSync(import_node_path2.default.join(dir, cacheMarker), "utf8");
  } catch {
    return "";
  }
  if (body.trim() !== commit) return "";
  let count = 0;
  for (const sub of skillsSubdirsInRepo) {
    let entries;
    try {
      entries = import_node_fs2.default.readdirSync(import_node_path2.default.join(dir, sub));
    } catch {
      continue;
    }
    for (const name of entries) if (exists(import_node_path2.default.join(dir, sub, name, manifestFile))) count++;
  }
  return count === expectSkills ? dir : "";
}
function storeCache(cacheRoot, commit, clone) {
  if (!cacheRoot || commit === "") return;
  import_node_fs2.default.mkdirSync(cacheRoot, { recursive: true });
  const staging = import_node_fs2.default.mkdtempSync(import_node_path2.default.join(cacheRoot, ".staging-"));
  try {
    for (const sub of skillsSubdirsInRepo) {
      const source = import_node_path2.default.join(clone, sub);
      if (!exists(source)) continue;
      copyTree(source, import_node_path2.default.join(staging, sub));
    }
    import_node_fs2.default.writeFileSync(import_node_path2.default.join(staging, cacheMarker), commit + "\n", { mode: 420 });
    const target = import_node_path2.default.join(cacheRoot, commit);
    import_node_fs2.default.rmSync(target, { recursive: true, force: true });
    try {
      import_node_fs2.default.renameSync(staging, target);
    } catch (err) {
      if (exists(import_node_path2.default.join(target, cacheMarker))) return;
      throw err;
    }
  } finally {
    import_node_fs2.default.rmSync(staging, { recursive: true, force: true });
  }
}
async function cloneSkills(git, dir, opts, report, signal) {
  const env = cloneEnv(opts.env);
  const run = async (stderr, args) => (await runCommand(git, args, { cwd: dir, env, stderr, signal })).trim();
  const tag = "v" + opts.version;
  let verbosity = "--quiet";
  let cloneErr = opts.output;
  if (opts.progress) {
    verbosity = "--progress";
    cloneErr = new GitProgress(report, opts.output);
  }
  try {
    await run(cloneErr, [
      "-c",
      "advice.detachedHead=false",
      "clone",
      verbosity,
      "--depth",
      "1",
      "--filter=blob:none",
      "--sparse",
      "--branch",
      tag,
      opts.repoURL,
      "."
    ]);
  } catch (err) {
    throw new Error(`\u514B\u9686 ${opts.repoURL} \u7684 ${tag} \u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
  report({ stage: "\u4E0B\u8F7D\u6280\u80FD\u6587\u4EF6", percent: checkoutStart, indeterminate: true });
  try {
    await run(opts.output, ["sparse-checkout", "set", ...skillsSubdirsInRepo]);
  } catch (err) {
    throw new Error(`\u68C0\u51FA\u6280\u80FD\u76EE\u5F55\u5931\u8D25\uFF1A${errorText(err)}`, { cause: err });
  }
  let commit;
  try {
    commit = await run(opts.output, ["rev-parse", "HEAD"]);
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u89E3\u6790 ${tag} \u6307\u5411\u7684 commit\uFF1A${errorText(err)}`, { cause: err });
  }
  if (opts.expectCommit !== "-" && commit !== opts.expectCommit) {
    throw new Error(`${tag} \u6307\u5411 ${commit}\uFF0C\u4E0E\u56FA\u5B9A\u7684 ${opts.expectCommit} \u4E0D\u7B26\uFF1Atag \u88AB\u79FB\u52A8\u8FC7\uFF0C\u62D2\u7EDD\u5B89\u88C5`);
  }
  return commit;
}
function cloneEnv(env) {
  return {
    ...env,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0"
  };
}
function readDirSorted(dir) {
  return import_node_fs2.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function copyTree(source, dest) {
  const walk = (relative) => {
    const from = relative === "" ? source : import_node_path2.default.join(source, relative);
    const target = relative === "" ? dest : import_node_path2.default.join(dest, relative);
    import_node_fs2.default.mkdirSync(target, { recursive: true, mode: 493 });
    for (const entry of readDirSorted(from)) {
      const rel = relative === "" ? entry.name : import_node_path2.default.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.isSymbolicLink()) {
        throw new Error(`\u5B89\u88C5\u4EA7\u7269\u542B\u7B26\u53F7\u94FE\u63A5\uFF0C\u65E0\u6CD5\u5B89\u5168\u642C\u8FDB\u9879\u76EE\uFF1A${rel}`);
      } else if (entry.isFile()) {
        const file = import_node_path2.default.join(source, rel);
        const mode = import_node_fs2.default.statSync(file).mode & 511;
        const body = import_node_fs2.default.readFileSync(file);
        import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(import_node_path2.default.join(dest, rel)), { recursive: true, mode: 493 });
        import_node_fs2.default.writeFileSync(import_node_path2.default.join(dest, rel), body, { mode });
      }
    }
  };
  walk("");
}

// ../engine/src/hyperframes/cli.ts
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);
var import_promises = require("node:timers/promises");
var CLIDirEnv = "AM_HYPERFRAMES_CLI_DIR";
var cliMarker = ".am-cli";
function cliDir(env, version) {
  const dir = env[CLIDirEnv];
  if (dir) return dir;
  const root = defaultCacheDir(env);
  if (root === "") return "";
  return import_node_path3.default.join(root, "cli-" + version);
}
function cliBinary(dir) {
  return import_node_path3.default.join(dir, "node_modules", ".bin", "hyperframes");
}
function cliReady(dir, version) {
  if (dir === "") return false;
  try {
    if (import_node_fs3.default.readFileSync(import_node_path3.default.join(dir, cliMarker), "utf8").trim() !== version) return false;
    return !import_node_fs3.default.statSync(cliBinary(dir)).isDirectory();
  } catch {
    return false;
  }
}
function requireCLI(env) {
  const dir = cliDir(env, PinnedVersion);
  if (cliReady(dir, PinnedVersion)) return dir;
  if (dir === "") throw missing("HyperFrames CLI " + PinnedVersion, "\u73AF\u5883\u91CC\u6CA1\u6709 HOME\uFF0C\u4E5F\u6CA1\u6709 " + CLIDirEnv);
  throw missing("HyperFrames CLI " + PinnedVersion, "\u6CA1\u6709\u88C5\u5728 " + dir);
}
var cliAttempts = 3;
async function ensureCLI(opts, signal) {
  const version = opts.version || PinnedVersion;
  const env = opts.env ?? {};
  const dir = cliDir(env, version);
  if (dir === "") throw new Error(`\u65E0\u6CD5\u786E\u5B9A HyperFrames CLI \u7684\u5B89\u88C5\u76EE\u5F55\uFF1A\u73AF\u5883\u91CC\u6CA1\u6709 HOME\uFF0C\u53EF\u7528 ${CLIDirEnv} \u6307\u5B9A`);
  if (cliReady(dir, version)) return dir;
  const report = opts.progress ?? (() => {
  });
  let npm;
  try {
    npm = lookPath("npm", env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 npm\uFF08\u9700\u8981 Node 20+\uFF09\uFF0C\u65E0\u6CD5\u5B89\u88C5 HyperFrames CLI\uFF1A${errorText(err)}`, { cause: err });
  }
  import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(dir), { recursive: true });
  const unlock = await lockFile(dir + ".lock", signal);
  try {
    if (cliReady(dir, version)) return dir;
    const pkg = opts.package || "hyperframes@" + version;
    let lastErr;
    for (let attempt = 1; attempt <= cliAttempts; attempt++) {
      let stage = "\u5B89\u88C5 HyperFrames CLI " + version;
      if (attempt > 1) stage = `\u5B89\u88C5 HyperFrames CLI ${version}\uFF08\u91CD\u8BD5 ${attempt}/${cliAttempts}\uFF09`;
      report({ stage, percent: 0, indeterminate: true });
      try {
        await installCLI(npm, dir, pkg, version, env, opts.output, signal);
        report({ stage: "HyperFrames CLI \u5DF2\u5C31\u7EEA", percent: 100 });
        return dir;
      } catch (err) {
        lastErr = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < cliAttempts) {
        opts.output.write(`\u5B89\u88C5 HyperFrames CLI \u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${cliAttempts}\uFF09\uFF1A${errorText(lastErr)}
`);
      }
    }
    throw new Error(`\u5B89\u88C5 HyperFrames CLI ${version} \u5931\u8D25\uFF08npm \u7528\u7684\u662F\u4F60\u7684 ~/.npmrc\uFF1B\u7F51\u7EDC\u597D\u8F6C\u540E\u91CD\u65B0\u8FD0\u884C\u5373\u53EF\uFF09\uFF1A${errorText(lastErr)}`, {
      cause: lastErr
    });
  } finally {
    unlock();
  }
}
async function installCLI(npm, dir, pkg, version, env, output, signal) {
  const staging = import_node_fs3.default.mkdtempSync(import_node_path3.default.join(import_node_path3.default.dirname(dir), ".cli-"));
  try {
    import_node_fs3.default.writeFileSync(import_node_path3.default.join(staging, "package.json"), '{"private":true}\n', { mode: 420 });
    const sink = output ?? { write: () => true };
    try {
      await runCommand(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", "--save-exact", pkg], {
        cwd: staging,
        env,
        stdout: sink,
        stderr: sink,
        signal
      });
    } catch (err) {
      throw new Error(`npm install ${pkg}\uFF1A${errorText(err)}`, { cause: err });
    }
    const binary = cliBinary(staging);
    if (!import_node_fs3.default.existsSync(binary)) throw new Error(`npm \u88C5\u5B8C\u4E86\u4F46\u6CA1\u6709 ${import_node_path3.default.basename(binary)}\uFF1A\u5305\u7ED3\u6784\u5DF2\u53D8`);
    let out;
    try {
      out = await runCommand(binary, ["--version"], { cwd: staging, env, signal });
    } catch (err) {
      throw new Error(`\u88C5\u597D\u7684 HyperFrames CLI \u8DD1\u4E0D\u8D77\u6765\uFF1A${errorText(err)}`, { cause: err });
    }
    const got = out.trim();
    if (!got.includes(version)) throw new Error(`\u88C5\u597D\u7684 HyperFrames CLI \u62A5\u544A\u7248\u672C ${goQuote2(got)}\uFF0C\u671F\u671B ${version}`);
    import_node_fs3.default.writeFileSync(import_node_path3.default.join(staging, cliMarker), version + "\n", { mode: 420 });
    import_node_fs3.default.rmSync(dir, { recursive: true, force: true });
    import_node_fs3.default.renameSync(staging, dir);
  } finally {
    import_node_fs3.default.rmSync(staging, { recursive: true, force: true });
  }
}
function cliCommandFor(dir, env, args) {
  return { file: cliBinary(dir), args: [...args], env: { ...env } };
}
var lockStale = 30 * 60 * 1e3;
async function lockFile(file, signal) {
  for (; ; ) {
    try {
      const fd = import_node_fs3.default.openSync(file, "wx", 420);
      import_node_fs3.default.writeSync(fd, `${process.pid}
`);
      import_node_fs3.default.closeSync(fd);
      return () => import_node_fs3.default.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new Error(`\u521B\u5EFA\u9501 ${file}\uFF1A${errorText(err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - import_node_fs3.default.statSync(file).mtimeMs > lockStale) {
        import_node_fs3.default.rmSync(file, { force: true });
        continue;
      }
    } catch {
    }
    if (signal?.aborted) throw abortReason(signal);
    try {
      await (0, import_promises.setTimeout)(500, void 0, { signal });
    } catch {
      throw abortReason(signal);
    }
  }
}

// src/cobra.ts
var ExitError2 = class extends Error {
  constructor(code, message = "") {
    super(message + "\uFF08\u9000\u51FA\u7801 " + code + "\uFF09");
    this.code = code;
    this.bare = message;
  }
  code;
  /** 不带退出码后缀的原始消息。 */
  bare;
};
var ref = (value) => ({ value });
var FlagError = class extends Error {
};
var Microsecond = 1e3;
var Millisecond = 1e6;
var Second = 1e9;
var Minute = 60 * Second;
var Hour = 60 * Minute;
var unitMap = { ns: 1, us: 1e3, \u00B5s: 1e3, \u03BCs: 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 36e11 };
function parseDuration(s) {
  const orig = s;
  let d = 0;
  let neg = false;
  if (s && (s[0] === "-" || s[0] === "+")) {
    neg = s[0] === "-";
    s = s.slice(1);
  }
  if (s === "0") return 0;
  if (s === "") throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
  while (s !== "") {
    const m = /^(\d*)(?:\.(\d*))?/.exec(s);
    if (!m[1] && !m[2]) throw new Error(`time: invalid duration ${JSON.stringify(orig)}`);
    s = s.slice(m[0].length);
    const u = /^[^\d.]+/.exec(s)?.[0] ?? "";
    if (!u) throw new Error(`time: missing unit in duration ${JSON.stringify(orig)}`);
    const unit = unitMap[u];
    if (unit === void 0) throw new Error(`time: unknown unit ${JSON.stringify(u)} in duration ${JSON.stringify(orig)}`);
    s = s.slice(u.length);
    d += Number(m[1] || "0") * unit + (m[2] ? Number("0." + m[2]) * unit : 0);
  }
  return Math.round(neg ? -d : d);
}
function formatDuration(d) {
  if (d === 0) return "0s";
  const neg = d < 0;
  let u = Math.abs(d);
  let out;
  if (u < Second) {
    const [unit, size] = u < Microsecond ? ["ns", 1] : u < Millisecond ? ["\xB5s", Microsecond] : ["ms", Millisecond];
    out = trimFloat(u / size) + unit;
  } else {
    const h = Math.floor(u / Hour);
    u -= h * Hour;
    const m = Math.floor(u / Minute);
    u -= m * Minute;
    const sec = trimFloat(u / Second) + "s";
    out = h > 0 ? `${h}h${m}m${sec}` : m > 0 ? `${m}m${sec}` : sec;
  }
  return neg ? "-" + out : out;
}
function trimFloat(n) {
  return String(Number(n.toFixed(9)));
}
function goQuote3(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "	") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}
function parseGoInt(raw) {
  const s = raw.replace(/_/g, "");
  const m = /^([+-])?(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|[0-9]+)$/.exec(s);
  if (!m) throw new Error(`strconv.ParseInt: parsing ${goQuote3(raw)}: invalid syntax`);
  let body = m[2];
  let value;
  if (/^0[xX]/.test(body)) value = parseInt(body.slice(2), 16);
  else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
  else if (/^0[oO]/.test(body)) value = parseInt(body.slice(2), 8);
  else if (body.length > 1 && body.startsWith("0")) value = parseInt(body.slice(1), 8);
  else value = parseInt(body = body, 10);
  return m[1] === "-" ? -value : value;
}
function parseGoBool(raw) {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(raw)) return true;
  if (["0", "f", "F", "FALSE", "false", "False"].includes(raw)) return false;
  throw new Error(`strconv.ParseBool: parsing ${goQuote3(raw)}: invalid syntax`);
}
function readCSV(value) {
  if (value === "") return [];
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === '"' && value[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}
var FlagSet = class {
  formal = /* @__PURE__ */ new Map();
  shorthands = /* @__PURE__ */ new Map();
  add(flag) {
    if (this.formal.has(flag.name)) throw new Error(`flag redefined: ${flag.name}`);
    const full = { changed: false, noOptDefVal: "", hidden: false, ...flag };
    this.formal.set(flag.name, full);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, full);
  }
  addFlag(flag) {
    if (this.formal.has(flag.name)) return;
    this.formal.set(flag.name, flag);
    if (flag.shorthand) this.shorthands.set(flag.shorthand, flag);
  }
  stringVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "string", defValue: def, set: (v) => target.value = v });
  }
  boolVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "bool", defValue: String(def), set: (v) => target.value = parseGoBool(v), noOptDefVal: "true" });
  }
  intVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "int", defValue: String(def), set: (v) => target.value = parseGoInt(v) });
  }
  durationVar(target, name, def, usage, shorthand = "") {
    target.value = def;
    this.add({ name, shorthand, usage, type: "duration", defValue: formatDuration(def), set: (v) => target.value = parseDuration(v) });
  }
  /** StringArrayVar：每次出现追加一项，不按逗号拆。第一次出现时先清掉默认值。 */
  stringArrayVar(target, name, def, usage, shorthand = "") {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: "stringArray",
      defValue: "[" + def.join(",") + "]",
      set: (v) => {
        target.value = fresh ? [v] : [...target.value, v];
        fresh = false;
      }
    });
  }
  /** StringSliceVar：每次出现按 CSV 拆开追加。第一次出现时先清掉默认值。 */
  stringSliceVar(target, name, def, usage, shorthand = "") {
    target.value = [...def];
    let fresh = true;
    this.add({
      name,
      shorthand,
      usage,
      type: "stringSlice",
      defValue: "[" + def.join(",") + "]",
      set: (v) => {
        const parts = readCSV(v);
        target.value = fresh ? parts : [...target.value, ...parts];
        fresh = false;
      }
    });
  }
  lookup(name) {
    return this.formal.get(name);
  }
  changed(name) {
    return this.formal.get(name)?.changed ?? false;
  }
  shorthandLookup(short) {
    return this.shorthands.get(short);
  }
  sorted() {
    return [...this.formal.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }
  hasAvailable() {
    return [...this.formal.values()].some((f) => !f.hidden);
  }
  /** pflag FlagSet.FlagUsages（不折行）。 */
  usages() {
    const lines = [];
    let maxlen = 0;
    for (const flag of this.sorted()) {
      if (flag.hidden) continue;
      let line = flag.shorthand ? `  -${flag.shorthand}, --${flag.name}` : `      --${flag.name}`;
      const [varname, usage] = unquoteUsage(flag);
      if (varname) line += " " + varname;
      if (flag.noOptDefVal && !(flag.type === "bool" && flag.noOptDefVal === "true")) {
        line += flag.type === "string" ? `[="${flag.noOptDefVal}"]` : `[=${flag.noOptDefVal}]`;
      }
      line += "\0";
      if (Buffer.byteLength(line) > maxlen) maxlen = Buffer.byteLength(line);
      line += usage;
      if (!defaultIsZero(flag)) line += flag.type === "string" ? ` (default ${goQuote3(flag.defValue)})` : ` (default ${flag.defValue})`;
      lines.push(line);
    }
    let out = "";
    for (const line of lines) {
      const sidx = line.indexOf("\0");
      const left = line.slice(0, sidx);
      const spacing = " ".repeat(maxlen - Buffer.byteLength(line.slice(0, sidx)));
      const rest = line.slice(sidx + 1).replace(/\n/g, "\n" + " ".repeat(maxlen + 2));
      out += `${left} ${spacing} ${rest}
`;
    }
    return out;
  }
};
function unquoteUsage(flag) {
  const usage = flag.usage;
  const i = usage.indexOf("`");
  if (i >= 0) {
    const j = usage.indexOf("`", i + 1);
    if (j >= 0) {
      const name = usage.slice(i + 1, j);
      return [name, usage.slice(0, i) + name + usage.slice(j + 1)];
    }
  }
  const names = { string: "string", bool: "", int: "int", stringArray: "stringArray", stringSlice: "strings", duration: "duration" };
  return [names[flag.type], usage];
}
function defaultIsZero(flag) {
  switch (flag.type) {
    case "bool":
      return flag.defValue === "false" || flag.defValue === "";
    case "duration":
      return flag.defValue === "0" || flag.defValue === "0s";
    case "int":
      return flag.defValue === "0";
    case "string":
      return flag.defValue === "";
    case "stringArray":
    case "stringSlice":
      return flag.defValue === "[]";
  }
}
var minNamePadding = 11;
var Command = class _Command {
  use;
  short;
  long;
  example;
  aliases;
  version;
  hidden;
  disableFlagParsing;
  args;
  runE;
  parent;
  children = [];
  local = new FlagSet();
  persistent = new FlagSet();
  out;
  err;
  signal;
  constructor(options) {
    this.use = options.use;
    this.short = options.short ?? "";
    this.long = options.long ?? "";
    this.example = options.example ?? "";
    this.aliases = options.aliases ?? [];
    this.version = options.version ?? "";
    this.hidden = options.hidden ?? false;
    this.disableFlagParsing = options.disableFlagParsing ?? false;
    this.args = options.args;
    this.runE = options.runE;
  }
  name() {
    return this.use.split(" ")[0];
  }
  addCommand(...cmds) {
    for (const cmd of cmds) {
      cmd.parent = this;
      this.children.push(cmd);
    }
  }
  /** 子命令，按名字排序（cobra 默认 EnableCommandSorting）。 */
  commands() {
    return [...this.children].sort((a, b) => a.name() < b.name() ? -1 : a.name() > b.name() ? 1 : 0);
  }
  flags() {
    return this.local;
  }
  persistentFlags() {
    return this.persistent;
  }
  runnable() {
    return this.runE !== void 0;
  }
  hasParent() {
    return this.parent !== void 0;
  }
  root() {
    return this.parent ? this.parent.root() : this;
  }
  commandPath() {
    return this.parent ? `${this.parent.commandPath()} ${this.name()}` : this.name();
  }
  isAvailableCommand() {
    return !this.hidden && (this.runnable() || this.children.some((c) => c.isAvailableCommand()));
  }
  hasAvailableSubCommands() {
    return this.children.some((c) => c.isAvailableCommand());
  }
  /** 持久参数：自己与祖先声明的 PersistentFlags。 */
  inheritedFlags() {
    const set = new FlagSet();
    for (let p = this.parent; p; p = p.parent) for (const f of p.persistent.formal.values()) set.addFlag(f);
    return set;
  }
  /** LocalFlags：本命令的 Flags 加上自己声明的持久参数。 */
  localFlags() {
    const set = new FlagSet();
    for (const f of this.local.formal.values()) set.addFlag(f);
    for (const f of this.persistent.formal.values()) set.addFlag(f);
    return set;
  }
  allFlags() {
    const set = this.localFlags();
    for (const f of this.inheritedFlags().formal.values()) set.addFlag(f);
    return set;
  }
  initDefaultFlags() {
    if (!this.local.lookup("help")) {
      const helpTarget = ref(false);
      this.local.boolVar(helpTarget, "help", false, `help for ${this.name() || "this command"}`, "h");
    }
    if (this.version && !this.local.lookup("version")) {
      const versionTarget = ref(false);
      this.local.boolVar(versionTarget, "version", false, `version for ${this.name() || "this command"}`, this.local.shorthandLookup("v") ? "" : "v");
    }
  }
  useLine() {
    const useline = this.parent ? `${this.parent.commandPath()} ${this.use}` : this.use;
    this.initDefaultFlags();
    return this.allFlags().hasAvailable() && !useline.includes("[flags]") ? useline + " [flags]" : useline;
  }
  namePadding() {
    if (!this.parent) return minNamePadding;
    const max = Math.max(0, ...this.parent.children.map((c) => c.name().length));
    return Math.max(minNamePadding, max);
  }
  /** cobra defaultUsageFunc。 */
  usageString() {
    this.initDefaultFlags();
    let w = "Usage:";
    if (this.runnable()) w += `
  ${this.useLine()}`;
    if (this.hasAvailableSubCommands()) w += `
  ${this.commandPath()} [command]`;
    if (this.aliases.length > 0) w += `

Aliases:
  ${[this.name(), ...this.aliases].join(", ")}`;
    if (this.example) w += `

Examples:
${this.example}`;
    if (this.hasAvailableSubCommands()) {
      w += "\n\nAvailable Commands:";
      for (const sub of this.commands()) {
        if (sub.isAvailableCommand() || sub.name() === "help") w += `
  ${sub.name().padEnd(sub.namePadding())} ${sub.short}`;
      }
    }
    const local = this.localFlags();
    if (local.hasAvailable()) w += "\n\nFlags:\n" + local.usages().trimEnd();
    const inherited = this.inheritedFlags();
    if (inherited.hasAvailable()) w += "\n\nGlobal Flags:\n" + inherited.usages().trimEnd();
    if (this.hasAvailableSubCommands()) w += `

Use "${this.commandPath()} [command] --help" for more information about a command.`;
    return w + "\n";
  }
  /** cobra defaultHelpFunc。 */
  helpString() {
    const text = (this.long || this.short).trimEnd();
    let out = text ? text + "\n\n" : "";
    if (this.runnable() || this.children.length > 0) out += this.usageString();
    return out;
  }
  // -------------------------------------------------------------- io
  setOut(out) {
    this.out = out;
  }
  setErr(err) {
    this.err = err;
  }
  outOrStdout() {
    return this.out ?? this.parent?.outOrStdout() ?? { write: (t) => process.stdout.write(t) };
  }
  errOrStderr() {
    return this.err ?? this.parent?.errOrStderr() ?? { write: (t) => process.stderr.write(t) };
  }
  setContext(signal) {
    this.signal = signal;
  }
  /** 对应 cmd.Context()：取消信号。 */
  context() {
    return this.signal ?? this.parent?.context() ?? new AbortController().signal;
  }
  // -------------------------------------------------------------- execution
  findNext(name) {
    return this.children.find((c) => c.name() === name || c.aliases.includes(name));
  }
  /** cobra Find：沿参数里的非参数词找到子命令；flag 与其取值跳过。 */
  find(args) {
    let cmd = this;
    let rest = [...args];
    for (; ; ) {
      const next = firstNonFlag(rest, cmd.allFlags());
      if (next === void 0) break;
      const child = cmd.findNext(next);
      if (!child) break;
      const index = rest.indexOf(next);
      rest = [...rest.slice(0, index), ...rest.slice(index + 1)];
      cmd = child;
    }
    return [cmd, rest];
  }
  suggestionsFor(typed) {
    const suggestions = [];
    for (const cmd of this.commands()) {
      if (!cmd.isAvailableCommand()) continue;
      const near = levenshtein(typed.toLowerCase(), cmd.name().toLowerCase()) <= 2;
      if (near || cmd.name().toLowerCase().startsWith(typed.toLowerCase())) suggestions.push(cmd.name());
    }
    return suggestions.length ? "\n\nDid you mean this?\n" + suggestions.map((s) => `	${s}
`).join("") : "";
  }
  /** pflag 的 Parse（interspersed）：返回非 flag 参数。 */
  parseFlags(args) {
    const flags = this.allFlags();
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (arg.startsWith("--") && arg.length > 2) {
        const body = arg.slice(2);
        if (body.startsWith("-") || body.startsWith("=")) throw new FlagError(`bad flag syntax: ${arg}`);
        const eq = body.indexOf("=");
        const name = eq >= 0 ? body.slice(0, eq) : body;
        const flag = flags.lookup(name);
        if (!flag) throw new FlagError(`unknown flag: --${name}`);
        let value;
        if (eq >= 0) value = body.slice(eq + 1);
        else if (flag.noOptDefVal) value = flag.noOptDefVal;
        else if (i + 1 < args.length) value = args[++i];
        else throw new FlagError(`flag needs an argument: --${name}`);
        setFlag(flag, value, `--${name}`);
      } else if (arg.startsWith("-") && arg.length > 1) {
        const shorts = arg.slice(1);
        for (let j = 0; j < shorts.length; j++) {
          const c = shorts[j];
          const flag = flags.shorthandLookup(c);
          if (!flag) throw new FlagError(`unknown shorthand flag: ${goQuote3(c)} in -${shorts}`);
          let value;
          if (shorts[j + 1] === "=") {
            value = shorts.slice(j + 2);
            j = shorts.length;
          } else if (flag.noOptDefVal) value = flag.noOptDefVal;
          else if (j + 1 < shorts.length) {
            value = shorts.slice(j + 1);
            j = shorts.length;
          } else if (i + 1 < args.length) value = args[++i];
          else throw new FlagError(`flag needs an argument: ${goQuote3(c)} in -${shorts}`);
          setFlag(flag, value, `-${flag.shorthand}, --${flag.name}`);
        }
      } else positional.push(arg);
    }
    return positional;
  }
  /** 解析并执行。错误照 cobra 抛出，由调用方（cli.execute）决定打印与退出码。 */
  async execute(argv) {
    this.addHelpCommand();
    let [cmd, rest] = this.find(argv);
    if (cmd.name() === "help" && cmd.parent === this) {
      const [target] = this.find(rest.filter((a) => !a.startsWith("-")));
      cmd.outOrStdout().write(target.helpString());
      return;
    }
    cmd.initDefaultFlags();
    if (cmd.disableFlagParsing && cmd.runnable()) {
      await cmd.runE(cmd, rest);
      return;
    }
    const positional = cmd.parseFlags(rest);
    if (cmd.local.lookup("help")?.changed && helpRequested(cmd)) {
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.version && cmd.local.lookup("version")?.changed) {
      cmd.outOrStdout().write(`${cmd.name()} version ${cmd.version}
`);
      return;
    }
    if (!cmd.runnable()) {
      if (!cmd.parent && positional.length > 0 && cmd.children.length > 0) {
        throw new Error(`unknown command ${goQuote3(positional[0])} for ${goQuote3(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
      }
      cmd.outOrStdout().write(cmd.helpString());
      return;
    }
    if (cmd.args) cmd.args(cmd, positional);
    else if (!cmd.parent && cmd.children.length > 0 && positional.length > 0) {
      throw new Error(`unknown command ${goQuote3(positional[0])} for ${goQuote3(cmd.commandPath())}${cmd.suggestionsFor(positional[0])}`);
    }
    await cmd.runE(cmd, positional);
  }
  addHelpCommand() {
    if (this.children.length === 0 || this.children.some((c) => c.name() === "help")) return;
    this.addCommand(
      new _Command({
        use: "help [command]",
        short: "Help about any command",
        long: `Help provides help for any command in the application.
Simply type ${this.name()} help [path to command] for full details.`,
        runE: () => {
        }
      })
    );
  }
};
function helpRequested(cmd) {
  const flag = cmd.flags().lookup("help");
  return flag !== void 0;
}
function setFlag(flag, value, display) {
  try {
    flag.set(value);
    flag.changed = true;
  } catch (err) {
    throw new FlagError(`invalid argument ${goQuote3(value)} for ${goQuote3(display)} flag: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function firstNonFlag(args, flags) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return void 0;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0];
      const flag = flags.lookup(name);
      if (!arg.includes("=") && flag && !flag.noOptDefVal) i++;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const last = arg[arg.length - 1];
      const flag = flags.shorthandLookup(last);
      if (arg.length === 2 && flag && !flag.noOptDefVal) i++;
      continue;
    }
    return arg;
  }
  return void 0;
}
function levenshtein(s, t) {
  const d = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j++) d[0][j] = j;
  for (let j = 1; j <= t.length; j++) {
    for (let i = 1; i <= s.length; i++) {
      d[i][j] = s[i - 1] === t[j - 1] ? d[i - 1][j - 1] : Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]) + 1;
    }
  }
  return d[s.length][t.length];
}

// src/filmstyle.ts
var import_node_fs11 = __toESM(require("node:fs"), 1);
var import_node_path11 = __toESM(require("node:path"), 1);

// ../engine/src/filmstyle/filmstyle.ts
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
function styleKey(style2) {
  return style2.source + "/" + style2.slug;
}
function styleLabel(style2) {
  return `${style2.cn} ${style2.en}\uFF08${styleKey(style2)}\uFF09`;
}
var registry = [];
function register(source) {
  for (const existing of registry) {
    if (existing.id() === source.id()) throw new Error("filmstyle: \u98CE\u683C\u6765\u6E90\u91CD\u590D\u767B\u8BB0\uFF1A" + source.id());
  }
  registry.push(source);
  registry.sort((a, b) => compareBytes(a.id(), b.id()));
}
function sources() {
  return [...registry];
}
function sourceByID(id) {
  return registry.find((source) => source.id() === id);
}
function catalog() {
  const out = [];
  for (const source of registry) out.push(...source.catalog());
  return out;
}
function categories(sourceID) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const style2 of catalog()) {
    if (style2.source === sourceID && !seen.has(style2.category_cn)) {
      seen.add(style2.category_cn);
      out.push(style2.category_cn);
    }
  }
  return out;
}
function find(name) {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === "") return { ok: false, ambiguous: [] };
  const matches = [];
  for (const candidate of catalog()) {
    if (styleKey(candidate).toLowerCase() === key) return { style: candidate, ok: true, ambiguous: [] };
    if (candidate.slug.toLowerCase() === key || candidate.en.toLowerCase() === key || candidate.cn === trimmed) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return { ok: false, ambiguous: [] };
  if (matches.length === 1) return { style: matches[0], ok: true, ambiguous: [] };
  return { ok: false, ambiguous: matches };
}
function suggest(name) {
  const trimmed = goTrimSpace(name);
  const key = trimmed.toLowerCase();
  if (key === "") return [];
  const out = [];
  for (const style2 of catalog()) {
    if (styleKey(style2).toLowerCase().includes(key) || style2.en.toLowerCase().includes(key) || style2.cn.includes(trimmed)) {
      out.push(style2);
    }
  }
  return out.slice(0, 5);
}
function lookup(name) {
  const { style: style2, ok, ambiguous } = find(name);
  if (ok && style2) return style2;
  const labels = (list) => list.map(styleLabel).join("\u3001");
  if (ambiguous.length > 0) {
    throw new Error(`${goQuote(name)} \u5728\u591A\u4E2A\u98CE\u683C\u6765\u6E90\u91CC\u90FD\u6709\uFF1A${labels(ambiguous)}\u3002\u5199\u6210\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D`);
  }
  let message = `\u98CE\u683C\u76EE\u5F55\u91CC\u6CA1\u6709 ${goQuote(name)}`;
  const candidates = suggest(name);
  if (candidates.length > 0) message += "\uFF0C\u76F8\u8FD1\u7684\u6709\uFF1A" + labels(candidates);
  throw new Error(`${message}\u3002\u7528 am film-style list \u67E5\u770B\u5168\u90E8\u98CE\u683C`);
}
var RootEnv = "AM_FILM_STYLES_DIR";
function rootDir(env) {
  const dir = env[RootEnv];
  if (dir) return dir;
  let base = env.XDG_DATA_HOME ?? "";
  if (base === "") {
    let home = env.HOME ?? "";
    if (home === "") home = import_node_os2.default.homedir();
    base = import_node_path4.default.join(home, ".local", "share");
  }
  return import_node_path4.default.join(base, "am", "film-styles");
}
function sourceDir(env, sourceID) {
  return import_node_path4.default.join(rootDir(env), sourceID);
}

// ../engine/src/filmstyle/install.ts
var import_node_crypto2 = __toESM(require("node:crypto"), 1);
var import_node_fs5 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);

// ../engine/src/fsutil/index.ts
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_path5 = __toESM(require("node:path"), 1);
function atomicWrite(file, data, mode = 420) {
  const dir = import_node_path5.default.dirname(file);
  import_node_fs4.default.mkdirSync(dir, { recursive: true });
  const tmp = import_node_path5.default.join(dir, `.am-tmp-${import_node_crypto.default.randomBytes(6).toString("hex")}`);
  try {
    import_node_fs4.default.writeFileSync(tmp, data, { mode });
    import_node_fs4.default.chmodSync(tmp, mode);
    import_node_fs4.default.renameSync(tmp, file);
  } catch (err) {
    try {
      import_node_fs4.default.rmSync(tmp, { force: true });
    } catch {
    }
    throw new Error(`\u5199\u5165 ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// ../engine/src/filmstyle/install.ts
var SkillsSubdir2 = ".agents/skills";
var SkillName = "am-film-style";
var ManifestFile = "am-film-style.json";
var StyleFile = "STYLE.md";
var GuideFile = "SKILL.md";
var LegacySkillName = "lemo-film-style";
var legacyManifest = "lemo-upstream.json";
var legacySource = "lemo-opuscar";
function manifestKey(manifest) {
  return manifest.source + "/" + manifest.slug;
}
function skillDir(projectDir) {
  return import_node_path6.default.join(projectDir, SkillsSubdir2, SkillName);
}
function legacyDir(projectDir) {
  return import_node_path6.default.join(projectDir, SkillsSubdir2, LegacySkillName);
}
function exists2(file) {
  try {
    import_node_fs5.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function installedDir(projectDir) {
  if (exists2(import_node_path6.default.join(skillDir(projectDir), ManifestFile))) return skillDir(projectDir);
  if (exists2(import_node_path6.default.join(legacyDir(projectDir), legacyManifest))) return legacyDir(projectDir);
  return "";
}
function readOptional(file) {
  try {
    return import_node_fs5.default.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return void 0;
    throw new Error(goPathError("open", file, err), { cause: err });
  }
}
function stringField(object, name) {
  let value;
  if (Object.hasOwn(object, name)) value = object[name];
  else {
    const lower = name.toLowerCase();
    const key = Object.keys(object).find((k) => k.toLowerCase() === lower);
    value = key === void 0 ? void 0 : object[key];
  }
  if (value === void 0 || value === null) return "";
  if (typeof value !== "string") throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go struct field .${name} of type string`);
  return value;
}
function jsonKind(value) {
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}
function decodeObject(body) {
  const value = JSON.parse(body);
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`json: cannot unmarshal ${jsonKind(value)} into Go value of type struct`);
  }
  return value;
}
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
function installed(projectDir) {
  const empty = { source: "", slug: "", cn: "", en: "", version: "", digest: "", installed_at: "", legacy: false };
  let body = readOptional(import_node_path6.default.join(skillDir(projectDir), ManifestFile));
  if (body !== void 0) {
    try {
      const raw = decodeObject(body);
      return {
        manifest: {
          source: stringField(raw, "source"),
          slug: stringField(raw, "slug"),
          cn: stringField(raw, "cn"),
          en: stringField(raw, "en"),
          version: stringField(raw, "version"),
          digest: stringField(raw, "digest"),
          installed_at: stringField(raw, "installed_at"),
          legacy: false
        },
        ok: true
      };
    } catch (err) {
      throw new Error(`${ManifestFile} \u635F\u574F\uFF1A${errorText2(err)}`, { cause: err });
    }
  }
  body = readOptional(import_node_path6.default.join(legacyDir(projectDir), legacyManifest));
  if (body === void 0) return { manifest: empty, ok: false };
  try {
    const raw = decodeObject(body);
    return {
      manifest: {
        source: legacySource,
        slug: stringField(raw, "Slug"),
        cn: stringField(raw, "CN"),
        en: stringField(raw, "EN"),
        version: stringField(raw, "Commit"),
        digest: stringField(raw, "Digest"),
        installed_at: stringField(raw, "installed_at"),
        legacy: true
      },
      ok: true
    };
  } catch (err) {
    throw new Error(`${legacyManifest} \u635F\u574F\uFF1A${errorText2(err)}`, { cause: err });
  }
}
function rfc3339(now) {
  return now.toISOString().replace(/\.\d+Z$/, "Z");
}
function linkError(op, from, to, err) {
  return goPathError(op, `${from} ${to}`, err);
}
function install(opts) {
  const style2 = opts.style;
  const source = sourceByID(style2.source);
  if (!source) throw new Error(`\u6CA1\u6709\u98CE\u683C\u6765\u6E90 ${goQuote(style2.source)}`);
  const { manifest: previous, ok: had } = installed(opts.projectDir);
  if (had && manifestKey(previous) !== styleKey(style2) && !opts.replace) {
    throw new Error(
      `\u9879\u76EE\u5DF2\u4F7F\u7528\u6574\u7247\u98CE\u683C ${previous.cn} ${previous.en}\uFF08${manifestKey(previous)}\uFF09\u3002\u6362\u6210 ${styleLabel(style2)} \u4F1A\u8BA9\u5168\u90E8\u955C\u5934\u9700\u8981\u91CD\u6E32\u67D3\uFF1B\u786E\u8BA4\u8981\u6362\u5C31\u52A0 --replace`
    );
  }
  const parent = import_node_path6.default.dirname(skillDir(opts.projectDir));
  import_node_fs5.default.mkdirSync(parent, { recursive: true });
  const staging = import_node_fs5.default.mkdtempSync(import_node_path6.default.join(parent, "." + SkillName + "-"));
  try {
    const version = source.fill(staging, style2, opts.env ?? {});
    for (const required of [StyleFile, GuideFile]) {
      if (!exists2(import_node_path6.default.join(staging, required))) {
        throw new Error(`\u98CE\u683C\u6765\u6E90 ${source.id()} \u6CA1\u6709\u5199\u51FA ${required}\uFF1A\u8FDD\u53CD\u6574\u7247\u98CE\u683C\u5951\u7EA6`);
      }
    }
    const digest = treeDigest(staging);
    if (had && !previous.legacy && manifestKey(previous) === styleKey(style2) && previous.digest === digest && previous.version === version) {
      return { manifest: previous, unchanged: true, replaced: "" };
    }
    const manifest = {
      source: style2.source,
      slug: style2.slug,
      cn: style2.cn,
      en: style2.en,
      version,
      digest,
      installed_at: rfc3339(opts.now ?? /* @__PURE__ */ new Date()),
      legacy: false
    };
    const body = marshalIndent({
      source: manifest.source,
      slug: manifest.slug,
      cn: manifest.cn,
      en: manifest.en,
      version: manifest.version,
      digest: manifest.digest,
      installed_at: manifest.installed_at
    });
    atomicWrite(import_node_path6.default.join(staging, ManifestFile), body + "\n", 420);
    const target = skillDir(opts.projectDir);
    let backup = "";
    if (exists2(target)) {
      backup = staging + ".old";
      try {
        import_node_fs5.default.renameSync(target, backup);
      } catch (err) {
        throw new Error(`\u79FB\u5F00\u65E7\u7684\u6574\u7247\u98CE\u683C\uFF1A${linkError("rename", target, backup, err)}`, { cause: err });
      }
    }
    try {
      import_node_fs5.default.renameSync(staging, target);
    } catch (err) {
      if (backup !== "") {
        try {
          import_node_fs5.default.renameSync(backup, target);
        } catch {
        }
      }
      throw new Error(`\u653E\u7F6E\u6574\u7247\u98CE\u683C\uFF1A${linkError("rename", staging, target, err)}`, { cause: err });
    }
    if (backup !== "") import_node_fs5.default.rmSync(backup, { recursive: true, force: true });
    try {
      import_node_fs5.default.rmSync(legacyDir(opts.projectDir), { recursive: true, force: true });
    } catch {
    }
    const result = { manifest, unchanged: false, replaced: "" };
    if (had && manifestKey(previous) !== styleKey(style2)) result.replaced = manifestKey(previous);
    return result;
  } finally {
    import_node_fs5.default.rmSync(staging, { recursive: true, force: true });
  }
}
function remove(projectDir) {
  const { manifest, ok } = installed(projectDir);
  if (!ok) return { manifest, had: false };
  import_node_fs5.default.rmSync(skillDir(projectDir), { recursive: true, force: true });
  import_node_fs5.default.rmSync(legacyDir(projectDir), { recursive: true, force: true });
  return { manifest, had: true };
}
function sortedEntries(dir) {
  return import_node_fs5.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function treeDigest(root) {
  const files = [];
  const walk = (dir, rel) => {
    for (const entry of sortedEntries(dir)) {
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) walk(import_node_path6.default.join(dir, entry.name), childRel);
      else if (entry.isFile() && entry.name !== ManifestFile) files.push(childRel);
    }
  };
  walk(root, "");
  files.sort(compareBytes);
  const hash = import_node_crypto2.default.createHash("sha256");
  for (const rel of files) {
    const sum = import_node_crypto2.default.createHash("sha256").update(import_node_fs5.default.readFileSync(import_node_path6.default.join(root, rel))).digest("hex");
    hash.update(`${rel} ${sum}
`);
  }
  return "sha256:" + hash.digest("hex");
}

// ../engine/src/filmstyle/lemo/catalog.json
var catalog_default = [
  {
    slug: "crayon-book",
    num: "01",
    en: "Crayon Picture Book",
    cn: "\u8721\u7B14\u513F\u7AE5\u7ED8\u672C",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Moon Can't Sleep",
    line: "The moon can't sleep, so a little girl climbs onto the roof to sing it a lullaby.",
    line_cn: "\u6708\u4EAE\u5931\u7720\u4E86\uFF0C\u5C0F\u5973\u5B69\u722C\u4E0A\u5C4B\u9876\u7ED9\u5B83\u5531\u6447\u7BEE\u66F2\u3002",
    uses: [
      "Picture books",
      "Bedtime stories",
      "Kids' learning"
    ],
    demo_seconds: 52,
    three_js: false
  },
  {
    slug: "watercolor",
    num: "02",
    en: "Watercolor Brush",
    cn: "\u6C34\u5F69\u7B14\u5237",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Follow the Rain",
    line: "Follow the rain from Australia's red desert heart to its green coast in one unbroken painted walk.",
    line_cn: "\u8DDF\u7740\u964D\u96E8\u4ECE\u6FB3\u6D32\u7EA2\u8272\u8179\u5730\u4E00\u8DEF\u753B\u5230\u7EFF\u8272\u6D77\u5CB8\uFF0C\u4E00\u955C\u5230\u5E95\u3002",
    uses: [
      "Nature documentary",
      "Travel",
      "Science explainers"
    ],
    demo_seconds: 113.6,
    three_js: false
  },
  {
    slug: "ink-wash",
    num: "03",
    en: "Chinese Ink Wash",
    cn: "\u4E2D\u56FD\u6C34\u58A8",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Swordsman and the River",
    line: "A swordsman crosses the river on the water and splits the current with a single stroke.",
    line_cn: "\u4FA0\u5BA2\u8E0F\u6C34\u8FC7\u6C5F\uFF0C\u4E00\u5251\u65AD\u6D41\u3002",
    uses: [
      "Wuxia",
      "Cultural brands",
      "Poetry"
    ],
    demo_seconds: 48,
    three_js: false
  },
  {
    slug: "impasto",
    num: "04",
    en: "Impasto Oil Painting",
    cn: "\u6CB9\u753B\u539A\u6D82",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Colour of Rain",
    line: "In a grey, rainy square one red umbrella opens, and a waltz paints the whole plaza in colour.",
    line_cn: "\u7070\u8272\u96E8\u4E2D\u5E7F\u573A\uFF0C\u7B2C\u4E00\u628A\u7EA2\u4F1E\u6491\u5F00\uFF0C\u5706\u821E\u66F2\u628A\u6574\u4E2A\u5E7F\u573A\u5237\u4E0A\u989C\u8272\u3002",
    uses: [
      "Music videos",
      "Art & culture",
      "Emotional ads"
    ],
    demo_seconds: 39.7,
    three_js: false
  },
  {
    slug: "one-line",
    num: "05",
    en: "One-line Drawing",
    cn: "\u4E00\u7B14\u753B",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Line That Never Lifted",
    line: "One unbroken line draws a whole life, then the pen passes to a child.",
    line_cn: "\u4E00\u6839\u4E0D\u79BB\u7EB8\u7684\u7EBF\u753B\u5B8C\u4E00\u4E2A\u4EBA\u7684\u4E00\u751F\uFF0C\u518D\u628A\u7B14\u4EA4\u7ED9\u5B69\u5B50\u3002",
    uses: [
      "Brand stories",
      "Life milestones",
      "Minimal ads"
    ],
    demo_seconds: 47.5,
    three_js: false
  },
  {
    slug: "whiteboard",
    num: "06",
    en: "Whiteboard Explainer",
    cn: "\u767D\u677F\u8BB2\u89E3",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Einstein in Your Pocket",
    line: "How your phone knows where you are: GPS, atomic clocks, and the 38 microseconds relativity adds every day.",
    line_cn: "\u624B\u673A\u600E\u4E48\u77E5\u9053\u4F60\u5728\u54EA\uFF1AGPS\u3001\u539F\u5B50\u949F\uFF0C\u548C\u76F8\u5BF9\u8BBA\u6BCF\u5929\u591A\u51FA\u7684 38 \u5FAE\u79D2\u3002",
    uses: [
      "Explainers",
      "Online courses",
      "Science"
    ],
    demo_seconds: 111,
    three_js: false
  },
  {
    slug: "shadow-puppet",
    num: "07",
    en: "Shadow Puppetry",
    cn: "\u76AE\u5F71\u620F",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Hou Yi Shoots the Suns",
    line: "Ten suns scorch the earth until the archer Hou Yi draws his bow, told with leather puppets on a lit screen.",
    line_cn: "\u5341\u65E5\u7099\u70E4\u5927\u5730\uFF0C\u540E\u7FBF\u5F20\u5F13\u5C04\u65E5\u3002",
    uses: [
      "Myths & folklore",
      "Heritage",
      "Festivals"
    ],
    demo_seconds: 54.4,
    three_js: false
  },
  {
    slug: "ukiyoe",
    num: "08",
    en: "Ukiyo-e",
    cn: "\u6D6E\u4E16\u7ED8",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Toward the Mountain",
    line: "A traveller walks toward a distant mountain; every shot is a woodblock print, a great wave at the climax, the mountain and the whole scroll at the end.",
    line_cn: "\u65C5\u4EBA\u8D70\u5411\u8FDC\u5C71\uFF0C\u6BCF\u4E2A\u955C\u5934\u90FD\u662F\u4E00\u5E45\u7248\u753B\uFF1B\u5DE8\u6D6A\u662F\u9AD8\u6F6E\uFF0C\u7ED3\u5C3E\u662F\u8FDC\u5C71\u4E0E\u6574\u5E45\u753B\u8F74\u62C9\u8FDC\u3002",
    uses: [
      "Travel",
      "Japanese culture",
      "Poetry"
    ],
    demo_seconds: 44,
    three_js: false
  },
  {
    slug: "papercut-red",
    num: "09",
    en: "Red Paper-cut",
    cn: "\u7EA2\u8272\u7A97\u82B1\u526A\u7EB8",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "Nian Comes to Town",
    line: "On New Year's Eve the beast Nian comes to town, and one girl's giant paper-cut lights up the village to scare it off.",
    line_cn: "\u9664\u5915\u5E74\u517D\u8FDB\u6751\uFF0C\u5C0F\u5973\u5B69\u526A\u51FA\u7684\u5927\u7A97\u82B1\u7167\u4EAE\u5168\u6751\uFF0C\u628A\u5B83\u5413\u8DD1\u3002",
    uses: [
      "Lunar New Year",
      "Festive greetings",
      "Folk tales"
    ],
    demo_seconds: 49,
    three_js: false
  },
  {
    slug: "paper-lantern",
    num: "10",
    en: "Paper-cut Lightbox",
    cn: "\u7EB8\u96D5\u706F\u5F71",
    category_en: "East Asian Traditions",
    category_cn: "\u4E1C\u65B9\u4F20\u7EDF",
    film: "The Last Night Train",
    line: "An old night train makes its last run, from a snowy mountain halt through a long tunnel to the sea, its lit windows going out one by one at the end of the line.",
    line_cn: "\u4E00\u5217\u8001\u591C\u8F66\u8DD1\u6700\u540E\u4E00\u8D9F\uFF1A\u4ECE\u96EA\u5C71\u5C0F\u7AD9\u7A7F\u8FC7\u957F\u96A7\u9053\u5F00\u5230\u6D77\u8FB9\uFF0C\u5230\u7AD9\u540E\u8F66\u7A97\u4E00\u6247\u6247\u7184\u706D\u3002",
    uses: [
      "Journeys and travel",
      "Farewells and anniversaries",
      "Places and their stories"
    ],
    demo_seconds: 51,
    three_js: true
  },
  {
    slug: "risograph",
    num: "12",
    en: "Risograph Print",
    cn: "Risograph \u5B54\u7248\u5370\u5237",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Sunday Ride",
    line: "A Sunday-morning bike ride through the city \u2014 bakery, park, riverside \u2014 each stop adding an ink until three misregistered plates overprint.",
    line_cn: "\u5468\u65E5\u65E9\u6668\u9A91\u8F66\u7A7F\u8FC7\u57CE\u5E02\uFF1A\u9762\u5305\u5E97\u3001\u516C\u56ED\u3001\u6CB3\u8FB9\uFF0C\u6BCF\u5230\u4E00\u5904\u52A0\u4E00\u7248\u6CB9\u58A8\uFF0C\u6700\u540E\u4E09\u7248\u5957\u5370\u3002",
    uses: [
      "Indie brands",
      "Zines",
      "Lifestyle"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "halftone-dossier",
    num: "13",
    en: "Halftone Dossier",
    cn: "\u590D\u53E4\u534A\u8C03\u6848\u5377",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Case File: Chubby",
    line: "A chubby orange cat stands trial for testing gravity and 4 a.m. parkour, and walks free.",
    line_cn: "\u6A58\u732B\u80D6\u6A58\u88AB\u7ACB\u6848\u5BA1\u67E5\uFF1A\u6D4B\u8BD5\u91CD\u529B\u3001\u51CC\u6668\u8DD1\u9177\uFF0C\u6700\u540E\u65E0\u7F6A\u91CA\u653E\u3002",
    uses: [
      "Humour",
      "Pet content",
      "Social shorts"
    ],
    demo_seconds: 30,
    three_js: false
  },
  {
    slug: "woodcut",
    num: "15",
    en: "Woodcut Print",
    cn: "\u6728\u523B\u7248\u753B",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Bell Founder",
    line: "A village spends a whole winter casting one bell; the first time it rings, the snow stops.",
    line_cn: "\u6751\u5B50\u7528\u4E00\u6574\u4E2A\u51AC\u5929\u94F8\u4E00\u53E3\u949F\uFF0C\u949F\u58F0\u7B2C\u4E00\u6B21\u54CD\u8D77\uFF0C\u96EA\u505C\u4E86\u3002",
    uses: [
      "Folk tales",
      "Craft brands",
      "Book trailers"
    ],
    demo_seconds: 58.5,
    three_js: false
  },
  {
    slug: "swiss-motion",
    num: "16",
    en: "Swiss Motion Graphics",
    cn: "\u745E\u58EB\u52A8\u6001\u6392\u7248",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Five Rules for a Poster",
    line: "A concert poster lays itself out by five Swiss design rules; the fifth is to break just one.",
    line_cn: "\u4E00\u5F20\u97F3\u4E50\u4F1A\u6D77\u62A5\u6309\u745E\u58EB\u8BBE\u8BA1\u7684\u4E94\u6761\u89C4\u5219\u81EA\u5DF1\u6392\u7248\uFF0C\u7B2C\u4E94\u6761\u662F\u53EA\u6253\u7834\u4E00\u6761\u3002",
    uses: [
      "Brand identity",
      "Events",
      "Design education"
    ],
    demo_seconds: 44,
    three_js: false
  },
  {
    slug: "spy-titles",
    num: "17",
    en: "60s Spy Title Sequence",
    cn: "60s \u95F4\u8C0D\u7247\u5934",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "The Velvet Cipher",
    line: "Opening titles for an imaginary 1964 spy film: a chase for a stolen key until the shapes lock into the title.",
    line_cn: "\u865A\u6784 1964 \u5E74\u95F4\u8C0D\u7247\u7684\u7247\u5934\uFF1A\u8FFD\u4E00\u628A\u88AB\u5077\u7684\u94A5\u5319\uFF0C\u51E0\u4F55\u788E\u7247\u6700\u540E\u62FC\u6210\u7247\u540D\u3002",
    uses: [
      "Title sequences",
      "Event openers",
      "Trailers"
    ],
    demo_seconds: 44.1,
    three_js: false
  },
  {
    slug: "art-deco",
    num: "18",
    en: "Art Deco",
    cn: "\u88C5\u9970\u827A\u672F",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Midnight at the Starlight Hotel",
    line: "A grand hotel, 1930: a bellboy races lifts and revolving doors to deliver one letter before midnight.",
    line_cn: "1930 \u5E74\u7684\u5927\u996D\u5E97\uFF0C\u95E8\u7AE5\u8D76\u5728\u5348\u591C\u524D\u628A\u4E00\u5C01\u4FE1\u9001\u4E0A\u9876\u697C\u3002",
    uses: [
      "Luxury & hospitality",
      "Galas",
      "Invitations"
    ],
    demo_seconds: 58.4,
    three_js: false
  },
  {
    slug: "blueprint",
    num: "19",
    en: "Blueprint",
    cn: "\u84DD\u56FE / \u5DE5\u7A0B\u5236\u56FE",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Patent Pending: The Cloud Catcher",
    line: "An inventor's blueprint draws, explodes and assembles a cloud-catching machine, and its revision cloud starts to rain.",
    line_cn: "\u53D1\u660E\u5BB6\u7684\u84DD\u56FE\u81EA\u5DF1\u753B\u51FA\u4E00\u53F0\u63A5\u4E91\u673A\u5668\uFF0C\u4FEE\u8BA2\u4E91\u7EBF\u53D8\u6210\u4E86\u771F\u7684\u96E8\u4E91\u3002",
    uses: [
      "Engineering",
      "Hardware launches",
      "Tech explainers"
    ],
    demo_seconds: 46.7,
    three_js: false
  },
  {
    slug: "stained-glass",
    num: "20",
    en: "Stained Glass",
    cn: "\u5F69\u8272\u73BB\u7483\u7A97",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "The Dragon of the East Window",
    line: "Sunlight crosses a cathedral window from dawn to dusk, waking each pane of a knight-and-dragon tale.",
    line_cn: "\u9633\u5149\u4ECE\u6E05\u6668\u79FB\u5230\u9EC4\u660F\uFF0C\u7167\u5230\u54EA\u4E00\u683C\u82B1\u7A97\uFF0C\u54EA\u4E00\u683C\u7684\u6545\u4E8B\u5C31\u52A8\u8D77\u6765\u3002",
    uses: [
      "Legends",
      "Heritage",
      "Holiday stories"
    ],
    demo_seconds: 56.5,
    three_js: false
  },
  {
    slug: "pictogram-motion",
    num: "21",
    en: "Pictogram Motion",
    cn: "\u8C61\u5F62\u8FD0\u52A8\u56FE\u5F62",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Left Behind",
    line: "A yellow umbrella left on a bus waits out a sunny day on the lost-property shelf, then opens with 312 others when the storm comes back: objects, vehicles, weather and signs as beat-locked geometric pictograms.",
    line_cn: "\u4E00\u628A\u88AB\u843D\u5728\u516C\u4EA4\u8F66\u4E0A\u7684\u9EC4\u4F1E\uFF0C\u6674\u5929\u91CC\u5728\u5931\u7269\u62DB\u9886\u7684\u8D27\u67B6\u4E0A\u7B49\u4E86\u4E00\u6574\u5929\uFF0C\u66B4\u96E8\u56DE\u6765\u65F6\u548C\u53E6\u5916 312 \u628A\u4E00\u8D77\u6491\u5F00\uFF1A\u7269\u4EF6\u3001\u4EA4\u901A\u3001\u5929\u6C14\u548C\u6807\u8BC6\uFF0C\u90FD\u662F\u5361\u7740\u8282\u62CD\u7684\u51E0\u4F55\u8C61\u5F62\u7B26\u53F7\u3002",
    uses: [
      "Public services and city stories",
      "Brand and event identity films",
      "Explainers told through signs and objects"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "ascii-crt",
    num: "22",
    en: "ASCII / CRT Terminal",
    cn: "ASCII / CRT \u7EC8\u7AEF",
    category_en: "Graphic & Type",
    category_cn: "\u56FE\u5F62\u4E0E\u6392\u7248",
    film: "Tranquility.log",
    line: "A moon-base AI wakes after forty years to a signal from Earth, and replies by drawing \u201Chome\u201D in characters.",
    line_cn: "\u6708\u7403\u57FA\u5730\u7684 AI \u6C89\u7761 40 \u5E74\u540E\u88AB\u5524\u9192\uFF0C\u7528\u5B57\u7B26\u753B\u51FA\u201C\u5BB6\u201D\u6765\u56DE\u590D\u3002",
    uses: [
      "Developer tools",
      "Sci-fi",
      "Tech brands"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "dataviz",
    num: "23",
    en: "Data Storytelling",
    cn: "\u6570\u636E\u53D9\u4E8B",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "A Hundred Summers",
    line: "A hundred years of summer temperatures, where the chart itself tells the story.",
    line_cn: "\u4E00\u767E\u5E74\u7684\u590F\u5B63\u6C14\u6E29\uFF0C\u56FE\u8868\u672C\u8EAB\u5C31\u662F\u6545\u4E8B\u3002",
    uses: [
      "Data journalism",
      "Reports",
      "Climate & science"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "iso-infographic",
    num: "24",
    en: "Isometric Infographic",
    cn: "\u7B49\u8DDD\u4FE1\u606F\u56FE",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "From Bean to Cup",
    line: "A coffee's journey from the plantation to your hands, across one isometric world.",
    line_cn: "\u4E00\u676F\u5496\u5561\u4ECE\u79CD\u690D\u56ED\u5230\u4F60\u624B\u91CC\u7684\u65C5\u7A0B\u3002",
    uses: [
      "Process explainers",
      "Supply chains",
      "Annual reports"
    ],
    demo_seconds: 58.8,
    three_js: false
  },
  {
    slug: "dark-keynote",
    num: "25",
    en: "Dark Tech Keynote",
    cn: "\u6697\u8272\u79D1\u6280\u53D1\u5E03",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Room to Think",
    line: "Launch film for Tidy, a fictional app: one buried cursor snaps hundreds of windows back into place.",
    line_cn: "\u865A\u6784 app Tidy \u7684\u53D1\u5E03\u7247\uFF1A\u88AB\u57CB\u6389\u7684\u5149\u6807\u4E00\u952E\u628A\u51E0\u767E\u4E2A\u7A97\u53E3\u5F52\u4F4D\u3002",
    uses: [
      "Product launches",
      "SaaS",
      "Keynotes"
    ],
    demo_seconds: 42,
    three_js: false
  },
  {
    slug: "rubber-hose",
    num: "26",
    en: "1930s Rubber Hose Cartoon",
    cn: "1930s \u6A61\u76AE\u7BA1\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Coffee Cup Chase",
    line: "A coffee cup chases a runaway sugar cube around the kitchen, 1930s-cartoon style.",
    line_cn: "\u4E00\u53EA\u5496\u5561\u676F\u6EE1\u53A8\u623F\u8FFD\u4E00\u5757\u9003\u8DD1\u7684\u65B9\u7CD6\u3002",
    uses: [
      "Food & drink",
      "Retro ads",
      "Kids"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "cel-anime-80s",
    num: "27",
    en: "80s Cel Anime",
    cn: "80 \u5E74\u4EE3\u8D5B\u7490\u7490\u52A8\u753B",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "City Lights, 1987",
    line: "A courier girl rides through a rain-soaked neon city to deliver a tape before the dawn launch.",
    line_cn: "\u5FEB\u9012\u5C11\u5973\u9A91\u8F66\u7A7F\u8FC7\u96E8\u540E\u9713\u8679\u90FD\u5E02\uFF0C\u8D76\u5728\u9ECE\u660E\u53D1\u5C04\u524D\u9001\u5230\u4E00\u76D8\u78C1\u5E26\u3002",
    uses: [
      "Music videos",
      "Game trailers",
      "Nostalgia"
    ],
    demo_seconds: 59,
    three_js: false
  },
  {
    slug: "scifi-toon",
    num: "28",
    en: "Sci-Fi Sitcom Toon",
    cn: "\u79D1\u5E7B\u60C5\u666F\u559C\u5267\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Coffee Run",
    line: "A jaded genius opens a portal just to buy coffee and tumbles through ever-stranger universes.",
    line_cn: "\u538C\u4E16\u5929\u624D\u5F00\u4F20\u9001\u95E8\u53EA\u60F3\u4E70\u676F\u5496\u5561\uFF0C\u5374\u7A7F\u8FC7\u8D8A\u6765\u8D8A\u79BB\u8C31\u7684\u5E73\u884C\u5B87\u5B99\u3002",
    uses: [
      "Comedy",
      "Tech brands",
      "Social shorts"
    ],
    demo_seconds: 57.5,
    three_js: false
  },
  {
    slug: "pixel-rpg",
    num: "29",
    en: "16-bit Pixel RPG",
    cn: "16-bit \u50CF\u7D20 RPG",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "The Last Save Point",
    line: "At the final boss door a hero saves the game, and the save screen replays the whole journey.",
    line_cn: "\u52C7\u58EB\u5728\u6700\u7EC8 Boss \u95E8\u524D\u5B58\u6863\uFF0C\u5B58\u6863\u753B\u9762\u95EA\u56DE\u4E00\u8DEF\u5192\u9669\u3002",
    uses: [
      "Game trailers",
      "Recaps",
      "Nostalgia"
    ],
    demo_seconds: 54.5,
    three_js: false
  },
  {
    slug: "hd-2d",
    num: "31",
    en: "HD-2D",
    cn: "HD-2D",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "The Lampbearer",
    line: "The lighthouse goes dark; a girl carries the last flame through a night forest and up the storm cliffs.",
    line_cn: "\u706F\u5854\u7184\u706D\uFF0C\u5B59\u5973\u63D0\u7740\u6700\u540E\u4E00\u7C07\u706B\u7A7F\u8FC7\u591C\u6797\u3001\u722C\u4E0A\u98CE\u66B4\u60AC\u5D16\u3002",
    uses: [
      "Game trailers",
      "Fantasy",
      "Story films"
    ],
    demo_seconds: 76.5,
    three_js: true
  },
  {
    slug: "microgame",
    num: "32",
    en: "Microgame Frenzy",
    cn: "\u5FAE\u6E38\u620F\u5FEB\u95EA",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "Five-Second Astronaut",
    line: "A clumsy cadet survives a five-second boot camp, faster and faster, until the boss: landing home.",
    line_cn: "\u89C1\u4E60\u5B87\u822A\u5458\u95EF\u4E94\u79D2\u8BAD\u7EC3\u8425\uFF0C\u8D8A\u6765\u8D8A\u5FEB\uFF0CBoss \u5173\u4EB2\u624B\u964D\u843D\u56DE\u5730\u7403\u3002",
    uses: [
      "Game trailers",
      "Onboarding",
      "Social shorts"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "game-show",
    num: "33",
    en: "Game Show Flat",
    cn: "\u7EFC\u827A\u8282\u594F\u6241\u5E73",
    category_en: "Games",
    category_cn: "\u6E38\u620F",
    film: "Rhythm of AI, 1997 \u2192 2026",
    line: "The history of AI as a rhythm game: models take the stage on the beat, and a report card closes the show.",
    line_cn: "\u628A AI \u53D1\u5C55\u53F2\u505A\u6210\u4E00\u5C40\u8282\u594F\u6E38\u620F\uFF0C\u6A21\u578B\u8E29\u7740\u62CD\u767B\u573A\uFF0C\u6700\u540E\u53D1\u6210\u7EE9\u5355\u3002",
    uses: [
      "Tech timelines",
      "Year in review",
      "Variety shows"
    ],
    demo_seconds: 148.8,
    three_js: false
  },
  {
    slug: "silent-film",
    num: "34",
    en: "1920s Silent Film",
    cn: "1920s \u9ED8\u7247",
    category_en: "Cinema & Eras",
    category_cn: "\u7535\u5F71\u4E0E\u65F6\u4EE3",
    film: "The Runaway Loaf",
    line: "A baker's boy chases a runaway loaf downhill, then breaks it in half for a hungry girl.",
    line_cn: "\u9762\u5305\u5E97\u5B66\u5F92\u8FFD\u4E00\u4E2A\u6EDA\u8D70\u7684\u9762\u5305\uFF0C\u6700\u540E\u63B0\u6210\u4E24\u534A\u5206\u7ED9\u997F\u809A\u5B50\u7684\u5C0F\u5973\u5B69\u3002",
    uses: [
      "Comedy",
      "Retro brands",
      "Silent storytelling"
    ],
    demo_seconds: 54.2,
    three_js: false
  },
  {
    slug: "backrooms",
    num: "36",
    en: "Liminal Found Footage",
    cn: "\u540E\u5BA4 / \u65B0\u602A\u8C08",
    category_en: "Cinema & Eras",
    category_cn: "\u7535\u5F71\u4E0E\u65F6\u4EE3",
    film: "Night Shift Orientation",
    line: "A new night-shift hire films their first night in an endless yellow office, following the rules on the wall.",
    line_cn: "\u65B0\u591C\u73ED\u5458\u5DE5\u62CD\u4E0B\u5165\u804C\u7B2C\u4E00\u665A\uFF1A\u65E0\u5C3D\u7684\u9EC4\u8272\u529E\u516C\u7A7A\u95F4\uFF0C\u548C\u5899\u4E0A\u7684\u5458\u5DE5\u5B88\u5219\u3002",
    uses: [
      "Horror",
      "Mystery & ARG",
      "Game teasers"
    ],
    demo_seconds: 59.7,
    three_js: true
  },
  {
    slug: "brick-toy",
    num: "37",
    en: "Brick Toy",
    cn: "\u79EF\u6728\u73A9\u5177",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Rocket from Spare Parts",
    line: "A brick astronaut builds a rocket from spare parts and flies to a brick moon.",
    line_cn: "\u79EF\u6728\u5B87\u822A\u5458\u7528\u96F6\u4EF6\u62FC\u51FA\u706B\u7BAD\uFF0C\u98DE\u5411\u79EF\u6728\u6708\u4EAE\u3002",
    uses: [
      "Toys & kids",
      "Product builds",
      "Space"
    ],
    demo_seconds: 54,
    three_js: true
  },
  {
    slug: "paper-popup",
    num: "41",
    en: "Paper Pop-up Book",
    cn: "\u7EB8\u7247\u7ACB\u4F53\u4E66",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Pip's Paper Adventure",
    line: "A pop-up book opens on a desk; a sprite named Pip adventures through paper worlds and jumps out into ours.",
    line_cn: "\u7ACB\u4F53\u4E66\u5728\u4E66\u684C\u4E0A\u6253\u5F00\uFF0C\u5C0F\u7CBE\u7075 Pip \u5728\u7EB8\u7247\u4E16\u754C\u5192\u9669\uFF0C\u6700\u540E\u8DF3\u51FA\u4E66\u5916\u3002",
    uses: [
      "Children's books",
      "Game trailers",
      "Story films"
    ],
    demo_seconds: 133,
    three_js: true
  },
  {
    slug: "tilt-shift",
    num: "42",
    en: "Tilt-Shift Miniature",
    cn: "\u79FB\u8F74\u5FAE\u7F29",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Toy Town Rush Hour",
    line: "Morning rush hour in a town that looks like a model: traffic, trains and tiny people.",
    line_cn: "\u73A9\u5177\u57CE\u7684\u65E9\u9AD8\u5CF0\uFF0C\u4E00\u5207\u90FD\u50CF\u6A21\u578B\u3002",
    uses: [
      "City promos",
      "Real estate",
      "Transport"
    ],
    demo_seconds: 38,
    three_js: true
  },
  {
    slug: "lowpoly-island",
    num: "43",
    en: "Low-poly Isometric Island",
    cn: "\u4F4E\u591A\u8FB9\u5F62\u7B49\u8DDD",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "The Island That Grew",
    line: "An island and its village grow tile by tile from an empty sea, each tile a note, into a starry night.",
    line_cn: "\u7A7A\u6D77\u91CC\u4E00\u683C\u683C\u957F\u51FA\u5C0F\u5C9B\u548C\u6751\u5E84\uFF0C\u6BCF\u653E\u4E00\u5757\u54CD\u4E00\u4E2A\u97F3\u7B26\uFF0C\u76F4\u5230\u661F\u7A7A\u3002",
    uses: [
      "Game trailers",
      "World building",
      "Calm content"
    ],
    demo_seconds: 53,
    three_js: true
  },
  {
    slug: "glass-product",
    num: "44",
    en: "Glass Product Render",
    cn: "\u73BB\u7483\u8D28\u611F\u4EA7\u54C1",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Aura \u2014 Hear the Light",
    line: "Unboxing and close-ups of Aura, fictional glass earbuds, in strip-light sweeps and caustics.",
    line_cn: "\u865A\u6784\u73BB\u7483\u8033\u673A Aura \u7684\u5F00\u7BB1\u4E0E\u7279\u5199\u3002",
    uses: [
      "Product launches",
      "Consumer tech",
      "Beauty"
    ],
    demo_seconds: 32,
    three_js: true
  },
  {
    slug: "urban-sketch",
    num: "45",
    en: "Urban Sketch \xB7 Pen & Wash",
    cn: "\u94A2\u7B14\u6DE1\u5F69",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "Where the Wind Went",
    line: "A park that is only a pen sketch; wherever the wind carries her straw hat, colour follows.",
    line_cn: "\u516C\u56ED\u53EA\u662F\u4E00\u5F20\u94A2\u7B14\u901F\u5199\uFF0C\u98CE\u628A\u8349\u5E3D\u5439\u5230\u54EA\u91CC\uFF0C\u54EA\u91CC\u624D\u6709\u989C\u8272\u3002",
    uses: [
      "City & travel",
      "Architecture",
      "Lifestyle brands"
    ],
    demo_seconds: 32.4,
    three_js: false
  },
  {
    slug: "living-screencast",
    num: "46",
    en: "Living Screencast",
    cn: "\u6D3B\u4F53\u5B9E\u673A\u5F55\u5C4F",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Clawd Moves In",
    line: "Clawd hops out of the terminal into the Claude app and acts out plan mode and self-checks in one take.",
    line_cn: "\u50CF\u7D20\u5C0F\u4EBA Clawd \u642C\u8FDB Claude \u5E94\u7528\uFF0C\u4E00\u955C\u5230\u5E95\u6F14\u793A Plan \u6A21\u5F0F\u548C\u81EA\u68C0\u3002",
    uses: [
      "Product tutorials",
      "Feature launches",
      "Onboarding"
    ],
    demo_seconds: 59.4,
    three_js: false
  },
  {
    slug: "midcentury-toon",
    num: "48",
    en: "Mid-century Cartoon",
    cn: "50s \u6241\u5E73\u5361\u901A",
    category_en: "Cartoon & Anime",
    category_cn: "\u5361\u901A\u4E0E\u52A8\u753B",
    film: "Meet Pip",
    line: "A robot vacuum set up in three steps, told like a 1950s classroom film.",
    line_cn: "\u7528 50 \u5E74\u4EE3\u6559\u80B2\u7247\u7684\u53E3\u543B\uFF0C\u4E09\u6B65\u6559\u4F60\u88C5\u597D\u4E00\u53F0\u626B\u5730\u673A\u3002",
    uses: [
      "Set-up guides",
      "Help centres",
      "How-to"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "hologram-hud",
    num: "52",
    en: "Sci-fi Hologram HUD",
    cn: "\u79D1\u5E7B\u5168\u606F\u754C\u9762",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Volt \xB7 Spec Scan",
    line: "An e-bike is scanned into a hologram; target boxes lock onto the battery, motor and brakes.",
    line_cn: "\u7535\u52A9\u529B\u8F66\u88AB\u626B\u63CF\u6210\u5168\u606F\u7EBF\u6846\uFF0C\u76EE\u6807\u6846\u4F9D\u6B21\u9501\u5B9A\u7535\u6C60\u3001\u7535\u673A\u3001\u5239\u8F66\u3002",
    uses: [
      "Spec walkthroughs",
      "Launch videos",
      "Trade shows"
    ],
    demo_seconds: 39,
    three_js: false
  },
  {
    slug: "engraving",
    num: "53",
    en: "Copperplate Engraving",
    cn: "\u94DC\u7248\u753B",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Honeybee, Plate VII",
    line: "A natural-history plate engraves itself: the burin cuts the copper, the bee builds up line by line, and a watercolour wash brings it to life.",
    line_cn: "\u4E00\u5F20\u535A\u7269\u5FD7\u56FE\u7248\u81EA\u5DF1\u523B\u51FA\u6765\uFF1A\u96D5\u5200\u63A8\u5F00\u94DC\u7248\uFF0C\u871C\u8702\u4E00\u7EBF\u7EBF\u6210\u5F62\uFF0C\u6700\u540E\u624B\u5DE5\u6C34\u5F69\u4E0A\u8272\u3002",
    uses: [
      "Museum labels",
      "Science explainers",
      "Brand heritage"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "silkscreen-poster",
    num: "54",
    en: "Silkscreen Travel Poster",
    cn: "\u4E1D\u5370\u65C5\u884C\u6D77\u62A5",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "The Long Way Home",
    line: "A traveller crosses the world one full-bleed screen print at a time, a ticket stub counting the distance from home, until the far side turns into the way back.",
    line_cn: "\u4E00\u5F20\u6EE1\u5C4F\u4E1D\u5370\u6D77\u62A5\u4E00\u5EA7\u57CE\uFF0C\u7968\u6839\u6570\u7740\u79BB\u5BB6\u7684\u516C\u91CC\u6570\uFF0C\u8D70\u5230\u4E16\u754C\u7684\u53E6\u4E00\u5934\uFF0C\u624D\u53D1\u73B0\u90A3\u662F\u56DE\u5BB6\u7684\u8DEF\u3002",
    uses: [
      "Destination guides",
      "Tourism",
      "Event posters"
    ],
    demo_seconds: 50,
    three_js: false
  },
  {
    slug: "satellite-briefing",
    num: "55",
    en: "Satellite Briefing",
    cn: "\u536B\u661F\u7B80\u62A5",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Map Still Says Sea",
    line: "A satellite follows the map to the Aral Sea and finds a desert; only the part someone dammed came back.",
    line_cn: "\u536B\u661F\u7167\u7740\u5730\u56FE\u53BB\u627E\u54B8\u6D77\uFF0C\u627E\u5230\u7684\u662F\u6C99\u6F20\uFF1B\u53EA\u6709\u7B51\u4E86\u575D\u7684\u90A3\u4E00\u5757\u56DE\u6765\u4E86\u3002",
    uses: [
      "Climate",
      "News explainers",
      "Geography"
    ],
    demo_seconds: 37.8,
    three_js: false
  },
  {
    slug: "briefing-board",
    num: "56",
    en: "Engineering Briefing Board",
    cn: "\u5DE5\u7A0B\u7B80\u62A5\u677F",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Ship Decides",
    line: "Four bridge types are tested on one briefing wall, and the ship that must pass under picks the winner.",
    line_cn: "\u4E00\u6761\u6CB3\u8981\u67B6\u6865\uFF0C\u56DB\u79CD\u6865\u578B\u5728\u4E00\u9762\u7B80\u62A5\u5899\u4E0A\u9010\u4E2A\u53D7\u68C0\uFF0C\u62CD\u677F\u7684\u662F\u6865\u4E0B\u8981\u8FC7\u7684\u8239\u3002",
    uses: [
      "Engineering",
      "Option comparisons",
      "Briefings"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "lidar-survey",
    num: "57",
    en: "LiDAR Survey",
    cn: "\u70B9\u4E91\u6D4B\u7ED8",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "The Fields Under the Forest",
    line: "A laser survey strips the canopy off a Connecticut forest and finds 3.4 km of old farm walls.",
    line_cn: "\u6FC0\u5149\u70B9\u4E91\u5265\u6389\u4E00\u7247\u68EE\u6797\u7684\u6811\u51A0\uFF0C\u9732\u51FA\u5F53\u5E74\u519C\u7530\u7684\u77F3\u5899\uFF1A3.4 \u516C\u91CC\u3002",
    uses: [
      "Heritage",
      "Environment",
      "Site surveys"
    ],
    demo_seconds: 40,
    three_js: true
  },
  {
    slug: "white-model",
    num: "58",
    en: "Projection on White Model",
    cn: "\u767D\u6A21\u6295\u5F71",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "How a Flattened City Grew Back",
    line: "A projector paints Rotterdam's white model layer by layer, from the 1940 gap to today's towers.",
    line_cn: "\u6295\u5F71\u673A\u628A\u6570\u636E\u4E00\u5C42\u5C42\u5237\u4E0A\u9E7F\u7279\u4E39\u767D\u6A21\uFF1A\u4ECE 1940 \u5E74\u7684\u7A7A\u6D1E\u5230\u4ECA\u5929\u7684\u5854\u697C\u3002",
    uses: [
      "Urban planning",
      "Exhibitions",
      "City data"
    ],
    demo_seconds: 40,
    three_js: true
  },
  {
    slug: "data-physical",
    num: "59",
    en: "Data Physicalization",
    cn: "\u6570\u636E\u5B9E\u7269\u5316",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Two Spirals",
    line: "Twelve years of wind and solar stacked as real plates, spiralling round a walnut dial until solar overtakes.",
    line_cn: "\u5341\u4E8C\u5E74\u98CE\u7535\u548C\u592A\u9633\u80FD\u88C5\u673A\u53E0\u6210\u5B9E\u7269\uFF0C\u7ED5\u8868\u76D8\u5347\u6210\u4E24\u6761\u87BA\u65CB\uFF0C2021 \u5E74\u592A\u9633\u80FD\u53CD\u8D85\u3002",
    uses: [
      "Annual reports",
      "Investor decks",
      "Energy data"
    ],
    demo_seconds: 39.4,
    three_js: true
  },
  {
    slug: "teardown",
    num: "60",
    en: "Exploded Teardown",
    cn: "\u4EA7\u54C1\u62C6\u89E3",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "21 Keys, Opened",
    line: "Half an open-source keyboard comes apart in one orbit, down to the chip, then closes with its real dimensions.",
    line_cn: "\u5F00\u6E90\u952E\u76D8\u7684\u4E00\u534A\u5728\u4E00\u6B21\u73AF\u7ED5\u4E2D\u9010\u5C42\u62C6\u5F00\uFF0C\u770B\u5230\u4E3B\u63A7\u518D\u5408\u62E2\uFF0C\u6807\u4E0A\u771F\u5B9E\u5C3A\u5BF8\u3002",
    uses: [
      "Hardware launches",
      "Product pages",
      "Spec explainers"
    ],
    demo_seconds: 38.8,
    three_js: true
  },
  {
    slug: "microscope",
    num: "61",
    en: "Microscope Story",
    cn: "\u663E\u5FAE\u53D9\u4E8B",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Measured Blue",
    line: "One continuous move from a liver slide to a single nucleus; two circles, counted pixel by pixel, differ 2.4 times in blue.",
    line_cn: "\u4E00\u955C\u4ECE\u809D\u7EC4\u7EC7\u73BB\u7247\u63A8\u5230\u5355\u4E2A\u7EC6\u80DE\u6838\uFF0C\u4E24\u4E2A\u5706\u9010\u50CF\u7D20\u6570\u51FA 2.4 \u500D\u7684\u84DD\u3002",
    uses: [
      "Biomedicine",
      "Materials science",
      "Skincare science"
    ],
    demo_seconds: 39.5,
    three_js: false
  },
  {
    slug: "archive-lighttable",
    num: "62",
    en: "Archive Light Table",
    cn: "\u6863\u6848\u706F\u53F0",
    category_en: "Evidence Films",
    category_cn: "\u5B9E\u8BC1\u5F71\u50CF",
    film: "Two Seconds Short",
    line: "The telegram said 57 seconds; under a loupe, the Wrights' glass negatives and the archive say 59.",
    line_cn: "\u7535\u62A5\u8BF4\u6700\u957F\u98DE\u4E86 57 \u79D2\uFF1B\u653E\u5927\u955C\u4E0B\uFF0C\u83B1\u7279\u5144\u5F1F\u7684\u5E95\u7247\u548C\u6863\u6848\u8BF4\u662F 59 \u79D2\u3002",
    uses: [
      "Brand history",
      "Archive stories",
      "Museums"
    ],
    demo_seconds: 40,
    three_js: false
  },
  {
    slug: "caption-news",
    num: "63",
    en: "Caption News",
    cn: "\u5B57\u5E55\u65B0\u95FB",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Bee Ledger",
    line: "America lost 1.3 million bee colonies, yet the count rose 6 %: a news short that works with the sound off.",
    line_cn: "\u7F8E\u56FD\u4E00\u5E74\u6B7B\u6389 130 \u4E07\u7BB1\u871C\u8702\uFF0C\u603B\u6570\u5374\u6DA8\u4E86 6%\uFF1A\u9759\u97F3\u4E5F\u80FD\u770B\u61C2\u7684\u65B0\u95FB\u3002",
    uses: [
      "Social news",
      "Report explainers",
      "Data shorts"
    ],
    demo_seconds: 59.5,
    three_js: false
  },
  {
    slug: "newsreel",
    num: "64",
    en: "1920s Newsreel",
    cn: "1920s \u65B0\u95FB\u5F71\u7247",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Knock-Knee Alert",
    line: "1926: the papers say the Charleston will ruin America's knees; at Ford's own picnic the kids dance it anyway.",
    line_cn: "1926 \u5E74\u62A5\u7EB8\u8BF4\u67E5\u5C14\u65AF\u987F\u4F1A\u8DF3\u574F\u819D\u76D6\uFF0C\u798F\u7279\u5DE5\u4EBA\u91CE\u9910\u4F1A\u4E0A\u7684\u5B69\u5B50\u7167\u8DF3\u4E0D\u8BEF\u3002",
    uses: [
      "History stories",
      "Fads & eras",
      "Anniversaries"
    ],
    demo_seconds: 54.6,
    three_js: false
  },
  {
    slug: "countdown",
    num: "65",
    en: "Live Countdown Split-screen",
    cn: "\u5B9E\u65F6\u5012\u8BA1\u65F6\u5206\u5C4F",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Counting Itself Down",
    line: "The last minute of the Artemis II launch, uncut: one cell opens to nine, and they merge into one at ignition.",
    line_cn: "\u963F\u5C14\u5FD2\u5F25\u65AF\u4E8C\u53F7\u53D1\u5C04\u7684\u6700\u540E\u4E00\u5206\u949F\uFF0C\u4E00\u79D2\u4E0D\u526A\uFF1A\u683C\u5B50\u4ECE 1 \u5F00\u5230 9\uFF0C\u70B9\u706B\u5408\u6210 1\u3002",
    uses: [
      "Launches",
      "Countdowns",
      "Live events"
    ],
    demo_seconds: 59.5,
    three_js: false
  },
  {
    slug: "city-symphony",
    num: "66",
    en: "Time-lapse Symphony",
    cn: "\u5EF6\u65F6\u4EA4\u54CD",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "One Day in New York",
    line: "One day in New York in time-lapse: rivers of light, a grid on the sixteenths, 1899 beside today.",
    line_cn: "\u7EBD\u7EA6\u7684\u4E00\u5929\uFF1A\u5EF6\u65F6\u5149\u6CB3\u3001\u8E29\u7740\u5341\u516D\u5206\u97F3\u7B26\u7684\u7F51\u683C\uFF0C1899 \u5E74\u548C\u4ECA\u5929\u5E76\u6392\u3002",
    uses: [
      "City films",
      "Music montages",
      "Openers"
    ],
    demo_seconds: 52,
    three_js: false
  },
  {
    slug: "visual-investigation",
    num: "67",
    en: "Visual Investigation",
    cn: "\u89C6\u89C9\u8C03\u67E5",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Hindenburg: Four Minutes, 32 Seconds",
    line: "Newsreel, photos, testimony and the 1937 inquiry on one clock: five sources point to the same spot.",
    line_cn: "\u65B0\u95FB\u7247\u3001\u7167\u7247\u3001\u8BC1\u8BCD\u548C\u8C03\u67E5\u62A5\u544A\u6392\u4E0A\u540C\u4E00\u6761\u65F6\u95F4\u8F74\uFF0C\u4E94\u8DEF\u6765\u6E90\u6307\u5411\u4E00\u5904\u3002",
    uses: [
      "Reconstructions",
      "Fact-checks",
      "Incident reports"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "kino-montage",
    num: "68",
    en: "Constructivist Montage",
    cn: "\u6784\u6210\u4E3B\u4E49\u8499\u592A\u5947",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "410 Days",
    line: "The Empire State's 1931 brochure credits its builders; the site film and Hine's photos answer: 2,500 a day.",
    line_cn: "\u5E1D\u56FD\u5927\u53A6\u7684\u5C0F\u518C\u5B50\u5199\u7740\u5EFA\u9020\u8005\uFF0C\u5DE5\u5730\u5B9E\u62CD\u548C\u8001\u7167\u7247\u7ED9\u51FA\u7B54\u6848\uFF1A\u6BCF\u5929 2,500 \u4EBA\u3002",
    uses: [
      "Industry histories",
      "Milestones",
      "Collective effort"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "telestrator",
    num: "69",
    en: "Sports Telestrator",
    cn: "\u4F53\u80B2\u6218\u672F\u677F",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "Freeze Frame",
    line: "Down 3\u20130 at half-time, Fenerbah\xE7e scored three in 12 minutes: freeze, draw, split screen, shot map.",
    line_cn: "\u534A\u573A 0\u20133\uFF0C\u8D39\u5185\u5DF4\u5207 12 \u5206\u949F\u8FDE\u8FDB\u4E09\u7403\uFF1A\u51BB\u4F4F\u753B\u9762\u3001\u753B\u7EBF\u3001\u5206\u5C4F\u3001\u5C04\u95E8\u56FE\u3002",
    uses: [
      "Sports analysis",
      "Match recaps",
      "Coaching"
    ],
    demo_seconds: 54.4,
    three_js: false
  },
  {
    slug: "news-package",
    num: "70",
    en: "Broadcast News Package",
    cn: "\u7535\u89C6\u65B0\u95FB\u5305\u88C5",
    category_en: "Edit & Documentary",
    category_cn: "\u526A\u8F91\u4E0E\u7EAA\u5B9E",
    film: "The Week in AI",
    line: "Four AI stories from one week in a full on-air package: rundown, headline strap, price board, spec card.",
    line_cn: "\u4E00\u5468\u56DB\u6761 AI \u65B0\u95FB\uFF0C\u4E00\u6574\u5957\u7535\u89C6\u53F0\u5305\u88C5\uFF1A\u4E32\u8054\u5355\u3001\u6807\u9898\u6761\u3001\u7FFB\u724C\u4EF7\u683C\u8868\u3001\u89C4\u683C\u5361\u3002",
    uses: [
      "News round-ups",
      "Bulletins",
      "Market updates"
    ],
    demo_seconds: 53.5,
    three_js: false
  },
  {
    slug: "memphis-diorama",
    num: "71",
    en: "Memphis Diorama",
    cn: "\u5B5F\u83F2\u65AF\u5FAE\u7F29\u666F\u89C2",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Four Seasons in Pomelo Town",
    line: "One river bend, four seasons, one take; each turns when the big tree squats and springs back.",
    line_cn: "\u4E00\u4E2A\u6CB3\u6E7E\u4E00\u955C\u8FC7\u5B8C\u56DB\u5B63\uFF0C\u5927\u6811\u4E00\u8E72\u4E00\u5F39\uFF0C\u5C31\u6362\u4E00\u5B63\u3002",
    uses: [
      "Web heroes",
      "Ambient loops",
      "Seasons"
    ],
    demo_seconds: 45,
    three_js: true
  },
  {
    slug: "transit-map",
    num: "72",
    en: "Transit Map",
    cn: "\u5730\u94C1\u7EBF\u8DEF\u56FE",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "6 Kilometres",
    line: "A printed metro map grows from one 6 km line in 1993 to 21 lines and 906 km.",
    line_cn: "\u4E00\u5F20\u7EB8\u4E0A\u7684\u7EBF\u8DEF\u56FE\uFF0C\u4ECE 1993 \u5E74\u7684 6 \u516C\u91CC\u957F\u5230 21 \u6761\u7EBF\u3001906 \u516C\u91CC\u3002",
    uses: [
      "Transport",
      "Growth over time",
      "Networks"
    ],
    demo_seconds: 47,
    three_js: false
  },
  {
    slug: "chalkboard",
    num: "73",
    en: "Chalkboard",
    cn: "\u9ED1\u677F\u7C89\u7B14",
    category_en: "Hand-drawn & Painting",
    category_cn: "\u624B\u7ED8\u4E0E\u7ED8\u753B",
    film: "The Story of Chinese Characters",
    line: "Chalk writes a popular claim about two characters, wipes it, and traces \u5C04 back three thousand years.",
    line_cn: "\u7C89\u7B14\u5199\u4E0B\u7F51\u4E0A\u7684\u8BF4\u6CD5\uFF0C\u518D\u4E00\u64E6\uFF0C\u628A\u300C\u5C04\u300D\u5199\u56DE\u4E09\u5343\u5E74\u524D\u3002",
    uses: [
      "Word origins",
      "Myth-busting",
      "Lessons"
    ],
    demo_seconds: 49.3,
    three_js: false
  },
  {
    slug: "isometric-picture-book",
    num: "74",
    en: "Isometric Picture Book",
    cn: "\u7B49\u8DDD\u7ED8\u672C",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Seventy-Two Seats",
    line: "Travellers board an isometric plane, and the order shows why one way is nearly twice as fast.",
    line_cn: "\u7B49\u8DDD\u7684\u767B\u673A\u53E3\u548C\u673A\u8231\u91CC\uFF0C\u5C0F\u4EBA\u6309\u987A\u5E8F\u767B\u673A\uFF0C\u8BB2\u6E05\u54EA\u79CD\u53EB\u6CD5\u5FEB\u5C06\u8FD1\u4E00\u534A\u3002",
    uses: [
      "Everyday rules",
      "Queues",
      "Comparisons"
    ],
    demo_seconds: 59.8,
    three_js: false
  },
  {
    slug: "printed-long-take",
    num: "75",
    en: "Printed Long Take",
    cn: "\u5370\u5237\u957F\u955C\u5934",
    category_en: "Print & Printmaking",
    category_cn: "\u5370\u5237\u4E0E\u7248\u753B",
    film: "Thirty-Three Cranes",
    line: "Red-crowned cranes in a Hokkaido valley, one scratchboard take, counted back from 33 to 1,927.",
    line_cn: "\u522E\u7248\u753B\u7684\u5317\u6D77\u9053\u6CB3\u8C37\u4E00\u955C\u5230\u5E95\uFF0C\u4E39\u9876\u9E64\u4ECE 33 \u53EA\u6570\u56DE\u5230 1,927 \u53EA\u3002",
    uses: [
      "Journeys",
      "Wildlife",
      "Landscapes"
    ],
    demo_seconds: 60,
    three_js: true
  },
  {
    slug: "circuit-board",
    num: "76",
    en: "Circuit Board",
    cn: "\u7535\u8DEF\u677F",
    category_en: "Information & Keynote",
    category_cn: "\u4FE1\u606F\u4E0E\u53D1\u5E03",
    film: "Seven Milliseconds",
    line: "Rivers become copper traces as current runs 2,080 km from a dam to a phone charger.",
    line_cn: "\u6C5F\u6CB3\u53D8\u6210\u7535\u8DEF\u677F\u4E0A\u7684\u8D70\u7EBF\uFF0C\u7535\u6D41\u4ECE\u6C34\u575D\u8DD1 2,080 \u516C\u91CC\u8FDB\u624B\u673A\u5145\u7535\u5668\u3002",
    uses: [
      "Energy",
      "Supply chains",
      "Devices"
    ],
    demo_seconds: 60,
    three_js: false
  },
  {
    slug: "desktop-flythrough",
    num: "77",
    en: "Desktop Flythrough",
    cn: "\u684C\u9762\u7A7F\u68AD",
    category_en: "Materials & 3D",
    category_cn: "\u6750\u8D28\u4E0E 3D",
    film: "Before the Ding",
    line: "A cat photo hops across app cards on a sunlit desk, from one phone to a friend's.",
    line_cn: "\u4E00\u5F20\u732B\u7167\u7247\u8DF3\u8FC7\u684C\u4E0A\u7684\u5E94\u7528\u5361\u7247\uFF0C\u4ECE\u4E00\u53F0\u624B\u673A\u98DE\u5230\u670B\u53CB\u624B\u673A\u91CC\uFF0C\u4E00\u955C\u8DDF\u5230\u5E95\u3002",
    uses: [
      "App explainers",
      "Workflows",
      "Products"
    ],
    demo_seconds: 60,
    three_js: true
  }
];

// ../engine/src/filmstyle/lemo/lemo.ts
var SourceID = "lemo-opuscar";
var RepoURL = "https://github.com/lemomo-ai/lemo-opuscar.git";
var Gallery = "https://lemomo-ai.github.io/lemo-opuscar/";
var PinnedCommit = "bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00";
var PinnedStyleCount = 66;
var LibraryEnv = "AM_LEMO_OPUSCAR_LIBRARY";
function entryLabel(entry) {
  return `${entry.cn} ${entry.en}\uFF08${SourceID}/${entry.slug}\uFF09`;
}
function entryStyle(entry) {
  const style2 = {
    source: SourceID,
    slug: entry.slug,
    order: entry.num,
    cn: entry.cn,
    en: entry.en,
    category_cn: entry.category_cn,
    category_en: entry.category_en,
    uses: entry.uses,
    summary: "demo\uFF1A" + entry.line_cn
  };
  if (entry.three_js) style2.tags = ["three.js"];
  return style2;
}
var catalogEntries = catalog_default;
function catalog2() {
  return catalogEntries.map((entry) => ({ ...entry, uses: entry.uses ? [...entry.uses] : entry.uses }));
}
function find2(slug) {
  const entry = catalogEntries.find((e) => e.slug === slug);
  return entry ? { ...entry } : void 0;
}

// ../engine/src/filmstyle/lemo/library.ts
var import_node_child_process2 = require("node:child_process");
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);
function repoOf(opts) {
  return opts.repoURL || RepoURL;
}
function commitOf(opts) {
  return opts.commit || PinnedCommit;
}
function errorText3(err) {
  const e = err;
  if (e && typeof e === "object" && typeof e.code === "string" && typeof e.path === "string" && typeof e.syscall === "string") {
    return goPathError(e.syscall, e.path, e);
  }
  return err instanceof Error ? err.message : String(err);
}
function defaultLibraryDir(env, commit) {
  if (commit.length > 12) commit = commit.slice(0, 12);
  return import_node_path7.default.join(sourceDir(env, SourceID), commit);
}
function libraryDir(opts) {
  const dir = opts.env[LibraryEnv];
  if (dir) return dir;
  return defaultLibraryDir(opts.env, commitOf(opts));
}
function exists3(file) {
  try {
    import_node_fs6.default.statSync(file);
    return true;
  } catch {
    return false;
  }
}
function isLibrary(dir) {
  return ["core/lib.js", "styles"].every((rel) => exists3(import_node_path7.default.join(dir, rel)));
}
var LibraryNotFoundError = class extends Error {
  constructor(dir) {
    super(`\u98CE\u683C\u5E93 ${dir} \u8FD8\u6CA1\u6709\u4E0B\u8F7D\uFF1Afile does not exist`);
    this.dir = dir;
    this.name = "LibraryNotFoundError";
  }
  dir;
  code = "ENOENT";
};
function lookGit(env) {
  try {
    return lookPath("git", env.PATH ?? "");
  } catch {
    return void 0;
  }
}
function openLibrary(opts) {
  const dir = libraryDir(opts);
  if (!isLibrary(dir)) throw new LibraryNotFoundError(dir);
  const lib = { dir, commit: "", managed: exists3(import_node_path7.default.join(dir, managedMarker)) };
  const git = lookGit(opts.env);
  if (git !== void 0) {
    const result = (0, import_node_child_process2.spawnSync)(git, ["rev-parse", "HEAD"], { cwd: dir, env: gitEnv(opts.env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status === 0 && !result.error) lib.commit = result.stdout.trim();
  }
  return lib;
}
async function ensureLibrary(opts, signal) {
  try {
    return openLibrary(opts);
  } catch {
  }
  const dir = libraryDir(opts);
  let entries = [];
  try {
    entries = import_node_fs6.default.readdirSync(dir);
  } catch {
  }
  if (entries.length > 0) throw new Error(`${dir} \u4E0D\u662F lemo-opuscar \u98CE\u683C\u5E93\uFF08\u7F3A\u5C11 core/lib.js \u6216 styles/\uFF09`);
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u98CE\u683C\u5E93\uFF1A${errorText3(err)}`, { cause: err });
  }
  import_node_fs6.default.mkdirSync(import_node_path7.default.dirname(dir), { recursive: true });
  const unlock = await lock(dir + ".lock", signal);
  try {
    try {
      return openLibrary(opts);
    } catch {
    }
    const partial = dir + ".partial";
    const commit = commitOf(opts);
    try {
      await downloadLibrary(git, partial, commit, opts, signal);
    } catch (err) {
      throw new Error(
        `${errorText3(err)}
\u5DF2\u4E0B\u8F7D\u7684\u90E8\u5206\u4FDD\u7559\u5728 ${partial}\uFF0C\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u8F7D\uFF1B\u4E5F\u53EF\u4EE5\u81EA\u5DF1 git clone ${repoOf(opts).replace(/\.git$/, "")} \u540E\u7528 ${LibraryEnv} \u6307\u5411\u5B83`,
        { cause: err }
      );
    }
    import_node_fs6.default.writeFileSync(import_node_path7.default.join(partial, managedMarker), commit + "\n", { mode: 420 });
    try {
      import_node_fs6.default.rmdirSync(dir);
    } catch {
    }
    try {
      import_node_fs6.default.renameSync(partial, dir);
    } catch (err) {
      throw new Error(`\u653E\u7F6E\u98CE\u683C\u5E93\u5230 ${dir}\uFF1Arename ${partial} ${dir}: ${errorText3(err)}`, { cause: err });
    }
    return { dir, commit, managed: true };
  } finally {
    unlock();
  }
}
var librarySparse = [
  "/*",
  "!/styles/*/demo/",
  "!/styles/*/poster.jpg",
  "!/styleboard/",
  "!/docs/",
  "!/core/assets/"
];
var libraryStages = [
  ["/*", "!/*/"],
  ["/*", "!/*/", "/core/", "!/core/assets/"],
  ["/*", "!/*/", "/core/", "!/core/assets/", "/styles/*/STYLE.md", "/styles/*/style.json", "/styles/*/DEMO.md"],
  librarySparse
];
var stageAttempts = 5;
async function downloadLibrary(git, partial, commit, opts, signal) {
  const run = (...args) => gitCommand(git, partial, opts.env, opts.output, args, signal);
  const retry = async (what, ...args) => {
    let last;
    for (let attempt = 1; attempt <= stageAttempts; attempt++) {
      try {
        await run(...args);
        return;
      } catch (err) {
        last = err;
      }
      if (signal?.aborted) throw abortReason(signal);
      if (opts.output && attempt < stageAttempts) opts.output.write(`${what}\u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${stageAttempts}\uFF09\u2026
`);
    }
    throw new Error(`${what}\u5931\u8D25\uFF1A${errorText3(last)}`, { cause: last });
  };
  if (!exists3(import_node_path7.default.join(partial, ".git"))) {
    import_node_fs6.default.rmSync(partial, { recursive: true, force: true });
    import_node_fs6.default.mkdirSync(partial, { recursive: true });
    for (const step of [
      ["init", "--quiet"],
      ["remote", "add", "origin", repoOf(opts)],
      ["config", "core.sparseCheckout", "true"]
    ]) {
      try {
        await run(...step);
      } catch (err) {
        throw new Error(`\u51C6\u5907\u98CE\u683C\u5E93\u514B\u9686\uFF08git ${step.join(" ")}\uFF09\uFF1A${errorText3(err)}`, { cause: err });
      }
    }
  } else {
    try {
      await run("remote", "set-url", "origin", repoOf(opts));
    } catch (err) {
      throw new Error(`\u66F4\u65B0\u98CE\u683C\u5E93\u7684\u4E0A\u6E38\u5730\u5740\uFF1A${errorText3(err)}`, { cause: err });
    }
  }
  let haveCommit = true;
  try {
    await run("rev-parse", "--verify", "--quiet", commit + "^{commit}");
  } catch {
    haveCommit = false;
  }
  if (!haveCommit) {
    await retry("\u4ECE " + repoOf(opts) + " \u4E0B\u8F7D\u98CE\u683C\u5E93 " + commit + " ", "fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", commit);
  }
  let head = "";
  try {
    head = await run("rev-parse", "--verify", "--quiet", "HEAD");
  } catch {
    head = "";
  }
  if (head !== commit) {
    writeSparse(partial, libraryStages[0]);
    await retry("\u68C0\u51FA\u98CE\u683C\u5E93", "-c", "advice.detachedHead=false", "checkout", "--quiet", "--force", commit);
  }
  const stages = libraryStages;
  for (let i = 0; i < stages.length; i++) {
    writeSparse(partial, stages[i]);
    await retry(`\u68C0\u51FA\u98CE\u683C\u5E93\uFF08\u7B2C ${i + 1}/${stages.length} \u6BB5\uFF09`, "read-tree", "--reset", "-u", "HEAD");
  }
  const finalHead = await run("rev-parse", "HEAD");
  if (finalHead !== commit) throw new Error(`\u98CE\u683C\u5E93\u68C0\u51FA\u5230 ${finalHead}\uFF0C\u4E0E\u56FA\u5B9A\u7684 ${commit} \u4E0D\u7B26\uFF0C\u62D2\u7EDD\u4F7F\u7528`);
  if (!isLibrary(partial)) throw new Error(`\u98CE\u683C\u5E93 ${commit} \u4E0A\u7F3A\u5C11 core/lib.js \u6216 styles/\uFF1A\u4E0A\u6E38\u76EE\u5F55\u7ED3\u6784\u5DF2\u53D8`);
}
var managedMarker = ".am-library";
function writeSparse(dir, patterns) {
  const info = import_node_path7.default.join(dir, ".git", "info");
  import_node_fs6.default.mkdirSync(info, { recursive: true });
  import_node_fs6.default.writeFileSync(import_node_path7.default.join(info, "sparse-checkout"), patterns.join("\n") + "\n", { mode: 420 });
}
function readSparse(dir) {
  const body = import_node_fs6.default.readFileSync(import_node_path7.default.join(dir, ".git", "info", "sparse-checkout"), "utf8");
  return body.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}
var skipInDemo = /* @__PURE__ */ new Set(["stills", "out", "chk", "node_modules"]);
function sortedEntries2(dir) {
  return import_node_fs6.default.readdirSync(dir, { withFileTypes: true }).sort((a, b) => compareBytes(a.name, b.name));
}
function demoUsesCoreAssets(demo) {
  const walk = (dir) => {
    let entries;
    try {
      entries = sortedEntries2(dir);
    } catch {
      return false;
    }
    for (const entry of entries) {
      const file = import_node_path7.default.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipInDemo.has(entry.name)) continue;
        if (walk(file)) return true;
        continue;
      }
      switch (goExt(file).toLowerCase()) {
        case ".js":
        case ".mjs":
        case ".html":
        case ".json":
          break;
        default:
          continue;
      }
      try {
        if (import_node_fs6.default.readFileSync(file, "utf8").includes("core/assets/")) return true;
      } catch {
      }
    }
    return false;
  };
  let root;
  try {
    root = import_node_fs6.default.lstatSync(demo);
  } catch {
    return false;
  }
  if (!root.isDirectory()) return false;
  if (skipInDemo.has(import_node_path7.default.basename(demo))) return false;
  return walk(demo);
}
function gitCommand(git, dir, env, stderr, args, signal) {
  return runCommand2(git, args, { cwd: dir, env: gitEnv(env), stderr, signal }).then((out) => out.trim());
}
function runCommand2(file, args, options = {}) {
  const { signal } = options;
  return new Promise((resolve3, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const child = (0, import_node_child_process2.spawn)(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", options.stderr ? "pipe" : "ignore"]
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (options.stdout) options.stdout.write(chunk);
      else out += chunk;
    });
    if (options.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => options.stderr.write(chunk));
    }
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    let failed = false;
    child.once("error", (err) => {
      failed = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", onAbort);
      if (failed) return;
      if (signal?.aborted) reject(abortReason(signal));
      else if (sig) reject(new ExitError(-1, sig));
      else if (code !== 0) reject(new ExitError(code ?? -1, null));
      else resolve3(out);
    });
  });
}
function gitEnv(env) {
  const out = { ...env };
  out.GIT_LFS_SKIP_SMUDGE = "1";
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_SYSTEM = "/dev/null";
  out.GIT_TERMINAL_PROMPT = "0";
  if (!out.GIT_HTTP_LOW_SPEED_LIMIT) out.GIT_HTTP_LOW_SPEED_LIMIT = "1000";
  if (!out.GIT_HTTP_LOW_SPEED_TIME) out.GIT_HTTP_LOW_SPEED_TIME = "60";
  return out;
}
var lockStale2 = 30 * 60 * 1e3;
async function lock(file, signal) {
  for (; ; ) {
    try {
      const fd = import_node_fs6.default.openSync(file, "wx", 420);
      import_node_fs6.default.writeSync(fd, `${process.pid}
`);
      import_node_fs6.default.closeSync(fd);
      return () => {
        try {
          import_node_fs6.default.unlinkSync(file);
        } catch {
        }
      };
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw new Error(`\u521B\u5EFA\u9501 ${file}\uFF1A${goPathError("open", file, err)}`, { cause: err });
      }
    }
    try {
      if (Date.now() - import_node_fs6.default.statSync(file).mtimeMs > lockStale2) {
        import_node_fs6.default.rmSync(file, { force: true });
        continue;
      }
    } catch {
    }
    if (signal?.aborted) throw abortReason(signal);
    await new Promise((resolve3, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve3();
      }, 200);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
function posterPath(lib, slug) {
  return import_node_path7.default.join(lib.dir, "styles", slug, "poster.jpg");
}

// ../engine/src/filmstyle/lemo/prepare.ts
var import_node_crypto3 = __toESM(require("node:crypto"), 1);
var import_node_fs7 = __toESM(require("node:fs"), 1);
var import_node_path8 = __toESM(require("node:path"), 1);
var completeMarker = "am-complete";
var fullSparse = ["/*", "!/styleboard/", "!/docs/"];
var demoBatch = 10;
function libraryComplete(lib) {
  if (lib.managed) return exists3(import_node_path8.default.join(lib.dir, ".git", completeMarker));
  const entries = catalog2();
  if (entries.length === 0) return false;
  const first = entries[0].slug;
  return exists3(import_node_path8.default.join(lib.dir, "styles", first, "demo", "index.html")) && exists3(posterPath(lib, first));
}
function requireLibrary(opts) {
  let lib;
  try {
    lib = openLibrary(opts);
  } catch {
    throw missing("lemo-opuscar \u98CE\u683C\u5E93", "\u6CA1\u6709\u4E0B\u8F7D\u5230 " + libraryDir(opts));
  }
  if (!libraryComplete(lib)) throw missing("lemo-opuscar \u98CE\u683C\u5E93", lib.dir + " \u8FD8\u6CA1\u4E0B\u8F7D\u5B8C\u6574");
  return lib;
}
function requireStyle(lib, style2) {
  if (!exists3(import_node_path8.default.join(lib.dir, "styles", style2.slug, "demo", "index.html"))) {
    throw missing("\u98CE\u683C " + entryLabel(style2) + " \u7684 demo \u6E90\u7801", "\u98CE\u683C\u5E93 " + lib.dir + " \u91CC\u6CA1\u6709");
  }
  if (style2.three_js && !exists3(import_node_path8.default.join(lib.dir, "node_modules", "three", "build", "three.module.js"))) {
    throw missing("\u98CE\u683C\u5E93\u7684 three.js \u4F9D\u8D56", entryLabel(style2) + " \u8981\u7528\uFF0C\u98CE\u683C\u5E93\u91CC\u8FD8\u6CA1\u6709 node_modules/three");
  }
}
async function prepareLibrary(opts, signal) {
  const report = opts.progress ?? (() => {
  });
  try {
    const existing = openLibrary(opts);
    if (libraryComplete(existing)) return existing;
  } catch {
  }
  const entries = catalog2();
  const batches = Math.floor((entries.length + demoBatch - 1) / demoBatch);
  const steps = 1 + 1 + batches + 1 + 1;
  let step = 0;
  const next = (stage) => {
    step++;
    report({ step, steps, stage });
  };
  next("\u4E0B\u8F7D\u98CE\u683C\u5E93\u57FA\u7840\u90E8\u5206\uFF08\u6307\u5357\u3001core/\u3001\u5168\u90E8\u98CE\u683C\u8BF4\u660E\uFF09");
  const lib = await ensureLibrary(opts, signal);
  if (!lib.managed) {
    if (!libraryComplete(lib)) {
      throw new Error(`${lib.dir} \u662F\u4F60\u81EA\u5DF1\u7684\u68C0\u51FA\uFF0Cam \u4E0D\u6539\u5B83\uFF1A\u8BF7\u5728\u91CC\u9762\u68C0\u51FA\u5168\u90E8 demo \u4E0E\u6D77\u62A5\uFF08styles/*/demo\u3001styles/*/poster.jpg\uFF09`);
    }
    return lib;
  }
  let git;
  try {
    git = lookPath("git", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 git\uFF0C\u65E0\u6CD5\u4E0B\u8F7D\u98CE\u683C\u5E93\uFF1A${errorText3(err)}`, { cause: err });
  }
  const unlock = await lock(lib.dir + ".lock", signal);
  try {
    let patterns;
    try {
      patterns = readSparse(lib.dir);
    } catch (err) {
      throw new Error(`\u8BFB\u53D6\u98CE\u683C\u5E93\u7A00\u758F\u89C4\u5219\uFF1A${errorText3(err)}`, { cause: err });
    }
    const stage = async (what, ...add) => {
      for (const pattern of add) {
        if (!patterns.includes(pattern)) patterns.push(pattern);
      }
      writeSparse(lib.dir, patterns);
      let readErr;
      for (let attempt = 1; attempt <= stageAttempts; attempt++) {
        try {
          await gitCommand(git, lib.dir, opts.env, opts.output, ["read-tree", "--reset", "-u", "HEAD"], signal);
          readErr = void 0;
          break;
        } catch (err) {
          readErr = err;
        }
        if (signal?.aborted) break;
        if (opts.output && attempt < stageAttempts) opts.output.write(`${what}\u5931\u8D25\uFF0C\u91CD\u8BD5\uFF08${attempt + 1}/${stageAttempts}\uFF09\u2026
`);
      }
      if (readErr !== void 0) {
        throw new Error(`${what}\u5931\u8D25\uFF08\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u8F7D\uFF09\uFF1A${errorText3(readErr)}`, { cause: readErr });
      }
    };
    next("\u4E0B\u8F7D\u98CE\u683C\u6D77\u62A5");
    await stage("\u4E0B\u8F7D\u98CE\u683C\u6D77\u62A5", "/styles/*/poster.jpg");
    for (let i = 0; i < entries.length; i += demoBatch) {
      const end = Math.min(i + demoBatch, entries.length);
      const label = `\u4E0B\u8F7D demo \u6E90\u7801\uFF08\u7B2C ${i / demoBatch + 1}/${batches} \u6279\uFF09`;
      next(label);
      await stage(label, ...entries.slice(i, end).map((style2) => "/styles/" + style2.slug + "/demo/"));
    }
    next("\u4E0B\u8F7D core/assets \u6A21\u578B\u4E0E\u8D34\u56FE");
    await stage("\u4E0B\u8F7D core/assets", "/core/assets/");
    patterns = [...fullSparse];
    await stage("\u6574\u7406\u98CE\u683C\u5E93");
    next("\u5B89\u88C5 three.js \u4F9D\u8D56\uFF08npm ci\uFF09");
    await setupNode(lib, { env: opts.env, output: opts.output }, signal);
    import_node_fs7.default.writeFileSync(import_node_path8.default.join(lib.dir, ".git", completeMarker), lib.commit + "\n", { mode: 420 });
    return lib;
  } finally {
    unlock();
  }
}
var nodeMarker = ".am-ok";
async function setupNode(lib, opts, signal) {
  let want;
  try {
    want = filesDigest(import_node_path8.default.join(lib.dir, "package.json"), import_node_path8.default.join(lib.dir, "package-lock.json"));
  } catch (err) {
    throw new Error(`\u8BFB\u53D6\u98CE\u683C\u5E93\u7684 package.json\uFF1A${errorText3(err)}`, { cause: err });
  }
  const marker = import_node_path8.default.join(lib.dir, "node_modules", nodeMarker);
  let got = "";
  try {
    got = import_node_fs7.default.readFileSync(marker, "utf8");
  } catch {
  }
  if (got.trim() === want) return;
  let npm;
  try {
    npm = lookPath("npm", opts.env.PATH ?? "");
  } catch (err) {
    throw new Error(`\u627E\u4E0D\u5230 npm\uFF08\u9700\u8981 Node 20+\uFF09\uFF0C\u65E0\u6CD5\u5B89\u88C5\u98CE\u683C\u5E93\u7684 three.js\uFF1A${errorText3(err)}`, { cause: err });
  }
  const output = opts.output ?? { write: () => true };
  output.write("\u5B89\u88C5\u98CE\u683C\u5E93\u7684 Node \u4F9D\u8D56\uFF08npm ci\uFF09\u2026\n");
  try {
    await runCommand2(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"], {
      cwd: lib.dir,
      env: opts.env,
      stdout: output,
      stderr: output,
      signal
    });
  } catch (err) {
    throw new Error(`npm ci \u5931\u8D25\uFF1A${errorText3(err)}`, { cause: err });
  }
  import_node_fs7.default.mkdirSync(import_node_path8.default.dirname(marker), { recursive: true });
  import_node_fs7.default.writeFileSync(marker, want + "\n", { mode: 420 });
}
function filesDigest(...files) {
  const hash = import_node_crypto3.default.createHash("sha256");
  for (const file of files) hash.update(import_node_fs7.default.readFileSync(file));
  return hash.digest("hex").slice(0, 16);
}

// ../engine/src/filmstyle/lemo/fill.ts
var import_node_fs9 = __toESM(require("node:fs"), 1);
var import_node_path10 = __toESM(require("node:path"), 1);

// ../engine/src/filmstyle/lemo/attribution.md.tmpl
var attribution_md_default = "# \u6765\u6E90\n\n- \u98CE\u683C\uFF1A{{.Style.CN}} \xB7 {{.Style.EN}}\uFF08`{{.Style.Slug}}`\uFF09\n- \u98CE\u683C\u5E93\uFF1Alemo-opuscar\uFF0C\u4F5C\u8005 LemoLab\uFF0C{{.Repo}}\n- commit\uFF1A`{{.Commit}}`\n- \u5B89\u88C5\u65B9\u5F0F\uFF1A`am film-style use {{.Style.Slug}}`\uFF0C\u4ECE\u56FA\u5B9A commit \u62F7\u8D1D\uFF0C\u4E0D\u8DDF\u968F\u4E0A\u6E38 main\n\n## \u4FDD\u7559\u4E86\u4EC0\u4E48\n\n- `styles/{{.Style.Slug}}/` \u4E0B\u7684 `STYLE.md`\u3001`style.json`\u3001`DEMO.md`\u3001`poster.jpg` \u4E0E `demo/` \u6E90\u7801\uFF0C\u539F\u6837\u62F7\u8D1D\n- \u98CE\u683C\u5E93\u7684 `core/lib.js`\u3001`core/three/`\u3001`core/post/`\u3001`core/fonts/`\uFF0C\u539F\u6837\u62F7\u8D1D\n{{- if .Style.ThreeJS}}\n- \u98CE\u683C\u5E93 `node_modules/three/` \u7684 `build/` \u4E0E `examples/jsm/`\uFF08three.js\uFF0CMIT\uFF09\n{{- end}}\n\n## \u4E22\u4E86\u4EC0\u4E48\n\n- `demo/stills/`\u3001`demo/out/` \u7B49\u5BA1\u7247\u622A\u56FE\u4E0E\u6E32\u67D3\u4EA7\u7269\uFF0C\u4EE5\u53CA\u97F3\u9891\u6587\u4EF6\n- \u98CE\u683C\u5E93\u7684\u5BFC\u6F14\u6D41\u7A0B\uFF08`AGENTS.md`\u3001`DIRECTOR.md`\uFF09\uFF1A\u6545\u4E8B\u3001\u5206\u955C\u3001\u914D\u97F3\u7531 am \u7684\u5236\u4F5C\u6D41\u7A0B\u8D1F\u8D23\n- \u98CE\u683C\u5E93\u7684\u6E32\u67D3\u4E0E\u5408\u6210\u5DE5\u5177\uFF08`core/render/`\uFF09\uFF1A\u6E32\u67D3\u8D70 HyperFrames\n\n## \u6539\u4E86\u54EA\u51E0\u5904\n\n- `SKILL.md` \u4E0E\u672C\u6587\u4EF6\u7531 am \u751F\u6210\uFF0C\u8BF4\u660E\u8FD9\u5957\u98CE\u683C\u5728 HyperFrames \u955C\u5934\u91CC\u600E\u4E48\u7528\n\n## \u8BB8\u53EF\n\n- \u4EE3\u7801\u4E0E\u6587\u6863\uFF1AMIT\uFF08\u89C1 `LICENSE`\uFF09\n- demo \u7247\u53CA\u5176\u753B\u9762\uFF1ACC BY 4.0\uFF0C\u590D\u7528\u65F6\u7F72\u540D LemoLab \u5E76\u94FE\u63A5\u4E0A\u6E38\u4ED3\u5E93\uFF0C\u8BF4\u660E\u6539\u52A8\n- demo \u91CC\u7684\u7B2C\u4E09\u65B9\u7D20\u6750\uFF1A\u5404\u81EA\u7684\u8BB8\u53EF\uFF0C\u89C1 `demo/CREDITS`\n- \u7528\u8FD9\u5957\u98CE\u683C\u505A\u51FA\u7684\u7247\u5B50\u5F52\u5236\u4F5C\u8005\u6240\u6709\uFF0C\u4E0D\u9700\u8981\u7F72\u540D\n";

// ../engine/src/filmstyle/lemo/skill.md.tmpl
var skill_md_default = '---\nname: am-film-style\ndescription: \u672C\u7247\u7684\u6574\u7247\u98CE\u683C\u300C{{.Style.CN}} {{.Style.EN}}\u300D\uFF0C\u6765\u81EA lemo-opuscar \u98CE\u683C\u5E93\uFF08{{.Short}}\uFF09\u3002\u6BCF\u4E2A\u955C\u5934\u90FD\u5FC5\u987B\u9075\u5B88 STYLE.md \u7684\u4E0D\u53D8\u91CF\uFF1Bdemo \u53EA\u7528\u6765\u5B66\u6280\u6CD5\u3002\n---\n\n# \u6574\u7247\u98CE\u683C\uFF1A{{.Style.CN}} \xB7 {{.Style.EN}}\n\n\u672C\u7247\u7684\u6BCF\u4E2A\u955C\u5934\u90FD\u753B\u6210\u8FD9\u4E00\u79CD\u98CE\u683C\u3002\u5B83\u6765\u81EA lemo-opuscar \u98CE\u683C\u5E93\uFF08`{{.Style.Slug}}`\uFF0Ccommit `{{.Short}}`\uFF09\uFF0C\u7531 `am film-style use` \u88C5\u8FDB\u9879\u76EE\uFF0C\u4E0D\u8981\u624B\u6539\u672C\u76EE\u5F55\u3002\n\n| \u6587\u4EF6 | \u7528\u9014 |\n|---|---|\n| `STYLE.md` | \u98CE\u683C\u7684\u4E0D\u53D8\u91CF\uFF1A\u957F\u4EC0\u4E48\u6837\u3001\u914D\u8272\u903B\u8F91\u3001\u5B57\u4F53\u3001\u52A8\u6548\u8D28\u611F\u3001\u955C\u5934\u8BED\u6CD5\u3001\u6807\u5FD7\u624B\u6CD5\u3001\u7981\u5FCC\u3001\u5F15\u64CE\u7528\u6CD5\u3002**\u5168\u90E8\u9075\u5B88** |\n| `DEMO.md`\u3001`demo/` | \u4E0A\u6E38 demo \u7247\u7684\u8BF4\u660E\u4E0E\u6E90\u7801\u3002\u53EA\u7528\u6765\u5B66\u6280\u6CD5\uFF08\u5F15\u64CE\u3001\u7B14\u5237\u3001rig\u3001shader\u3001\u540E\u671F\uFF09 |\n| `core/` | \u98CE\u683C\u5E93\u7684\u5171\u7528\u5DE5\u5177\uFF1A`lib.js`\uFF08\u79CD\u5B50\u968F\u673A\u3001\u566A\u58F0\u3001\u7F13\u52A8\u3001\u63D2\u503C\uFF09{{if .Style.ThreeJS}}\u3001`three/post.js`\uFF08three.js \u540E\u671F\uFF09{{end}}\u3001`post/`\u3001`fonts/` |\n{{- if .Style.ThreeJS}}\n| `node_modules/three/` | demo \u7528\u5230\u7684 three.js\uFF08\u968F\u98CE\u683C\u5E93\u9501\u5B9A\u7684\u7248\u672C\uFF09 |\n{{- end}}\n| `ATTRIBUTION.md`\u3001`LICENSE` | \u6765\u6E90\u4E0E\u8BB8\u53EF |\n\n## \u7ED9\u5236\u4F5C\u7684\u8BF4\u660E\uFF08\u5B9A\u65B9\u6848\u3001\u5907\u7D20\u6750\u65F6\u8BFB\uFF09\n\n- \u5148\u5199 `treatment.md`\uFF0C\u518D\u770B `DEMO.md` \u4E0E `demo/`\uFF1Ademo \u53EA\u7528\u6765\u5B66\u6280\u6CD5\uFF08\u5F15\u64CE\u3001\u7B14\u89E6\u3001rig\u3001shader\uFF09\uFF0C\u4E0D\u501F\u5B83\u7684\u6545\u4E8B\u3001\u7ED3\u6784\u3001\u955C\u5934\u3001\u9053\u5177\u548C\u65F6\u95F4\u7EBF\u3002\u4EE5\u771F\u5B9E\u7D20\u6750\u4E3A\u672C\u7684\u98CE\u683C\uFF08\u526A\u8F91\u4E0E\u7EAA\u5B9E\u3001\u5B9E\u8BC1\u5F71\u50CF\uFF09\u4F8B\u5916\uFF1A\u5148\u6309 STYLE.md \u6536\u96C6\u5E76\u767B\u8BB0\u7D20\u6750\uFF0C\u518D\u5199 treatment\u3002\n- STYLE.md \u70B9\u540D\u7684\u5B57\u4F53\u4E0D\u968F\u98CE\u683C\u5E93\u4E0B\u53D1\uFF0C\u6309\u5236\u4F5C\u63D0\u793A\u8BCD\u300C\u6574\u7247\u98CE\u683C\u300D\u4E00\u8282\u7684\u529E\u6CD5\u4ECE Google Fonts \u53D6\u3002`core/fonts/` \u91CC\u7684\u4E2D\u6587\u5C55\u793A\u5B57\u4F53\u53EA\u6709\u7EA6 200 \u4E2A\u5B57\uFF0C\u4E0D\u80FD\u7528\u4E8E\u4E2D\u6587\u6B63\u6587\u3002\n- STYLE.md \u7684 Sound palette \u53EA\u4F5C\u4E3A\u9009\u66F2\u65B9\u5411\u7684\u53C2\u8003\uFF1B\u98CE\u683C\u5E93\u81EA\u5E26\u7684\u914D\u4E50\u5DE5\u5177\u6CA1\u6709\u63A5\u5165\u3002\n\n## \u89C4\u5219\uFF08\u6E32\u67D3\u955C\u5934\u65F6\uFF09\n\n1. **\u5148\u8BFB `STYLE.md` \u5168\u6587\u518D\u52A8\u624B\u3002** \u5B83\u89C4\u5B9A\u7684\u5916\u89C2\u3001\u6750\u8D28\u3001\u914D\u8272\u903B\u8F91\u3001\u5B57\u4F53\u3001\u52A8\u6548\u8D28\u611F\u3001\u955C\u5934\u8BED\u6CD5\u3001\u6807\u5FD7\u624B\u6CD5\u4E0E\u7981\u5FCC\u5168\u90E8\u9075\u5B88\u3002\u672C\u955C\u5934\u63D0\u793A\u8BCD\u91CC\u7684\u300C\u5168\u7247\u914D\u8272\u300D\u82E5\u4E0E STYLE.md \u7684\u914D\u8272\u903B\u8F91\u51B2\u7A81\uFF0C\u4EE5\u5168\u7247\u914D\u8272\u4E3A\u51C6\u2014\u2014\u5B83\u662F\u5728 STYLE.md \u7684\u914D\u8272\u903B\u8F91\u91CC\u4E3A\u672C\u7247\u9009\u5B9A\u7684\u3002\n2. **\u5185\u5BB9\u6765\u81EA\u672C\u955C\u5934\uFF0C\u4E0D\u6765\u81EA demo\u3002** \u753B\u4EC0\u4E48\u3001\u8BB2\u4EC0\u4E48\u3001\u51FA\u73B0\u54EA\u4E9B\u7269\u4EF6\uFF0C\u53EA\u53D6\u672C\u955C\u5934\u7684 prompt.md\u3001\u5B57\u5E55\u4E0E\u7D20\u6750\u3002\u4E0D\u7167\u642C demo \u7684\u6545\u4E8B\u3001\u955C\u5934\u3001\u9053\u5177\u3001\u6587\u6848\u3001\u65F6\u95F4\u7EBF\u548C\u89D2\u8272\uFF0C\u4E0D\u628A\u9898\u6750\u5F80 demo \u4E0A\u9760\u3002\n3. **demo \u662F\u6280\u6CD5\u5E93\u3002** \u9700\u8981\u5B83\u7684\u5F15\u64CE\u65F6\uFF0C\u8BFB `STYLE.md` \u7684 Engine \u4E00\u8282\u4E0E `DEMO.md`\uFF0C\u518D\u628A\u7528\u5230\u7684\u6E90\u7801\u6587\u4EF6\u62F7\u8FDB\u672C\u955C\u5934\u76EE\u5F55\u3001\u5728\u62F7\u8D1D\u4E0A\u4FEE\u6539\u3002\u4E0D\u5F97\u5728\u5408\u6210\u91CC\u5F15\u7528\u672C\u76EE\u5F55\uFF08\u955C\u5934\u76EE\u5F55\u4E4B\u5916\u7684\u8DEF\u5F84\u6E32\u67D3\u65F6\u4F1A\u9759\u9ED8 404\uFF09\u3002\n4. **\u53EA\u62F7\u4F60\u7528\u5230\u7684\u6587\u4EF6\uFF0C\u4FDD\u6301\u539F\u8DEF\u5F84\u3002** demo \u7528 `/core/lib.js`\u3001`/core/three/post.js` \u8FD9\u7C7B\u4EE5 `/` \u5F00\u5934\u7684\u8DEF\u5F84\u5F15\u7528\u5171\u7528\u5DE5\u5177\uFF1BHyperFrames \u4EE5\u955C\u5934\u76EE\u5F55\u4E3A\u6839\u63D0\u4F9B\u6587\u4EF6\uFF0C\u6240\u4EE5\u7528\u5230\u54EA\u4E2A\u5C31\u628A\u5B83\u62F7\u6210\u955C\u5934\u76EE\u5F55\u91CC\u7684\u540C\u4E00\u8DEF\u5F84\uFF08`core/lib.js`\uFF09\uFF0C\u8DEF\u5F84\u4E0D\u7528\u6539\u3002\u4E0D\u8981\u6574\u76EE\u5F55\u62F7\u8D1D\u3002\u4E0D\u8981\u6539\u672C\u76EE\u5F55\u91CC\u7684\u6587\u4EF6\uFF08\u5B83\u4EEC\u4E0E\u5176\u4ED6\u9879\u76EE\u5171\u7528\u540C\u4E00\u4EFD\uFF09\uFF0C\u6539\u52A8\u53EA\u6539\u955C\u5934\u76EE\u5F55\u91CC\u7684\u526F\u672C\u3002{{if .Style.ThreeJS}}three.js \u540C\u7406\uFF1A`node_modules/three/` \u91CC\u53EA\u6709 demo \u7528\u5230\u7684\u6A21\u5757\uFF0C\u4F60\u7684\u4EE3\u7801 import \u4E86\u54EA\u4E9B\uFF0C\u5C31\u628A\u5B83\u4EEC\uFF08`build/three.module.js` \u52A0\u4E0A\u7528\u5230\u7684 `examples/jsm/\u2026`\uFF0C\u8FDE\u540C\u5B83\u4EEC\u76F8\u5BF9\u5F15\u7528\u7684\u6587\u4EF6\uFF09\u62F7\u8FDB\u955C\u5934\u76EE\u5F55\u7684 `node_modules/three/` \u540C\u4E00\u8DEF\u5F84\uFF0Cimportmap \u4E0D\u7528\u6539\u3002demo \u5F15\u7528\u7684 `.hdr` \u73AF\u5883\u8D34\u56FE\u4E0D\u968F\u98CE\u683C\u5E93\u4E0B\u53D1\uFF0C\u7528 three \u7684 `RoomEnvironment` \u4EE3\u66FF\u3002{{end}}\n5. **\u9875\u9762\u5951\u7EA6\u6362\u6210 HyperFrames \u7684\u3002** demo \u9875\u9762\u5BFC\u51FA `window.render(t)`\uFF0C\u6309\u79D2\u9010\u5E27\u7ED8\u5236\u3001\u53EF\u5355\u72EC\u6E32\u67D3\u4EFB\u610F\u4E00\u5E27\u3002\u5728 HyperFrames \u91CC\u6539\u7531 `hf-seek` \u4E8B\u4EF6\u9A71\u52A8\uFF1A\u5728\u76D1\u542C\u5668\u91CC\u8C03\u7528\u540C\u4E00\u4E2A `render(e.detail.time)`\uFF0C\u6839\u5143\u7D20\u5199 `data-duration`\uFF0C\u52A0\u8F7D\u5B8C\u5148\u753B\u4E00\u6B21\u7B2C 0 \u5E27\uFF1B\u5F15\u64CE\u521D\u59CB\u5316\uFF08\u89E3\u7801\u56FE\u7247\u3001\u7F16\u8BD1 shader\u3001\u751F\u6210\u7B14\u89E6\uFF09\u8FD9\u7C7B\u5F02\u6B65\u51C6\u5907\u767B\u8BB0\u6210 `window.__hf.buildReady["<key>"]` promise\u3002\u5199\u6CD5\u4EE5 hyperframes \u6280\u80FD `references/runtimes.md` \u7684\u300CThe seek protocol\u300D\u4E3A\u51C6\u3002\u4E0D\u8981 `window.READY`\uFF0C\u4E0D\u8981 `requestAnimationFrame`\uFF0C\u4E0D\u8BFB\u771F\u5B9E\u65F6\u949F\uFF1B\u968F\u673A\u6570\u4E00\u5F8B\u7528 `core/lib.js` \u7684 `mulberry` / `hash` \u52A0\u56FA\u5B9A\u79CD\u5B50\uFF0C\u4EFB\u4F55\u4E00\u5E27\u90FD\u4E0D\u80FD\u4F9D\u8D56\u4E0A\u4E00\u5E27\u7559\u4E0B\u7684\u72B6\u6001\u3002\n6. **\u753B\u5E45\u3001\u5E27\u7387\u4E0E\u65F6\u957F\u4EE5\u672C\u955C\u5934\u63D0\u793A\u8BCD\u4E3A\u51C6\u3002** demo \u9ED8\u8BA4 1920\xD71080\u300124fps\u3002\u4ECE `innerWidth` \xD7 `innerHeight` \u6392\u7248\uFF0C\u4E0D\u5199\u6B7B 1920\xD71080\uFF1B\u7AD6\u5C4F\u8981\u6309\u7AD6\u5C4F\u91CD\u65B0\u6784\u56FE\uFF0C\u4E0D\u662F\u628A\u6A2A\u5C4F\u753B\u9762\u7F29\u5C0F\u6216\u88C1\u4E00\u5757\u3002STYLE.md \u8981\u6C42\u300C\u4E00\u62CD\u4E24\u5E27\u300D\u4E4B\u7C7B\u7684\u6B65\u8FDB\u65F6\uFF0C\u53EA\u6B65\u8FDB\u753B\u9762\u91CC\u7684\u7269\u4EF6\uFF0C\u955C\u5934\u4E0E\u5149\u7167\u4FDD\u6301\u9010\u5E27\u5E73\u6ED1\u3002\n7. **\u5B57\u4F53\u3002** STYLE.md \u70B9\u540D\u7684\u5B57\u4F53\u7531\u4E0A\u5C42\u653E\u8FDB\u955C\u5934\u76EE\u5F55\uFF1B\u955C\u5934\u76EE\u5F55\u91CC\u6CA1\u6709\u65F6\uFF0C\u7528\u955C\u5934\u76EE\u5F55\u91CC\u5DF2\u6709\u7684\u5B57\u4F53\u5E76\u5728\u6C47\u62A5\u91CC\u8BF4\u660E\uFF0C\u4E0D\u5F97\u6539\u7528\u672C\u673A\u7CFB\u7EDF\u5B57\u4F53\u6216 `local()`\u3002\u4E2D\u6587\u8981\u6709\u4E2D\u6587\u5B57\u4F53\u8986\u76D6\uFF1A`core/fonts/` \u91CC\u7684\u4E2D\u6587\u5C55\u793A\u5B57\u4F53\u53EA\u6709\u7EA6 200 \u4E2A\u5B57\uFF0C\u4E0D\u80FD\u7528\u4E8E\u6B63\u6587\u3002\u5B57\u5E55\u7684\u5B57\u4F53\u4E0E\u6837\u5F0F\u6309 STYLE.md \u7684 Type & subtitles\uFF0C\u70E7\u5F55\u4ECD\u7528\u955C\u5934\u5DE5\u5177\u5E93\u7684 `SceneKit.captions`\u3002\n8. **\u58F0\u97F3\u4E00\u8282\u5BF9\u955C\u5934\u65E0\u6548\u3002** \u955C\u5934\u4EA7\u7269\u5FC5\u987B\u9759\u97F3\u3001\u65E0\u97F3\u8F68\uFF1BSTYLE.md \u7684 Sound palette \u7531\u4E0A\u5C42\u914D\u4E50\u65F6\u4F7F\u7528\u3002\n9. **\u80F6\u7247\u9897\u7C92\u4E0D\u753B\u8FDB\u9875\u9762\u3002** lemo \u5728\u5408\u6210\u6210\u7247\u65F6\u7528 ffmpeg \u52A0\u9897\u7C92\uFF1B\u9897\u7C92\u753B\u8FDB\u9875\u9762\u4F1A\u8BA9\u6BCF\u4E00\u5E27\u90FD\u65E0\u6CD5\u538B\u7F29\u3001\u6E32\u67D3\u53D8\u6162\u3002STYLE.md \u5199\u4E86\u9897\u7C92\u65F6\uFF0C\u672C\u955C\u5934\u7701\u7565\u5B83\u3002\n10. **\u771F\u5B9E\u7D20\u6750\u53EA\u7528\u7ED9\u5230\u7684\u3002** \u526A\u8F91\u4E0E\u7EAA\u5B9E\u3001\u5B9E\u8BC1\u5F71\u50CF\u8FD9\u7C7B\u4EE5\u771F\u5B9E\u7D20\u6750\u4E3A\u672C\u7684\u98CE\u683C\uFF0C\u53EA\u7528\u955C\u5934\u76EE\u5F55\u91CC\u5DF2\u6709\u7684\u7D20\u6750\u4E0E\u6570\u636E\uFF0C\u4E0D\u81EA\u884C\u4E0B\u8F7D\uFF0C\u4E0D\u7F16\u9020\u6570\u5B57\u4E0E\u51FA\u5904\u3002\n';

// ../engine/src/filmstyle/lemo/select.ts
var import_node_fs8 = __toESM(require("node:fs"), 1);
var import_node_path9 = __toESM(require("node:path"), 1);
function sourceTexts(skillDir2) {
  const out = /* @__PURE__ */ new Map();
  const walk = (dir, rel) => {
    for (const entry of sortedEntries2(dir)) {
      const file = import_node_path9.default.join(dir, entry.name);
      const childRel = rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "assets" && rel === "core") continue;
        walk(file, childRel);
        continue;
      }
      switch (goExt(entry.name).toLowerCase()) {
        case ".js":
        case ".mjs":
        case ".html":
        case ".json":
          break;
        default:
          continue;
      }
      out.set(childRel, import_node_fs8.default.readFileSync(file, "utf8"));
    }
  };
  for (const sub of ["demo", "core"]) {
    const root = import_node_path9.default.join(skillDir2, sub);
    let stat;
    try {
      stat = import_node_fs8.default.statSync(root);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    walk(root, sub);
  }
  return out;
}
var specifierPattern = /(?:\bfrom[\t\n\f\r ]*|\bimport[\t\n\f\r ]*\([\t\n\f\r ]*|\bimport[\t\n\f\r ]+)['"]([^'"]+)['"]/g;
function specifiers(text) {
  return [...text.matchAll(specifierPattern)].map((match) => match[1]);
}
function isRegularFile(file) {
  try {
    return import_node_fs8.default.statSync(file).isFile();
  } catch {
    return false;
  }
}
function threeClosure(threeRoot, sources2) {
  const picked = /* @__PURE__ */ new Set();
  const queue = [];
  const add = (rel) => {
    rel = goClean(rel);
    if (rel === "." || rel.startsWith("../") || picked.has(rel)) return;
    if (!isRegularFile(import_node_path9.default.join(threeRoot, rel))) return;
    picked.add(rel);
    queue.push(rel);
  };
  const resolve3 = (spec, from) => {
    if (spec === "three") add("build/three.module.js");
    else if (spec === "three/webgpu") add("build/three.webgpu.js");
    else if (spec.startsWith("three/addons/")) add("examples/jsm/" + spec.slice("three/addons/".length));
    else if (spec.startsWith("three/examples/jsm/")) add(spec.slice("three/".length));
    else if (spec.startsWith("/node_modules/three/")) add(spec.slice("/node_modules/three/".length));
    else if (from !== "" && (spec.startsWith("./") || spec.startsWith("../"))) add(goJoin(goDir(from), spec));
  };
  add("build/three.module.js");
  for (const text of sources2.values()) {
    for (const spec of specifiers(text)) resolve3(spec, "");
  }
  while (queue.length > 0) {
    const rel = queue.shift();
    const body = import_node_fs8.default.readFileSync(import_node_path9.default.join(threeRoot, rel), "utf8");
    for (const spec of specifiers(body)) resolve3(spec, rel);
  }
  return [...picked].sort(compareBytes);
}
function referencedAssets(assetsRoot, sources2) {
  let text = "";
  for (const body of sources2.values()) text += body + "\n";
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of sortedEntries2(dir)) {
      const file = import_node_path9.default.join(dir, entry.name);
      const childRel = rel === "" ? entry.name : rel + "/" + entry.name;
      if (entry.isDirectory()) {
        if (childRel.split("/").length - 1 === 1 && text.includes(entry.name)) addTree(file, childRel, out);
        else walk(file, childRel);
        continue;
      }
      const name = entry.name;
      const stem = name.slice(0, name.length - goExt(name).length);
      if (name === "SOURCES.md" || text.includes(name) || Buffer.byteLength(stem) >= 4 && text.includes(stem)) {
        if (entry.isFile()) out.push(childRel);
      }
    }
  };
  walk(assetsRoot, "");
  return out.sort(compareBytes);
}
function addTree(dir, rel, out) {
  for (const entry of sortedEntries2(dir)) {
    if (entry.isDirectory()) addTree(import_node_path9.default.join(dir, entry.name), rel + "/" + entry.name, out);
    else if (entry.isFile() && entry.name !== ".DS_Store") out.push(rel + "/" + entry.name);
  }
}

// ../engine/src/filmstyle/lemo/template.ts
var trimSet = " 	\r\n";
function trimLeft(s) {
  let i = 0;
  while (i < s.length && trimSet.includes(s[i])) i++;
  return s.slice(i);
}
function trimRight(s) {
  let i = s.length;
  while (i > 0 && trimSet.includes(s[i - 1])) i--;
  return s.slice(0, i);
}
function tokenize(name, source) {
  const tokens = [];
  let rest = source;
  let trimNext = false;
  for (; ; ) {
    const open = rest.indexOf("{{");
    let text = open < 0 ? rest : rest.slice(0, open);
    if (trimNext) text = trimLeft(text);
    if (open < 0) {
      tokens.push({ text });
      return tokens;
    }
    const close = rest.indexOf("}}", open + 2);
    if (close < 0) throw new Error(`template: ${name}: unclosed action`);
    let inner = rest.slice(open + 2, close);
    if (/^-[ \t\r\n]/.test(inner)) {
      text = trimRight(text);
      inner = inner.slice(1);
    }
    trimNext = false;
    if (/[ \t\r\n]-$/.test(inner)) {
      trimNext = true;
      inner = inner.slice(0, -1);
    }
    tokens.push({ text, action: inner.trim() });
    rest = rest.slice(close + 2);
  }
}
function parseField(name, expr) {
  if (!/^(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(expr)) throw new Error(`template: ${name}: unsupported action ${JSON.stringify(expr)}`);
  return expr.slice(1).split(".");
}
function parse(name, source) {
  const root = [];
  const stack = [root];
  for (const token of tokenize(name, source)) {
    const current = stack[stack.length - 1];
    if (token.text !== "") current.push({ kind: "text", text: token.text });
    if (token.action === void 0) continue;
    const action = token.action;
    if (action === "end") {
      if (stack.length === 1) throw new Error(`template: ${name}: unexpected {{end}}`);
      stack.pop();
    } else if (action.startsWith("if ")) {
      const node = { kind: "if", path: parseField(name, action.slice(3).trim()), body: [] };
      current.push(node);
      stack.push(node.body);
    } else {
      current.push({ kind: "field", path: parseField(name, action) });
    }
  }
  if (stack.length !== 1) throw new Error(`template: ${name}: unexpected EOF`);
  return root;
}
function resolve2(name, data, fieldPath) {
  let value = data;
  for (const field of fieldPath) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) {
      throw new Error(`template: ${name}: executing "${name}": can't evaluate field ${field}`);
    }
    value = value[field];
  }
  return value;
}
function truthy(value) {
  if (value === null || value === void 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}
function print(value) {
  if (value === null || value === void 0) return "<no value>";
  if (Array.isArray(value)) return "[" + value.map(print).join(" ") + "]";
  return String(value);
}
function execute(name, nodes, data) {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "field") out += print(resolve2(name, data, node.path));
    else if (truthy(resolve2(name, data, node.path))) out += execute(name, node.body, data);
  }
  return out;
}
function renderTemplate(name, source, data) {
  return execute(name, parse(name, source), data);
}

// ../engine/src/filmstyle/lemo/fill.ts
function fill(dir, entry, lib) {
  const source = import_node_path10.default.join(lib.dir, "styles", entry.slug);
  const place = (from, to) => copyPath(from, to, lib.managed);
  const copies = [
    { from: import_node_path10.default.join(source, "STYLE.md"), to: "STYLE.md" },
    { from: import_node_path10.default.join(source, "style.json"), to: "style.json" },
    { from: import_node_path10.default.join(source, "DEMO.md"), to: "DEMO.md" },
    { from: import_node_path10.default.join(source, "poster.jpg"), to: "poster.jpg" },
    { from: import_node_path10.default.join(lib.dir, "LICENSE"), to: "LICENSE" },
    { from: import_node_path10.default.join(source, "demo"), to: "demo" },
    { from: import_node_path10.default.join(lib.dir, "core", "lib.js"), to: "core/lib.js" },
    { from: import_node_path10.default.join(lib.dir, "core", "three"), to: "core/three" },
    { from: import_node_path10.default.join(lib.dir, "core", "post"), to: "core/post" },
    { from: import_node_path10.default.join(lib.dir, "core", "fonts"), to: "core/fonts" }
  ];
  for (const item of copies) {
    if (!pathExists(item.from)) {
      if (item.to === "STYLE.md" || item.to === "core/lib.js") throw new Error(`\u98CE\u683C\u5E93\u7F3A\u5C11 ${item.from}`);
      continue;
    }
    place(item.from, import_node_path10.default.join(dir, item.to));
  }
  const sources2 = sourceTexts(dir);
  if (demoUsesCoreAssets(import_node_path10.default.join(source, "demo"))) {
    const assets = import_node_path10.default.join(lib.dir, "core", "assets");
    if (!exists3(assets)) throw missing("\u98CE\u683C\u5E93\u7684 core/assets", entryLabel(entry) + " \u7684 demo \u8981\u7528");
    for (const rel of referencedAssets(assets, sources2)) {
      place(import_node_path10.default.join(assets, rel), import_node_path10.default.join(dir, "core", "assets", rel));
    }
  }
  if (entry.three_js) {
    const three = import_node_path10.default.join(lib.dir, "node_modules", "three");
    if (!exists3(import_node_path10.default.join(three, "build", "three.module.js"))) throw missing("\u98CE\u683C\u5E93\u7684 three.js \u4F9D\u8D56", entryLabel(entry) + " \u8981\u7528");
    const picked = threeClosure(three, sources2);
    for (const rel of ["LICENSE", "package.json", ...picked]) {
      const from = import_node_path10.default.join(three, rel);
      if (!exists3(from)) continue;
      place(from, import_node_path10.default.join(dir, "node_modules", "three", rel));
    }
  }
  renderSkill(dir, entry, lib.commit || "unknown");
}
function pathExists(file) {
  try {
    import_node_fs9.default.statSync(file);
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}
var skipExtensions = /* @__PURE__ */ new Set([".mp4", ".wav", ".mp3", ".npy", ".log"]);
function copyPath(from, to, link) {
  const visit = (file, target, name, stat, isRoot) => {
    if (stat.isDirectory()) {
      if (!isRoot && (skipInDemo.has(name) || name.startsWith("out_") || name === "__pycache__")) return;
      import_node_fs9.default.mkdirSync(target, { recursive: true });
      for (const entry of sortedEntries2(file)) {
        const child = import_node_path10.default.join(file, entry.name);
        visit(child, import_node_path10.default.join(target, entry.name), entry.name, import_node_fs9.default.lstatSync(child), false);
      }
      return;
    }
    if (stat.isSymbolicLink()) throw new Error(`\u98CE\u683C\u5E93\u91CC\u6709\u7B26\u53F7\u94FE\u63A5\uFF0C\u65E0\u6CD5\u5B89\u5168\u642C\u8FDB\u9879\u76EE\uFF1A${file}`);
    if (!stat.isFile() || name === ".DS_Store" || skipExtensions.has(goExt(name).toLowerCase())) return;
    import_node_fs9.default.mkdirSync(import_node_path10.default.dirname(target), { recursive: true });
    if (link) {
      let linked = false;
      try {
        import_node_fs9.default.linkSync(file, target);
        linked = true;
      } catch {
      }
      if (linked) {
        import_node_fs9.default.chmodSync(target, 420);
        return;
      }
    }
    import_node_fs9.default.writeFileSync(target, import_node_fs9.default.readFileSync(file), { mode: 420 });
  };
  visit(from, to, import_node_path10.default.basename(from), import_node_fs9.default.lstatSync(from), true);
}
function loadTemplates() {
  return { skill: skill_md_default, attribution: attribution_md_default };
}
function renderSkill(dir, style2, commit) {
  const short = commit.length > 12 ? commit.slice(0, 12) : commit;
  const data = {
    Style: {
      Slug: style2.slug,
      Num: style2.num,
      EN: style2.en,
      CN: style2.cn,
      CategoryEN: style2.category_en,
      CategoryCN: style2.category_cn,
      Film: style2.film,
      Line: style2.line,
      LineCN: style2.line_cn,
      Uses: style2.uses,
      DemoSeconds: style2.demo_seconds,
      ThreeJS: style2.three_js
    },
    Commit: commit,
    Short: short,
    Repo: RepoURL.replace(/\.git$/, "")
  };
  const { skill, attribution } = loadTemplates();
  for (const [name, text] of [
    ["SKILL.md", skill],
    ["ATTRIBUTION.md", attribution]
  ]) {
    let out;
    try {
      out = renderTemplate(name, text, data);
    } catch (err) {
      throw new Error(`\u751F\u6210 ${name}\uFF1A${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    import_node_fs9.default.writeFileSync(import_node_path10.default.join(dir, name), out, { mode: 420 });
  }
}

// ../engine/src/filmstyle/lemo/source.ts
var import_node_fs10 = __toESM(require("node:fs"), 1);
var lemoSource = {
  id: () => SourceID,
  name: () => `lemo-opuscar \u98CE\u683C\u5E93\uFF08LemoLab\uFF0C${PinnedStyleCount} \u79CD\uFF09`,
  gallery: () => Gallery,
  envKeys: () => [LibraryEnv],
  catalog: () => catalog2().map(entryStyle),
  location: (env) => libraryDir({ env }),
  check: (env) => {
    requireLibrary({ env });
  },
  prepare: async (opts, signal) => {
    await prepareLibrary({ env: opts.env, output: opts.output, progress: opts.progress }, signal);
  },
  poster: (env, slug) => {
    const lib = openLibrary({ env });
    const file = posterPath(lib, slug);
    try {
      import_node_fs10.default.statSync(file);
    } catch {
      throw missing("\u98CE\u683C\u6D77\u62A5", file + " \u4E0D\u5B58\u5728");
    }
    return file;
  },
  fill: (dir, style2, env) => {
    const entry = find2(style2.slug);
    if (!entry) throw new Error(`lemo-opuscar \u98CE\u683C\u5E93\u91CC\u6CA1\u6709 ${goQuote(style2.slug)}`);
    const lib = requireLibrary({ env });
    requireStyle(lib, entry);
    fill(dir, entry, lib);
    return lib.commit || "unknown";
  }
};
register(lemoSource);

// ../engine/src/preset/preset.ts
var AnchorTop = "top";
var AnchorBottom = "bottom";
var AnchorFill = "fill";

// ../engine/src/preset/table.ts
function baseSafeArea() {
  return [
    { name: "structural", leftPx: 40, rightPx: 40, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 60 },
    { name: "main_content", leftPx: 88, rightPx: 88, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 100 },
    { name: "critical_text", leftPx: 88, rightPx: 180, anchor: AnchorFill, insetTopPx: 120, insetBottomPx: 260 },
    { name: "cover_title", leftPx: 88, rightPx: 180, anchor: AnchorTop, insetTopPx: 260, heightPx: 720 },
    { name: "subtitles", leftPx: 88, rightPx: 180, anchor: AnchorBottom, insetBottomPx: 260, heightPx: 190 }
  ];
}
function verticalPlatform() {
  return {
    orientation: "\u7AD6\u5C4F",
    ui: "\u6296\u97F3\u53F3\u4FA7\u4E92\u52A8\u680F\u548C\u5E95\u90E8 UI",
    zone: "\u53F3\u4FA7\u4E92\u52A8\u680F\u548C\u5E95\u90E8 UI",
    avoidance: (critical) => `\u53F3\u4FA7 ${critical.rightPx}px \u548C\u5E95\u90E8 ${critical.bottomPx}px \u662F\u6296\u97F3\u4E92\u52A8\u680F\u4E0E\u5E95\u90E8 UI`
  };
}
function landscapeSafeArea() {
  return [
    { name: "structural", leftPx: 48, rightPx: 48, anchor: AnchorFill, insetTopPx: 40, insetBottomPx: 40 },
    { name: "main_content", leftPx: 120, rightPx: 120, anchor: AnchorFill, insetTopPx: 80, insetBottomPx: 96 },
    { name: "critical_text", leftPx: 160, rightPx: 160, anchor: AnchorFill, insetTopPx: 96, insetBottomPx: 200 },
    { name: "cover_title", leftPx: 160, rightPx: 160, anchor: AnchorTop, insetTopPx: 220, heightPx: 520 },
    { name: "subtitles", leftPx: 240, rightPx: 240, anchor: AnchorBottom, insetBottomPx: 90, heightPx: 150 }
  ];
}
function landscapePlatform() {
  return {
    orientation: "\u6A2A\u5C4F",
    ui: "\u64AD\u653E\u5668\u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761",
    zone: "\u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761",
    avoidance: (critical) => `\u5E95\u90E8 ${critical.bottomPx}px \u662F\u64AD\u653E\u5668\u63A7\u5236\u680F\u3001\u8FDB\u5EA6\u6761\u4E0E\u5F39\u5E55\u8F93\u5165\u533A`
  };
}
var landscapeLayoutNotes = `

## \u6A2A\u5C4F\u6784\u56FE\u8981\u70B9

\u672C\u9879\u76EE\u662F 16:9 \u6A2A\u5C4F\uFF081920\xD71080\uFF09\uFF0C\u753B\u9762\u7684\u4E3B\u65B9\u5411\u662F\u5DE6\u53F3\u800C\u4E0D\u662F\u4E0A\u4E0B\u3002\u98CE\u683C\u8BF4\u660E\u4E66\u91CC\u6309\u7AD6\u5C4F\u63CF\u8FF0\u7684\u7248\u5F0F\u9AA8\u67B6\uFF0C\u843D\u5230\u6A2A\u5C4F\u65F6\u6309\u4E0B\u9762\u7684\u539F\u5219\u6539\u6392\uFF1A

- \u5DE6\u53F3\u5206\u680F\u4F18\u5148\u4E8E\u4E0A\u4E0B\u5806\u53E0\uFF1A\u547D\u9898\u578B\u7528\u300C\u5DE6\u6587\u53F3\u56FE\u300D\u6216\u300C\u5DE6\u5927\u5B57\u3001\u53F3\u4E3B\u89C6\u89C9\u300D\uFF1B\u5BF9\u7167\u578B\u76F4\u63A5\u5DE6\u53F3\u5BF9\u5F00\uFF1B\u6D41\u7A0B\u578B\u6CBF\u6C34\u5E73\u65B9\u5411\u5C55\u5F00\uFF0C\u6700\u591A 5 \u6B65\uFF0C\u8D85\u8FC7\u5C31\u5206\u4E24\u884C\uFF1B\u7CFB\u7EDF\u603B\u89C8\u7528\u6A2A\u5411\u7F51\u683C\u3002
- \u4E0D\u8981\u628A\u7AD6\u5C4F\u7248\u5F0F\u539F\u6837\u5C45\u4E2D\uFF1A\u4E2D\u95F4\u4E00\u6761\u7A84\u680F\u3001\u4E24\u4FA7\u5927\u9762\u79EF\u7A7A\u767D\uFF0C\u662F\u6A2A\u5C4F\u6700\u5E38\u89C1\u7684\u300C\u6CA1\u6392\u5B8C\u300D\u3002
- \u4E00\u884C\u6587\u5B57\u4E0D\u8D85\u8FC7 22 \u4E2A\u6C49\u5B57\uFF1A\u6A2A\u5C4F\u5BBD\u5EA6\u5927\uFF0C\u5355\u884C\u8FC7\u957F\u4F1A\u8BA9\u89C6\u7EBF\u6765\u56DE\u626B\uFF0C\u5B81\u53EF\u65AD\u884C\u3002
- \u6807\u9898\u5B57\u53F7\u4EE5\u753B\u9762\u9AD8\u5EA6 1080px \u4E3A\u57FA\u51C6\uFF0C\u4E0E\u7AD6\u5C4F\u7684\u540C\u7EA7\u5B57\u53F7\u4FDD\u6301\u4E00\u81F4\uFF0C\u4E0D\u56E0\u4E3A\u753B\u9762\u53D8\u5BBD\u800C\u653E\u5927\u3002
- \u5E95\u90E8\u63A7\u5236\u680F\u4E0E\u8FDB\u5EA6\u6761\u662F\u5173\u952E\u907F\u8BA9\u533A\uFF1A\u6807\u9898\u3001\u6570\u5B57\u3001\u7ED3\u8BBA\u548C\u5B57\u5E55\u90FD\u4E0D\u5F97\u8FDB\u5165 critical_text \u4E0B\u6CBF\u4EE5\u4E0B\u7684\u533A\u57DF\uFF1B\u5B57\u5E55\u5E26\u8D34\u5728\u8FDB\u5EA6\u6761\u4E0A\u65B9\u3002
`;
var builtin = [
  {
    id: "vertical-3x4",
    label: "3:4  \u7AD6\u5C4F  1080\xD71440",
    canvas: { widthPx: 1080, heightPx: 1440, fps: 30, orientation: "vertical" },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: ""
  },
  {
    id: "vertical-9x16",
    label: "9:16 \u7AD6\u5C4F  1080\xD71920",
    canvas: { widthPx: 1080, heightPx: 1920, fps: 30, orientation: "vertical" },
    safeArea: baseSafeArea(),
    platform: verticalPlatform(),
    layoutNotes: ""
  },
  {
    id: "landscape-16x9",
    label: "16:9 \u6A2A\u5C4F  1920\xD71080",
    canvas: { widthPx: 1920, heightPx: 1080, fps: 30, orientation: "landscape" },
    safeArea: landscapeSafeArea(),
    platform: landscapePlatform(),
    layoutNotes: landscapeLayoutNotes
  }
];

// ../engine/src/preset/fonts.ts
var font = (file, family, weight, license) => ({ file, family, weight, license });
var FontNotoSerifSC400 = font("noto-serif-sc-400.woff2", "Noto Serif SC", 400, "LICENSE-noto-serif-sc.txt");
var FontNotoSerifSC700 = font("noto-serif-sc-700.woff2", "Noto Serif SC", 700, "LICENSE-noto-serif-sc.txt");
var FontLXGWWenKai400 = font("lxgw-wenkai-400.woff2", "LXGW WenKai", 400, "LICENSE-lxgw-wenkai.txt");
var FontXiaolai400 = font("xiaolai-400.woff2", "Xiaolai", 400, "LICENSE-xiaolai.txt");
var FontSmileySans400 = font("smiley-sans-oblique.woff2", "Smiley Sans", 400, "LICENSE-smiley-sans.txt");
var FontZCOOLKuaiLe400 = font("zcool-kuaile-400.woff2", "ZCOOL KuaiLe", 400, "LICENSE-zcool-kuaile.txt");
var FontZCOOLQingKe400 = font("zcool-qingke-huangyou-400.woff2", "ZCOOL QingKe HuangYou", 400, "LICENSE-zcool-qingke-huangyou.txt");
var FontFusionPixel400 = font("fusion-pixel-12px-zh_hans.woff2", "Fusion Pixel 12px Prop zh-Hans", 400, "LICENSE-fusion-pixel.txt");
var FontPressStart2P400 = font("press-start-2p-400.woff2", "Press Start 2P", 400, "LICENSE-press-start-2p.txt");
var FontSilkscreen400 = font("silkscreen-400.woff2", "Silkscreen", 400, "LICENSE-silkscreen.txt");
var FontOrbitron = font("orbitron-variable.woff2", "Orbitron", 700, "LICENSE-orbitron.txt");
var FontChakraPetch700 = font("chakra-petch-700.woff2", "Chakra Petch", 700, "LICENSE-chakra-petch.txt");
var FontFredoka600 = font("fredoka-600.woff2", "Fredoka", 600, "LICENSE-fredoka.txt");
var FontFredoka700 = font("fredoka-700.woff2", "Fredoka", 700, "LICENSE-fredoka.txt");
var FontBungee400 = font("bungee-400.woff2", "Bungee", 400, "LICENSE-bungee.txt");
var FontCinzel700 = font("cinzel-700.woff2", "Cinzel", 700, "LICENSE-cinzel.txt");
var FontBebasNeue400 = font("bebas-neue-400.woff2", "Bebas Neue", 400, "LICENSE-bebas-neue.txt");
var FontOxanium600 = font("oxanium-600.woff2", "Oxanium", 600, "LICENSE-oxanium.txt");
var FontSpaceGrotesk500 = font("space-grotesk-500.woff2", "Space Grotesk", 500, "LICENSE-space-grotesk.txt");
var FontSpaceGrotesk700 = font("space-grotesk-700.woff2", "Space Grotesk", 700, "LICENSE-space-grotesk.txt");
var FontCaveat600 = font("caveat-600.woff2", "Caveat", 600, "LICENSE-caveat.txt");
var SharedFonts = [
  font("noto-sans-sc-400.woff2", "Noto Sans SC", 400, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-600.woff2", "Noto Sans SC", 600, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-700.woff2", "Noto Sans SC", 700, "LICENSE-Noto-Sans-SC.txt"),
  font("noto-sans-sc-900.woff2", "Noto Sans SC", 900, "LICENSE-Noto-Sans-SC.txt")
];

// ../engine/src/preset/style.ts
var style = (id, name, label, sheetBackground, fonts = []) => ({ id, name, label, sheetBackground, fonts });
var builtinStyles = [
  style("clear-system-blueprint-v1", "\u6E05\u6670\u7CFB\u7EDF\u84DD\u56FE", "\u6E05\u6670\u7CFB\u7EDF\u84DD\u56FE\uFF1A\u77E5\u8BC6\u3001\u6280\u672F\u4E0E\u4EA7\u54C1\u673A\u5236\u8BB2\u89E3", "#D5DEEB"),
  style("pixel-arcade-v1", "\u50CF\u7D20\u8857\u673A", "\u50CF\u7D20\u8857\u673A\uFF1A8/16-bit \u590D\u53E4\u6E38\u620F\u3001\u6000\u65E7\u3001\u5165\u95E8\u79D1\u666E", "#1B1B2F", [FontFusionPixel400, FontPressStart2P400, FontSilkscreen400]),
  style("scifi-hud-v1", "\u79D1\u5E7BHUD", "\u79D1\u5E7B HUD\uFF1A\u822A\u5929\u3001\u786C\u4EF6\u3001\u7CFB\u7EDF\u67B6\u6784\u3001\u4EFB\u52A1\u5F0F\u8BB2\u89E3", "#0A1622", [FontOrbitron]),
  style("cyberpunk-glitch-v1", "\u8D5B\u535A\u6545\u969C", "\u8D5B\u535A\u6545\u969C\uFF1A\u5B89\u5168\u653B\u9632\u3001\u9ED1\u5BA2\u53D9\u4E8B\u3001\u53CD\u5DEE\u89C2\u70B9", "#120B1E", [FontSmileySans400, FontChakraPetch700]),
  style("candy-casual-v1", "\u7CD6\u679C\u4F11\u95F2", "\u7CD6\u679C\u4F11\u95F2\u624B\u6E38\uFF1A\u8F7B\u677E\u79D1\u666E\u3001\u751F\u6D3B\u6280\u5DE7\u3001\u6210\u957F\u6FC0\u52B1", "#FFE3EE", [FontZCOOLKuaiLe400, FontFredoka600, FontFredoka700]),
  style("rebel-graphic-v1", "\u4E8C\u6B21\u5143\u9510\u5229\u62FC\u8D34", "\u4E8C\u6B21\u5143\u9510\u5229\u62FC\u8D34\uFF1A\u5F3A\u89C2\u70B9\u3001\u6392\u884C\u3001\u89D2\u8272\u5316\u8868\u8FBE", "#111111", [FontZCOOLQingKe400, FontBungee400]),
  style("fantasy-quest-v1", "\u5947\u5E7B\u7F8A\u76AE\u5377", "\u5947\u5E7B\u7F8A\u76AE\u5377\uFF1A\u5386\u53F2\u3001\u6545\u4E8B\u3001\u5B66\u4E60\u8DEF\u7EBF\u3001\u4E16\u754C\u89C2", "#3B2A1A", [FontNotoSerifSC400, FontNotoSerifSC700, FontCinzel700]),
  style("esports-broadcast-v1", "\u7535\u7ADE\u8D5B\u4E8B\u8F6C\u64AD", "\u7535\u7ADE\u8D5B\u4E8B\u8F6C\u64AD\uFF1A\u5BF9\u6BD4\u8BC4\u6D4B\u3001\u6392\u884C\u699C\u3001\u6570\u636E\u6218\u62A5", "#0B0F1A", [FontBebasNeue400, FontOxanium600]),
  style("visual-novel-v1", "\u89C6\u89C9\u5C0F\u8BF4\u5BF9\u8BDD", "\u89C6\u89C9\u5C0F\u8BF4\u5BF9\u8BDD\uFF1A\u6545\u4E8B\u3001\u5BF9\u8BDD\u4F53\u3001\u60C5\u611F\u4E0E\u4EBA\u7269", "#2A2238", [FontLXGWWenKai400]),
  style("neon-data-dark-v1", "\u6697\u591C\u6570\u636E\u9713\u8679", "\u6697\u591C\u6570\u636E\u9713\u8679\uFF1AAI\u3001\u524D\u6CBF\u6280\u672F\u3001\u6570\u636E\u4E0E\u6307\u6807", "#070A12", [FontSpaceGrotesk500, FontSpaceGrotesk700]),
  style("editorial-magazine-v1", "\u6742\u5FD7\u7F16\u8F91\u6392\u7248", "\u6742\u5FD7\u7F16\u8F91\u6392\u7248\uFF1A\u89C2\u70B9\u3001\u4EBA\u6587\u3001\u5546\u4E1A\u8BC4\u8BBA", "#E8E2D6", [FontNotoSerifSC400, FontNotoSerifSC700]),
  style("whiteboard-doodle-v1", "\u767D\u677F\u624B\u7ED8", "\u767D\u677F\u624B\u7ED8\uFF1A\u6559\u7A0B\u3001\u6982\u5FF5\u62C6\u89E3\u3001\u8BFE\u5802\u8BB2\u89E3", "#E9ECEF", [FontXiaolai400, FontCaveat600]),
  style("anime-cel-v1", "\u65E5\u7CFB\u52A8\u6F2B", "\u65E5\u7CFB\u52A8\u6F2B\uFF1A\u756A\u5267\u611F\u79D1\u666E\u3001\u6210\u957F\u4E0E\u6311\u6218\u3001\u8F7B\u5FEB\u6545\u4E8B", "#8FD3FF", [FontSmileySans400, FontBebasNeue400])
];
var DraftStyleID = "custom-draft";
var CustomStyle = Object.freeze({
  id: DraftStyleID,
  name: "\u81EA\u5B9A\u4E49",
  label: "\u81EA\u5B9A\u4E49\uFF1A\u65E7\u7248\u53C2\u6570\uFF08\u4E0D\u9650\u5236\u65B0\u955C\u5934\u89C6\u89C9\uFF09",
  sheetBackground: "#F5F7FB",
  fonts: []
});

// src/canvas.ts
function padRight(s, width) {
  const n = [...s].length;
  return n >= width ? s : s + " ".repeat(width - n);
}

// src/filmstyle.ts
function sourceSummary() {
  return sources().map((source) => {
    let line = "  " + source.id() + "  " + source.name();
    if (source.gallery() !== "") line += "\uFF0C\u56FE\u9274 " + source.gallery();
    return line;
  }).join("\n");
}
function manifestJSON(m) {
  return { source: m.source, slug: m.slug, cn: m.cn, en: m.en, version: m.version, digest: m.digest, installed_at: m.installed_at };
}
function shortCommit(commit) {
  return commit.length > 12 ? commit.slice(0, 12) : commit;
}
function newFilmStyleCommand(stdout, _stderr) {
  const projectRoot = ref("");
  const filmCmd = new Command({
    use: "film-style",
    short: "\u6574\u7247\u98CE\u683C\uFF1A\u4ECE\u98CE\u683C\u6765\u6E90\u91CC\u6311\u4E00\u79CD\u753B\u9762\u98CE\u683C\u7528\u4E8E\u5168\u7247",
    long: `\u6574\u7247\u98CE\u683C\u662F\u53EF\u9009\u7684\u3002\u9879\u76EE\u6CA1\u6709\u6574\u7247\u98CE\u683C\u65F6\uFF0C\u6BCF\u4E2A\u955C\u5934\u81EA\u4E3B\u51B3\u5B9A\u89C6\u89C9\uFF1B\u88C5\u4E86\u6574\u7247\u98CE\u683C\u540E\uFF0C
\u6240\u6709\u955C\u5934\u753B\u6210\u540C\u4E00\u79CD\u98CE\u683C\uFF1A\u955C\u5934\u63D0\u793A\u8BCD\u628A\u300C\u89C6\u89C9\u81EA\u7531\u5EA6\u300D\u6362\u6210\u300C\u6574\u7247\u98CE\u683C\u300D\uFF0C\u6E32\u67D3\u5668\u5FC5\u987B
\u9075\u5B88\u8BE5\u98CE\u683C STYLE.md \u7684\u4E0D\u53D8\u91CF\uFF0C\u6545\u4E8B\u4E0E\u5185\u5BB9\u4ECD\u6765\u81EA\u6BCF\u4E2A\u955C\u5934\u81EA\u5DF1\u7684\u6587\u6848\u3002

\u98CE\u683C\u6765\u81EA\u98CE\u683C\u6765\u6E90\uFF0C\u6BCF\u79CD\u98CE\u683C\u7684\u6807\u8BC6\u662F\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D\uFF1B\u540D\u5B57\u5728\u5404\u6765\u6E90\u91CC\u552F\u4E00\u65F6\u4E5F\u53EF\u4EE5\u53EA\u5199
\u76EE\u5F55\u540D\u3001\u4E2D\u6587\u540D\u6216\u82F1\u6587\u540D\u3002\u5DF2\u767B\u8BB0\u7684\u6765\u6E90\uFF1A
` + sourceSummary() + `

\u88C5\u8FDB\u9879\u76EE\u7684\u843D\u5728 .agents/skills/` + SkillName + `/\uFF1ASTYLE.md\uFF08\u4E0D\u53D8\u91CF\uFF09\u3001SKILL.md\uFF08\u600E\u4E48\u7528\u3001
\u6280\u6CD5\u53C2\u8003\u5728\u54EA\uFF09\u4E0E ` + ManifestFile + `\uFF08\u6765\u6E90\u4E0E\u7248\u672C\uFF09\uFF0C\u9879\u76EE\u6574\u4F53\u62F7\u8D70\u4E5F\u80FD\u6E32\u67D3\u3002
\u5404\u6765\u6E90\u7684\u6570\u636E\u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u7531 am setup \u4E0B\u8F7D\uFF1B\u672C\u7EC4\u547D\u4EE4\u90FD\u4E0D\u8054\u7F51\u3002`
  });
  filmCmd.persistentFlags().stringVar(projectRoot, "project-root", "", "\u9879\u76EE\u6839\u76EE\u5F55\uFF0C\u7F3A\u7701\u4E3A\u5F53\u524D\u76EE\u5F55");
  const root = () => {
    const abs = import_node_path11.default.resolve(projectRoot.value || ".");
    if (!import_node_fs11.default.existsSync(import_node_path11.default.join(abs, "article-to-motion.conf"))) {
      throw new Error(`${abs} \u4E0D\u662F am \u9879\u76EE\uFF08\u7F3A\u5C11 article-to-motion.conf\uFF09\uFF0C\u7528 --project-root \u6307\u5411\u9879\u76EE\u6839\u76EE\u5F55`);
    }
    return abs;
  };
  const listJSON = ref(false);
  const listSource = ref("");
  const listCmd = new Command({
    use: "list",
    args: noArgs,
    short: "\u5217\u51FA\u5404\u98CE\u683C\u6765\u6E90\u91CC\u7684\u5168\u90E8\u98CE\u683C",
    long: `\u6309\u6765\u6E90\u3001\u518D\u6309\u5206\u7C7B\u5217\u51FA\u5168\u90E8\u98CE\u683C\uFF1A\u6807\u8BC6\uFF08\u6765\u6E90/\u76EE\u5F55\u540D\uFF09\u3001\u4E2D\u6587\u540D\u3001\u82F1\u6587\u540D\u3001\u9002\u7528\u9898\u6750\u4E0E\u8BF4\u660E\u3002
\u4E0D\u8054\u7F51\u3002--source \u53EA\u5217\u4E00\u4E2A\u6765\u6E90\uFF1B--json \u8F93\u51FA\u673A\u5668\u53EF\u8BFB\u7684\u5217\u8868\u3002`,
    example: `  am film-style list
  am film-style list --source lemo-opuscar
  am film-style list --json`,
    runE: () => {
      let sources2 = sources();
      if (listSource.value !== "") {
        const source = sourceByID(listSource.value);
        if (!source) throw new Error(`\u6CA1\u6709\u98CE\u683C\u6765\u6E90 ${goQuote(listSource.value)}\u3002\u5DF2\u767B\u8BB0\uFF1A
${sourceSummary()}`);
        sources2 = [source];
      }
      if (listJSON.value) {
        const styles = sources2.flatMap((source) => source.catalog());
        stdout.write(encodeLine(styles.length ? styles : null, { indent: "  " }));
        return;
      }
      let current = "";
      try {
        const { manifest, ok } = installed(root());
        if (ok) current = manifestKey(manifest);
      } catch {
      }
      for (const source of sources2) {
        stdout.write(`== ${source.id()}  ${source.name()}
`);
        if (source.gallery() !== "") stdout.write(`   \u56FE\u9274\uFF1A${source.gallery()}
`);
        const catalog3 = source.catalog();
        for (const category of categories(source.id())) {
          stdout.write(`${category}
`);
          for (const style2 of catalog3) {
            if (style2.category_cn !== category) continue;
            const mark = styleKey(style2) === current ? "*" : " ";
            const extra = style2.tags && style2.tags.length > 0 ? "  [" + style2.tags.join(", ") + "]" : "";
            stdout.write(` ${mark} ${padRight(styleKey(style2), 34)} ${style2.cn} ${style2.en}${extra}
`);
            stdout.write(`      \u9002\u5408\uFF1A${(style2.uses ?? []).join(", ")}\uFF1B${style2.summary}
`);
          }
        }
        stdout.write("\n");
      }
      if (current !== "") stdout.write("* \u4E3A\u672C\u9879\u76EE\u5F53\u524D\u7684\u6574\u7247\u98CE\u683C\n");
    }
  });
  listCmd.flags().boolVar(listJSON, "json", false, "\u4EE5 JSON \u8F93\u51FA");
  listCmd.flags().stringVar(listSource, "source", "", "\u53EA\u5217\u4E00\u4E2A\u98CE\u683C\u6765\u6E90");
  filmCmd.addCommand(listCmd);
  const replace = ref(false);
  const useCmd = new Command({
    use: "use STYLE",
    args: exactArgs(1, "STYLE"),
    short: "\u628A\u4E00\u79CD\u98CE\u683C\u88C5\u6210\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C",
    long: `STYLE \u5199\u6210\u300C\u6765\u6E90/\u76EE\u5F55\u540D\u300D\uFF0C\u6216\u8005\u5728\u5404\u6765\u6E90\u91CC\u552F\u4E00\u7684\u76EE\u5F55\u540D\u3001\u4E2D\u6587\u540D\u3001\u82F1\u6587\u540D\u3002\u4E0D\u8054\u7F51\uFF1A
\u6765\u6E90\u6570\u636E\u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u5148\u8FD0\u884C am setup \u51C6\u5907\u597D\uFF0C\u8FD9\u91CC\u53EA\u88C5\u8FDB\u9879\u76EE\u3002

\u9879\u76EE\u5DF2\u6709\u53E6\u4E00\u79CD\u6574\u7247\u98CE\u683C\u65F6\u9ED8\u8BA4\u62D2\u7EDD\uFF1A\u6362\u98CE\u683C\u4F1A\u8BA9\u5168\u90E8\u955C\u5934\u7684\u8F93\u5165\u6307\u7EB9\u53D8\u5316\uFF0C
\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u90FD\u8981\u91CD\u6E32\u67D3\u3002\u786E\u8BA4\u8981\u6362\u5C31\u52A0 --replace\u3002\u540C\u4E00\u79CD\u98CE\u683C\u91CD\u590D\u6267\u884C\u662F\u5E42\u7B49\u7684\u3002`,
    example: `  am film-style use lemo-opuscar/impasto
  am film-style use \u6CB9\u753B\u539A\u6D82
  am film-style use "Swiss Motion Graphics" --replace`,
    runE: (_cmd, args) => {
      const dir = root();
      const style2 = lookup(args[0]);
      const result = install({ projectDir: dir, style: style2, env: currentEnvironment(), replace: replace.value });
      reportFilmStyle(stdout, style2, result);
    }
  });
  useCmd.flags().boolVar(replace, "replace", false, "\u5141\u8BB8\u6362\u6389\u9879\u76EE\u5DF2\u6709\u7684\u53E6\u4E00\u79CD\u6574\u7247\u98CE\u683C");
  filmCmd.addCommand(useCmd);
  const showJSON = ref(false);
  const showCmd = new Command({
    use: "show",
    args: noArgs,
    short: "\u663E\u793A\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C\u4E0E\u5404\u98CE\u683C\u6765\u6E90\u7684\u72B6\u6001",
    long: `\u663E\u793A\u672C\u9879\u76EE\u88C5\u7684\u6574\u7247\u98CE\u683C\uFF08\u6765\u6E90\u3001\u540D\u5B57\u3001\u7248\u672C\u3001\u6280\u80FD\u76EE\u5F55\uFF09\uFF0C\u4EE5\u53CA\u5404\u98CE\u683C\u6765\u6E90\u7684\u6570\u636E\u662F\u5426\u5DF2\u7531
am setup \u51C6\u5907\u597D\u3002\u4E0D\u8054\u7F51\u3001\u4E0D\u6539\u4EFB\u4F55\u6587\u4EF6\u3002--json \u8F93\u51FA\u673A\u5668\u53EF\u8BFB\u7684\u540C\u4E00\u4EFD\u4FE1\u606F\u3002`,
    example: `  am film-style show
  am film-style show --json`,
    runE: () => {
      const dir = root();
      const { manifest, ok: isInstalled } = installed(dir);
      const env = currentEnvironment();
      const skillDirPath = isInstalled ? installedDir(dir) : "";
      const sources2 = sources().map((source) => {
        let ready = true;
        let problem = "";
        try {
          source.check(env);
        } catch (err) {
          ready = false;
          problem = err.message;
        }
        return { id: source.id(), name: source.name(), location: source.location(env), ready, problem: problem || void 0 };
      });
      if (showJSON.value) {
        stdout.write(
          encodeLine(
            {
              installed: isInstalled,
              style: isInstalled ? manifestJSON(manifest) : void 0,
              skill_dir: skillDirPath || void 0,
              sources: sources2.length ? sources2 : null
            },
            { indent: "  " }
          )
        );
        return;
      }
      if (isInstalled) {
        stdout.write(`\u6574\u7247\u98CE\u683C\uFF1A${manifest.cn} ${manifest.en}\uFF08${manifestKey(manifest)}\uFF09\uFF0C\u7248\u672C ${shortCommit(manifest.version)}
\u6280\u80FD\u76EE\u5F55\uFF1A${skillDirPath}
`);
        if (manifest.legacy) stdout.write("\uFF08\u65E7\u7248\u76EE\u5F55\uFF1B\u518D\u8FD0\u884C\u4E00\u6B21 am film-style use \u4F1A\u6362\u6210\u65B0\u76EE\u5F55\uFF09\n");
      } else {
        stdout.write("\u6574\u7247\u98CE\u683C\uFF1A\u65E0\uFF08\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9\uFF09\u3002\u7528 am film-style list \u67E5\u770B\u53EF\u9009\u98CE\u683C\n");
      }
      for (const item of sources2) {
        const state = item.ready ? "\u5DF2\u5C31\u7EEA" : "\u672A\u51C6\u5907\uFF08\u8FD0\u884C am setup\uFF09";
        stdout.write(`\u98CE\u683C\u6765\u6E90 ${item.id}\uFF1A${state}\uFF0C${item.location}
`);
      }
    }
  });
  showCmd.flags().boolVar(showJSON, "json", false, "\u4EE5 JSON \u8F93\u51FA");
  filmCmd.addCommand(showCmd);
  filmCmd.addCommand(
    new Command({
      use: "remove",
      args: noArgs,
      short: "\u53BB\u6389\u672C\u9879\u76EE\u7684\u6574\u7247\u98CE\u683C\uFF0C\u56DE\u5230\u5404\u955C\u5934\u81EA\u4E3B\u5B9A\u89C6\u89C9",
      long: `\u5220\u9664 .agents/skills/` + SkillName + `/\uFF08\u4EE5\u53CA\u65E7\u7248\u76EE\u5F55\uFF09\u3002\u955C\u5934\u63D0\u793A\u8BCD\u968F\u4E4B\u56DE\u5230\u300C\u89C6\u89C9\u81EA\u7531\u5EA6\u300D\uFF0C
\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u8F93\u5165\u6307\u7EB9\u53D8\u5316\u3001\u4F1A\u88AB\u5224\u4E3A Stale\uFF0C\u8981\u91CD\u6E32\u67D3\u3002\u98CE\u683C\u6765\u6E90\u7684\u6570\u636E\u4E0D\u52A8\u3002`,
      example: "  am film-style remove",
      runE: () => {
        const { manifest, had } = remove(root());
        if (!had) {
          stdout.write("\u672C\u9879\u76EE\u6CA1\u6709\u6574\u7247\u98CE\u683C\n");
          return;
        }
        stdout.write(`\u5DF2\u53BB\u6389\u6574\u7247\u98CE\u683C ${manifest.cn} ${manifest.en}\uFF1B\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u4F1A\u88AB\u5224\u4E3A Stale
`);
      }
    })
  );
  return filmCmd;
}
function reportFilmStyle(stdout, style2, result) {
  if (result.unchanged) stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u662F ${styleLabel(style2)}\uFF0C\u672A\u6539\u52A8
`);
  else if (result.replaced) stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u4ECE ${result.replaced} \u6362\u6210 ${styleLabel(style2)}\uFF1B\u5DF2\u6E32\u67D3\u7684\u955C\u5934\u4F1A\u88AB\u5224\u4E3A Stale
`);
  else stdout.write(`\u6574\u7247\u98CE\u683C\u5DF2\u8BBE\u4E3A ${styleLabel(style2)}\uFF08\u7248\u672C ${shortCommit(result.manifest.version)}\uFF09
`);
}

// src/hyperframes.ts
var import_node_child_process3 = require("node:child_process");
function newHyperframesCommand(stdout, stderr) {
  return new Command({
    use: "hyperframes [ARGS...]",
    short: "\u8FD0\u884C am \u7BA1\u7406\u7684\u56FA\u5B9A\u7248\u672C HyperFrames CLI",
    long: `\u7528\u56FA\u5B9A\u7248\u672C ` + hyperframesVersion + ` \u7684 HyperFrames CLI \u6267\u884C ARGS\uFF0C\u5DE5\u4F5C\u76EE\u5F55\u4E0D\u53D8\uFF0C\u9000\u51FA\u7801\u900F\u4F20\u3002

CLI \u662F\u524D\u7F6E\u8D44\u6E90\uFF0C\u7531 am setup \u88C5\u5728\u7528\u6237\u7EA7\u76EE\u5F55\uFF08\u9ED8\u8BA4 ~/.local/share/am/hyperframes/cli-` + hyperframesVersion + `\uFF0C
\u53EF\u7528 ` + CLIDirEnv + ` \u6307\u5B9A\uFF09\uFF0C\u6240\u6709\u9879\u76EE\u5171\u7528\u3002\u8FD9\u91CC\u53EA\u7528\u4E0D\u88C5\uFF1A\u6CA1\u88C5\u597D\u5C31\u62A5\u9519\uFF0C
\u63D0\u793A\u5148\u8FD0\u884C am setup\u3002

\u6E32\u67D3\u5668\u548C\u7F16\u6392\u5DE5\u5177\u8C03\u7528 CLI \u4E00\u5F8B\u5199\u6210 am hyperframes <\u5B50\u547D\u4EE4>\uFF0C\u4E0D\u8981\u7528 npx\uFF1Anpx \u4F1A\u5728
\u6E32\u67D3\u9014\u4E2D\u73B0\u4E0B\u8F7D\uFF0C\u7F51\u7EDC\u4E0D\u597D\u65F6\u6574\u6B21\u6E32\u67D3\u767D\u8DD1\u3002`,
    example: `  am hyperframes lint
  am hyperframes check --json
  am hyperframes snapshot --at 1.5 --describe false
  am hyperframes render`,
    disableFlagParsing: true,
    runE: (cmd, args) => {
      const env = currentEnvironment();
      const dir = requireCLI(env);
      const spec = cliCommandFor(dir, env, args);
      return new Promise((resolve3, reject) => {
        const child = (0, import_node_child_process3.spawn)(spec.file, spec.args, { env: spec.env, stdio: ["inherit", "pipe", "pipe"], signal: cmd.context() });
        child.stdout.on("data", (chunk) => stdout.write(String(chunk)));
        child.stderr.on("data", (chunk) => stderr.write(String(chunk)));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve3();
          else if (code !== null) reject(new ExitError2(code, `hyperframes \u9000\u51FA\u7801 ${code}`));
          else reject(new Error("signal: killed"));
        });
      });
    }
  });
}

// src/setup.ts
var import_node_fs12 = __toESM(require("node:fs"), 1);
var import_node_path12 = __toESM(require("node:path"), 1);

// ../engine/src/prereqs/index.ts
function hyperframesStage(p) {
  if (p.indeterminate || p.percent <= 0 || p.percent >= 100) return p.stage;
  return `${p.stage} ${Math.trunc(p.percent)}%`;
}
function items() {
  const version = PinnedVersion;
  const out = [
    {
      group: "skills",
      id: "skills",
      required: true,
      name: "HyperFrames \u6280\u80FD",
      version,
      ready: (env) => {
        const dir = defaultCacheDir(env);
        return [skillsReady(dir), dir];
      },
      prepare: (run, signal) => prepareSkills(
        { env: run.git, cacheDir: defaultCacheDir(run.base), output: run.log, progress: (p) => run.stage(hyperframesStage(p)) },
        signal
      )
    },
    {
      group: "cli",
      id: "cli",
      required: true,
      name: "HyperFrames CLI",
      version,
      ready: (env) => {
        const dir = cliDir(env, PinnedVersion);
        return [cliReady(dir, PinnedVersion), dir];
      },
      prepare: async (run, signal) => {
        await ensureCLI({ env: run.npm, output: run.log, progress: (p) => run.stage(hyperframesStage(p)) }, signal);
      }
    }
  ];
  for (const source of sources()) {
    out.push({
      group: "styles",
      id: "styles:" + source.id(),
      name: "\u6574\u7247\u98CE\u683C " + source.id(),
      version: "",
      required: false,
      ready: (env) => {
        let ok = true;
        try {
          source.check(env);
        } catch {
          ok = false;
        }
        return [ok, source.location(env)];
      },
      // 来源可能既用 git 又用 npm：git 的代理与 npm 的源合在一份环境里。
      prepare: (run, signal) => source.prepare({ env: run.mixed, output: run.log, progress: (p) => run.stage(`(${p.step}/${p.steps}) ${p.stage}`) }, signal)
    });
  }
  return out;
}

// src/setupview.ts
var import_node_os3 = __toESM(require("node:os"), 1);
var spinnerFrames = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var SetupView = class {
  constructor(out, names, versions, tty = false) {
    this.out = out;
    this.tty = tty;
    this.color = this.tty && !process.env.NO_COLOR && process.env.TERM !== "dumb";
    this.items = names.map((name, i) => ({ name, version: versions[i], state: 0 /* Pending */, detail: "", started: 0, ended: 0, lastPrinted: "" }));
  }
  out;
  tty;
  items;
  drawn = 0;
  frame = 0;
  timer;
  color;
  /** 开始重画（终端里每 100 毫秒一次）。 */
  start() {
    if (!this.tty) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 100);
  }
  /** 停止重画并画最后一次。 */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = void 0;
    if (this.tty) this.redraw();
  }
  /** 改一项的状态与进展说明。 */
  set(index, state, detail) {
    const item = this.items[index];
    if (state === 1 /* Running */ && item.state !== 1 /* Running */) item.started = Date.now();
    if ((state === 3 /* Done */ || state === 4 /* Failed */) && item.ended === 0) item.ended = Date.now();
    item.state = state;
    item.detail = detail;
    if (this.tty) {
      this.redraw();
      return;
    }
    const line = this.line(index);
    if (line !== item.lastPrinted) {
      item.lastPrinted = line;
      this.out.write(line + "\n");
    }
  }
  /** 标成「本来就已就绪」，不在屏幕上打行（am setup 开头先标好已就绪的项）。 */
  markReady(index) {
    this.items[index].state = 2 /* Ready */;
  }
  /** 只改进展说明（进行中的阶段）。 */
  detail(index, detail) {
    this.set(index, this.items[index].state, detail);
  }
  redraw() {
    let b = this.drawn > 0 ? `\x1B[${this.drawn}A` : "";
    for (let i = 0; i < this.items.length; i++) b += "\r\x1B[K" + this.line(i) + "\n";
    this.drawn = this.items.length;
    this.out.write(b);
  }
  /** 列宽：名字与版本按显示宽度（中文算两列）补齐。 */
  widths() {
    let name = 0;
    let version = 0;
    for (const item of this.items) {
      name = Math.max(name, displayWidth(item.name));
      version = Math.max(version, displayWidth(item.version));
    }
    return [name, version];
  }
  line(index) {
    const item = this.items[index];
    const [nameWidth, versionWidth] = this.widths();
    let icon = "";
    let detail = "";
    switch (item.state) {
      case 0 /* Pending */:
        icon = this.paint("2", "\xB7");
        detail = this.paint("2", "\u7B49\u5F85");
        break;
      case 1 /* Running */:
        icon = this.paint("36", this.tty ? spinnerFrames[this.frame % spinnerFrames.length] : "\u203A");
        detail = item.detail;
        if (this.tty) detail += "  " + this.paint("2", clock(Date.now() - item.started));
        break;
      case 2 /* Ready */:
        icon = this.paint("32", "\u2713");
        detail = this.paint("2", "\u5DF2\u5C31\u7EEA");
        break;
      case 3 /* Done */:
        icon = this.paint("32", "\u2713");
        detail = "\u5B8C\u6210 " + this.paint("2", "\xB7 " + clock(item.ended - item.started));
        break;
      case 4 /* Failed */:
        icon = this.paint("31", "\u2717");
        detail = this.paint("31", "\u5931\u8D25");
        break;
    }
    let version = pad(item.version, versionWidth);
    if (versionWidth > 0) version = this.paint("2", version) + "  ";
    return "  " + icon + " " + pad(item.name, nameWidth) + "  " + version + detail;
  }
  paint(code, text) {
    return this.color ? `\x1B[${code}m${text}\x1B[0m` : text;
  }
};
function clock(ms) {
  const seconds = Math.floor(Math.abs(ms) / 1e3 + 0.5) * Math.sign(ms || 1);
  return `${Math.trunc(seconds / 60)}:${String(Math.abs(seconds % 60)).padStart(2, "0")}`;
}
function pad(text, width) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
var wide = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}＀-￯　-〿]/u;
function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += wide.test(ch) ? 2 : 1;
  return width;
}
function tailLines(text, n) {
  const out = [];
  const lines = text.replace(/\r/g, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].replace(/[ \t]+$/, "");
    if (line.trim() !== "") out.unshift(line);
  }
  return out;
}
function homeShort(path13) {
  const home = import_node_os3.default.homedir();
  return home && path13.startsWith(home) ? "~" + path13.slice(home.length) : path13;
}

// src/setup.ts
function newSetupCommand(stdout, _stderr) {
  const check = ref(false);
  const only = ref([]);
  const proxy = ref("");
  const npmRegistry = ref("");
  const cmd = new Command({
    use: "setup",
    args: noArgs,
    short: "\u4E0B\u8F7D\u5E76\u51C6\u5907\u5168\u90E8\u524D\u7F6E\u8D44\u6E90\uFF08HyperFrames \u6280\u80FD\u4E0E CLI\u3001\u6574\u7247\u98CE\u683C\u6765\u6E90\uFF09",
    long: `\u8981\u8054\u7F51\u7684\u4E1C\u897F\u90FD\u7531\u8FD9\u4E00\u6761\u547D\u4EE4\u51C6\u5907\uFF0C\u653E\u5728\u7528\u6237\u7EA7\u76EE\u5F55\u91CC\uFF0C\u6240\u6709\u9879\u76EE\u5171\u7528\uFF1A

  skills   HyperFrames ` + hyperframesVersion + ` \u5B98\u65B9\u6280\u80FD\uFF08git\uFF0C\u7F13\u5B58\u5728 ~/.local/share/am/hyperframes/<commit>\uFF09
  cli      HyperFrames CLI ` + hyperframesVersion + `\uFF08npm\uFF0C\u88C5\u5728 ~/.local/share/am/hyperframes/cli-<\u7248\u672C>\uFF09
  styles   \u6BCF\u4E2A\u6574\u7247\u98CE\u683C\u6765\u6E90\u4E00\u9879\uFF08styles:<\u6765\u6E90>\uFF09\uFF0C\u6570\u636E\u653E\u5728 ~/.local/share/am/film-styles/<\u6765\u6E90>\uFF1B
           \u5DF2\u767B\u8BB0\u7684\u6765\u6E90\uFF1A
` + sourceSummary() + `

\u5176\u4F59\u547D\u4EE4\uFF08am init\u3001am film-style use\u3001am scene run\u3001am hyperframes\u3001am studio\uFF09\u53EA\u68C0\u67E5
\u4E0D\u4E0B\u8F7D\uFF0C\u7F3A\u4E86\u5C31\u63D0\u793A\u5148\u8FD0\u884C am setup\u3002\u5DF2\u5C31\u7EEA\u7684\u9879\u76F4\u63A5\u8DF3\u8FC7\uFF1B\u4E0B\u8F7D\u65AD\u4E86\u518D\u8FD0\u884C\u4E00\u6B21\u4F1A\u63A5\u7740\u4E0B\u3002
git \u4E0E npm \u7684\u539F\u59CB\u8F93\u51FA\u5199\u8FDB ~/.local/share/am/setup.log\uFF0C\u5931\u8D25\u65F6\u5C4F\u5E55\u4E0A\u7ED9\u51FA\u6700\u540E\u51E0\u884C\u3002

--proxy \u53EA\u7ED9 git\uFF08GitHub\uFF09\u7528\uFF0C\u4F8B\u5982\u672C\u673A\u7684 Clash\uFF1Bnpm \u7167\u5E38\u7528\u4F60 ~/.npmrc \u91CC\u7684\u955C\u50CF\u4E0E\u4EE3\u7406\uFF0C
\u8981\u4E34\u65F6\u6362\u6E90\u7528 --npm-registry\u3002--only \u8BA4 skills\u3001cli\u3001styles\uFF08\u5168\u90E8\u98CE\u683C\u6765\u6E90\uFF09\u6216
styles:<\u6765\u6E90>\u3002--check \u53EA\u62A5\u544A\u54EA\u4E9B\u5DF2\u5C31\u7EEA\u3001\u54EA\u4E9B\u7F3A\uFF0C\u4E0D\u4E0B\u8F7D\uFF1B\u6709\u7F3A\u9879\u65F6\u9000\u51FA\u7801\u4E3A 1\u3002`,
    example: `  am setup
  am setup --proxy http://127.0.0.1:7890
  am setup --only styles --proxy http://127.0.0.1:7890
  am setup --only styles:lemo-opuscar
  am setup --check`,
    runE: async (c) => {
      const env = currentEnvironment();
      const selected = selectSetupItems(items(), only.value);
      if (check.value) return setupCheck(stdout, env, selected);
      return setupPrepare(c.context(), stdout, env, selected, proxy.value, npmRegistry.value);
    }
  });
  cmd.flags().boolVar(check, "check", false, "\u53EA\u68C0\u67E5\u54EA\u4E9B\u5DF2\u5C31\u7EEA\uFF0C\u4E0D\u4E0B\u8F7D\uFF1B\u6709\u7F3A\u9879\u65F6\u9000\u51FA\u7801\u4E3A 1");
  cmd.flags().stringSliceVar(only, "only", [], "\u53EA\u51C6\u5907\u5176\u4E2D\u51E0\u9879\uFF1Askills\u3001cli\u3001styles \u6216 styles:<\u6765\u6E90>\uFF08\u53EF\u9017\u53F7\u5206\u9694\uFF09");
  cmd.flags().stringVar(proxy, "proxy", "", "git \u4E0B\u8F7D\uFF08GitHub\uFF09\u7528\u7684\u4EE3\u7406\uFF0C\u4F8B\u5982 http://127.0.0.1:7890\uFF1B\u4E0D\u5F71\u54CD npm");
  cmd.flags().stringVar(npmRegistry, "npm-registry", "", "npm \u7528\u7684\u6E90\uFF0C\u8986\u76D6 ~/.npmrc \u7684 registry");
  return cmd;
}
function selectSetupItems(items2, only) {
  const wanted = /* @__PURE__ */ new Set();
  for (const value of only) for (const id of value.split(",")) if (id.trim() !== "") wanted.add(id.trim());
  for (const id of wanted) {
    if (!items2.some((item) => item.id === id || item.group === id)) {
      throw new Error(`--only \u4E0D\u8BA4 ${goQuote(id)}\uFF08\u53EF\u9009\uFF1Askills\u3001cli\u3001styles\u3001${items2.map((item) => item.id).join("\u3001")}\uFF09`);
    }
  }
  return items2.filter((item) => wanted.size === 0 || wanted.has(item.id) || wanted.has(item.group));
}
function newItemsView(stdout, items2) {
  return new SetupView(
    stdout,
    items2.map((item) => item.name),
    items2.map((item) => item.version),
    Boolean(stdout.isTTY)
  );
}
function setupCheck(stdout, env, items2) {
  const view = newItemsView(stdout, items2);
  const [nameWidth, versionWidth] = view.widths();
  stdout.write("\n");
  let missing2 = 0;
  for (const item of items2) {
    const [ok, where] = item.ready(env);
    let icon = view.paint("32", "\u2713");
    let state = "\u5DF2\u5C31\u7EEA";
    if (!ok) {
      icon = view.paint("31", "\u2717");
      state = view.paint("31", "\u7F3A");
      missing2++;
    }
    const version = versionWidth > 0 ? view.paint("2", pad(item.version, versionWidth)) + "  " : "";
    stdout.write(`  ${icon} ${pad(item.name, nameWidth)}  ${version}${pad(state, 6)}  ${view.paint("2", homeShort(where))}
`);
  }
  stdout.write("\n");
  if (missing2 > 0) {
    stdout.write(`\u7F3A ${missing2} \u9879\uFF0C\u8FD0\u884C ${SetupCommand} \u51C6\u5907\u3002
`);
    throw new ExitError2(1, "");
  }
  stdout.write("\u524D\u7F6E\u8D44\u6E90\u90FD\u5DF2\u5C31\u7EEA\u3002\n");
}
function setupLogPath(env) {
  return import_node_path12.default.join(import_node_path12.default.dirname(defaultCacheDir(env)), "setup.log");
}
async function setupPrepare(signal, stdout, env, items2, proxy, npmRegistry) {
  const logPath = setupLogPath(env);
  import_node_fs12.default.mkdirSync(import_node_path12.default.dirname(logPath), { recursive: true });
  let logFd;
  try {
    logFd = import_node_fs12.default.openSync(logPath, "w");
  } catch (err) {
    throw new Error(`\u521B\u5EFA\u65E5\u5FD7 ${logPath}\uFF1A${err.message}`);
  }
  const log = { write: (chunk) => import_node_fs12.default.writeSync(logFd, chunk) };
  try {
    const git = { ...env };
    const npm = { ...env };
    if (proxy !== "") git.GIT_CONFIG_PARAMETERS = `'http.proxy'='${proxy}'`;
    if (npmRegistry !== "") npm.npm_config_registry = npmRegistry;
    const mixed = { ...git };
    if (npmRegistry !== "") mixed.npm_config_registry = npmRegistry;
    const run = { base: env, git, npm, mixed, log, stage: () => {
    } };
    const view = newItemsView(stdout, items2);
    let header = "am setup \xB7 \u51C6\u5907\u524D\u7F6E\u8D44\u6E90";
    if (proxy !== "") header += view.paint("2", "\uFF08git \u4EE3\u7406 " + proxy + "\uFF09");
    stdout.write(`
${header}

`);
    items2.forEach((item, i) => {
      if (item.ready(env)[0]) view.markReady(i);
    });
    if (!view.tty) items2.forEach((_, i) => view.items[i].state === 2 /* Ready */ && view.set(i, 2 /* Ready */, ""));
    view.start();
    const started = Date.now();
    for (const [i, item] of items2.entries()) {
      if (view.items[i].state === 2 /* Ready */) continue;
      log.write(`
===== ${item.name} ${item.version} =====
`);
      view.set(i, 1 /* Running */, "\u51C6\u5907\u4E2D");
      run.stage = (stage) => view.detail(i, stage);
      try {
        await item.prepare(run, signal);
      } catch (err) {
        const message = err.message;
        log.write(`
[am] ${message}
`);
        view.set(i, 4 /* Failed */, "");
        view.stop();
        import_node_fs12.default.fsyncSync(logFd);
        const body = import_node_fs12.default.readFileSync(logPath, "utf8");
        stdout.write(`
${view.paint("31", "\u2717")} ${item.name} \u6CA1\u51C6\u5907\u597D\uFF1A${message}
`);
        const cut = body.lastIndexOf("\n[am] ");
        const tail = tailLines(body.slice(0, Math.max(0, cut)).replace(/\n+$/, ""), 12);
        if (tail.length > 0) {
          stdout.write(view.paint("2", "\n  \u65E5\u5FD7\u6700\u540E\u51E0\u884C\uFF1A") + "\n");
          for (const line of tail) stdout.write(view.paint("2", "  \u2502 " + line) + "\n");
        }
        stdout.write(`
\u5B8C\u6574\u65E5\u5FD7\uFF1A${homeShort(logPath)}
\u518D\u8FD0\u884C\u4E00\u6B21 am setup \u4F1A\u63A5\u7740\u4E0B\uFF1BGitHub \u6162\u53EF\u4EE5\u52A0 --proxy\u3002
`);
        throw new ExitError2(1, "");
      }
      view.set(i, 3 /* Done */, "");
    }
    view.stop();
    stdout.write(`
\u5168\u90E8\u5C31\u7EEA\uFF0C\u7528\u65F6 ${clock(Date.now() - started)}\u3002
`);
  } finally {
    import_node_fs12.default.closeSync(logFd);
  }
}

// src/cli.ts
var Version = typeof AM_VERSION === "string" ? AM_VERSION : "dev";
var hyperframesVersion = PinnedVersion;
function currentEnvironment() {
  return envMap();
}
var rootLong = `ArticleToMotion \u7AD6\u5C4F MG \u89C6\u9891\u5236\u4F5C\u5DE5\u5177\u3002

\u628A\u5B9A\u7A3F SRT \u62C6\u6210\u5E76\u53D1\u6E32\u67D3\u7684\u52A8\u753B\u955C\u5934\uFF0C\u6216\u4ECE\u6587\u7AE0/\u53E3\u64AD\u7A3F\u8D70\u5B8C TTS\u3001\u5B57\u5E55\u3001\u5C01\u9762\u3001
\u58F0\u97F3\u4E0E\u53D1\u5E03\u4EA4\u4ED8\u7684\u5168\u6D41\u7A0B\u3002\u6E32\u67D3\u7531\u5916\u90E8 AI CLI \u5B8C\u6210\uFF0Cam \u8D1F\u8D23\u5951\u7EA6\u3001\u8C03\u5EA6\u4E0E\u6821\u9A8C\u3002

\u4E24\u79CD\u5165\u53E3\uFF1A
  am run                          \u6709\u5B9A\u7A3F transcription.srt \u8BFB PROMPT.md\uFF0C\u5426\u5219\u8BFB PROMPT-PRODUCTION.md
  am run PROMPT-PRODUCTION.md     \u4ECE\u6587\u7AE0\u6216\u53E3\u64AD\u7A3F\u5F00\u59CB\u5B8C\u6574\u5236\u4F5C
  am scene run / run-all          \u53EA\u8DD1\u955C\u5934\u6E32\u67D3\uFF0C\u53EF\u8131\u79BB am run \u5355\u72EC\u4F7F\u7528

\u914D\u7F6E\u89E3\u6790\u4F18\u5148\u7EA7\uFF08\u9AD8\u5230\u4F4E\uFF09\uFF1A\u73AF\u5883\u53D8\u91CF > \u9879\u76EE .env > article-to-motion.conf > \u5185\u7F6E\u9ED8\u8BA4\u3002
\u7528 am config get \u8BFB\u53D6\u89E3\u6790\u7ED3\u679C\uFF0C\u4E0D\u8981\u81EA\u5DF1\u89E3\u6790\u914D\u7F6E\u6587\u4EF6\u3002
\u9879\u76EE .env \u4E0D\u5141\u8BB8\u51FA\u73B0\u4EE5 API_KEY / TOKEN / SECRET / PASSWORD \u7ED3\u5C3E\u7684\u952E\uFF0C\u51FA\u73B0\u5219\u62D2\u7EDD\u542F\u52A8\u3002

\u5916\u90E8 AI CLI \u9ED8\u8BA4\u8FD0\u884C\u5728\u9650\u5236\u4E8E\u9879\u76EE\u5DE5\u4F5C\u533A\u7684\u5B89\u5168\u6A21\u5F0F\u3002\u5B89\u5168\u6A21\u5F0F\u4E0B\u5B50\u8FDB\u7A0B\u53EA\u7EE7\u627F\u767D\u540D\u5355
\u73AF\u5883\u53D8\u91CF\u52A0\u4E0A .env \u8986\u76D6\u5C42\uFF1B\u7F3A\u53D8\u91CF\u7528 AM_PASSTHROUGH_ENV=NAME1,NAME2 \u663E\u5F0F\u5217\u51FA\uFF0C
\u4E0D\u8981\u6539\u7528 --unsafe \u7ED5\u8FC7\u9694\u79BB\u3002

\u9000\u51FA\u7801\uFF1A
  0    \u6210\u529F
  1    \u4E00\u822C\u5931\u8D25\uFF08\u53C2\u6570\u3001\u6821\u9A8C\u3001\u914D\u7F6E\u3001IO\uFF09
  127  \u7F3A\u5C11\u5FC5\u9700\u7684\u5916\u90E8\u547D\u4EE4
  130  \u88AB\u4E2D\u65AD\uFF08SIGINT / \u4E0A\u4E0B\u6587\u53D6\u6D88\uFF09
  \u5176\u4ED6 \u900F\u4F20\u5B50\u8FDB\u7A0B\u9000\u51FA\u7801\uFF1Aam run \u7528\u7F16\u6392\u5DE5\u5177\u7684\u9000\u51FA\u7801\uFF0Cam scene run-all \u7528\u955C\u5934\u6C47\u603B\u9000\u51FA\u7801

\u6240\u6709\u9519\u8BEF\u5199 stderr\uFF0C\u6B63\u5E38\u8F93\u51FA\u5199 stdout\uFF1B\u5931\u8D25\u65F6\u4E0D\u6253\u5370 usage\uFF0C\u53EA\u6253\u5370\u4E00\u884C\u9519\u8BEF\u3002`;
function newRoot(stdout, stderr) {
  const unsafe = ref(false);
  const root = new Command({ use: "am", short: "ArticleToMotion \u7AD6\u5C4F MG \u89C6\u9891\u5236\u4F5C\u5DE5\u5177", long: rootLong, version: Version });
  root.setOut(stdout);
  root.setErr(stderr);
  root.persistentFlags().boolVar(
    unsafe,
    "unsafe",
    false,
    "\u5173\u95ED AI CLI \u7684\u6743\u9650\u9694\u79BB\uFF08\u5371\u9669\uFF09\u3002\u53EA\u5BF9\u4F1A\u542F\u52A8 AI CLI \u7684 run / studio / scene run / scene run-all \u751F\u6548\uFF0C\u5BF9 init\u3001config\u3001validate\u3001archive \u65E0\u4F5C\u7528\uFF1B\u4F1A\u4F20\u9012\u7ED9\u5D4C\u5957\u955C\u5934\u4EFB\u52A1"
  );
  const flags = { unsafe };
  root.addCommand(newSetupCommand(stdout, stderr), newHyperframesCommand(stdout, stderr), newFilmStyleCommand(stdout, stderr));
  return { root, flags };
}
async function execute2(args, stdout, stderr, signal) {
  const { root } = newRoot(stdout, stderr);
  if (signal) root.setContext(signal);
  try {
    await root.execute(args);
    return 0;
  } catch (err) {
    if (!(err instanceof ExitError2) || err.bare !== "") stderr.write(String(err?.message ?? err) + "\n");
    if (err instanceof ExitError2) return err.code;
    if (signal?.aborted) return 130;
    if (String(err?.message ?? "").includes(MissingToolPrefix)) return 127;
    return 1;
  }
}
function exactArgs(count, name) {
  return (cmd, args) => {
    if (args.length !== count) throw new Error(`${cmd.commandPath()} \u9700\u8981 ${count} \u4E2A\u4F4D\u7F6E\u53C2\u6570 ${name}\uFF0C\u5B9E\u9645\u6536\u5230 ${args.length} \u4E2A\uFF1B\u7528\u6CD5\uFF1A${cmd.useLine()}`);
  };
}
var noArgs = (cmd, args) => {
  if (args.length > 0) throw new Error(`${cmd.commandPath()} \u4E0D\u63A5\u53D7\u4F4D\u7F6E\u53C2\u6570\uFF0C\u5B9E\u9645\u6536\u5230 ${args.length} \u4E2A\uFF1A${args.join(" ")}\uFF1B\u7528\u6CD5\uFF1A${cmd.useLine()}`);
};

// src/main.ts
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(141);
    throw err;
  });
}
var controller = new AbortController();
var interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  controller.abort();
});
execute2(process.argv.slice(2), process.stdout, process.stderr, controller.signal).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exitCode = 1;
  }
);
