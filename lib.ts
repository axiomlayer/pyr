import denoConfig from "./deno.json" with { type: "json" };

export const PYR_VERSION: string = denoConfig.version;
export const PYR_REPO = "jasenc7/pyr";

/** The user's home directory. Native Windows prefers USERPROFILE so an MSYS
 *  HOME such as /c/Users/name cannot redirect a Windows binary into a
 *  misinterpreted path. Unix (including WSL) continues to prefer HOME. */
export function userHome(): string | undefined {
  const home = Deno.env.get("HOME");
  const profile = Deno.env.get("USERPROFILE");
  return isWindows() ? profile ?? home : home ?? profile;
}

/** Returns the pyr home dir. Honors PYR_HOME, falls back to $HOME/.pyr,
 *  then $USERPROFILE/.pyr (Windows). Throws if no home can be determined. */
export function pyrHome(): string {
  const explicit = Deno.env.get("PYR_HOME");
  if (explicit) return explicit;
  const home = userHome();
  if (!home) throw new Error("cannot determine home directory");
  return `${home}/.pyr`;
}

export const PYR_HOME = pyrHome();

/** True when an already-normalized path is a filesystem root — somewhere a
 *  project must never be scaffolded. Covers the POSIX root, a Windows drive
 *  root (`c:`), and UNC roots: a bare server (`//server`) or a share with
 *  nothing below it (`//server/share`). Extended-length prefixes are unwrapped
 *  first, so `\\?\C:\` and `\\?\UNC\server\share` are recognized too. */
function isRootPath(p: string): boolean {
  if (p === "") return true; // "/" with its trailing slash stripped
  if (/^[a-zA-Z]:$/.test(p)) return true;
  if (!p.startsWith("//")) return false;

  let segments = p.slice(2).split("/").filter((s) => s !== "");
  if (segments[0] === "?" || segments[0] === ".") {
    segments = segments.slice(1);
    // `\\?\UNC\server\share` is a UNC path wearing a prefix; anything else
    // behind `\\?\` is a local path, where the drive alone is the root.
    if (segments[0]?.toLowerCase() === "unc") segments = segments.slice(1);
    else return segments.length <= 1;
  }
  return segments.length <= 2;
}

/** Why `pyr init` (no name) must not scaffold into `cwd`: "home" if it is the
 *  user's home directory, "root" if it is a filesystem root, else null.
 *  Pure string comparison; callers pass already-resolved paths. Separators are
 *  normalized on every platform; case is folded only on Windows. */
export function protectedInitDir(cwd: string, home?: string): "home" | "root" | null {
  const norm = (p: string) => {
    let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    if (isWindows()) s = s.toLowerCase();
    return s;
  };
  const c = norm(cwd);
  if (isRootPath(c)) return "root";
  if (home !== undefined && norm(home) !== "" && c === norm(home)) return "home";
  return null;
}

// --- platform ---

export function isWindows(): boolean {
  return Deno.build.os === "windows";
}

/** Path to the managed cpython interpreter. On Windows the install_only
 *  layout puts python.exe at the root; elsewhere it's bin/python3. */
export function managedPython(): string {
  return isWindows() ? `${PYR_HOME}/python/python.exe` : `${PYR_HOME}/python/bin/python3`;
}

export interface VenvPaths {
  root: string;
  binDir: string;
  python: string;
  pip: string;
  stamp: string;
}

/** Resolves the per-OS layout of a project venv. Windows venvs put scripts
 *  in `Scripts/` with `.exe` suffixes; everything else uses `bin/`. */
export function venvPaths(root: string = ".venv"): VenvPaths {
  const win = isWindows();
  const sep = win ? "\\" : "/";
  const binDir = `${root}${sep}${win ? "Scripts" : "bin"}`;
  const exe = win ? ".exe" : "";
  return {
    root,
    binDir,
    python: `${binDir}${sep}python${exe}`,
    pip: `${binDir}${sep}pip${exe}`,
    stamp: `${root}${sep}.pyr-python`,
  };
}

// --- ui ---
//
// Keep terminal feedback local so the release build has no registry imports.

const stderrEncoder = new TextEncoder();

function writeStderr(text: string): void {
  try {
    Deno.stderr.writeSync(stderrEncoder.encode(text));
  } catch {
    // Terminal feedback is best-effort and must never break an install.
  }
}

/** True iff stderr is connected to an interactive terminal. When false (CI,
 *  redirected output, test capture, etc.), animated UI elements would just
 *  produce smeared output, so skip them. */
function stderrIsTty(): boolean {
  try {
    return Deno.stderr.isTerminal();
  } catch {
    return false;
  }
}

/** Start a spinner with the given message; returns a stop handle. In
 *  non-TTY contexts the message is printed once and stop() is a no-op so we
 *  don't smear escape codes across captured output. */
export function makeSpinner(message: string): { stop: () => void } {
  if (!stderrIsTty()) {
    console.error(message);
    return { stop: () => {} };
  }
  const frames = ["-", "\\", "|", "/"];
  let frame = 0;
  const render = () => writeStderr(`\r${frames[frame++ % frames.length]} ${message}`);
  render();
  const timer = setInterval(render, 80);
  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      writeStderr("\r\x1b[2K");
    },
  };
}

/** Wrap a fetch response body in a progress-tracking TransformStream when
 *  stderr is a TTY and the total size is known via Content-Length. Returns
 *  the original body otherwise. */
export function maybeProgressStream(resp: Response): ReadableStream<Uint8Array> | null {
  if (!resp.body) return null;
  if (!stderrIsTty()) return resp.body;
  const lenHeader = resp.headers.get("content-length");
  const max = lenHeader ? Number(lenHeader) : NaN;
  if (!Number.isFinite(max) || max <= 0) return resp.body;
  let transferred = 0;
  let lastPercent = -1;
  return resp.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        transferred += chunk.byteLength;
        const percent = Math.min(100, Math.floor((transferred / max) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          writeStderr(`\rdownloading... ${percent}%`);
        }
        controller.enqueue(chunk);
      },
      flush() {
        writeStderr("\r\x1b[2K");
      },
    }),
  );
}

// --- commands ---

export async function init(name?: string) {
  const dir = name ?? ".";
  const projectName = name ?? basename(Deno.cwd());

  // Refuse to scaffold over existing content. If a name was given, the target
  // directory must be empty (or absent). If we're in cwd, none of the
  // sentinel files we'd write may already exist.
  if (name) {
    try {
      const entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry.name);
        if (entries.length > 0) break;
      }
      if (entries.length > 0) {
        console.error(`${dir} exists and is not empty`);
        Deno.exit(1);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      // doesn't exist yet — fine, we'll create it
    }
  } else {
    // `pyr init` with no name adopts cwd as the project. Running that in $HOME
    // (or a drive root) silently turns the whole tree into a project named
    // after the user, so refuse before touching anything. Resolve symlinks and
    // canonical case first; fall back to the raw strings if either can't be.
    const real = (p: string) => {
      try {
        return Deno.realPathSync(p);
      } catch {
        return p;
      }
    };
    // HOME and USERPROFILE can point at different directories in the same
    // process (e.g. Git Bash sets HOME while Windows still populates
    // USERPROFILE) — userHome()'s `??` only ever checks the first one set, so
    // an init run from whichever it didn't pick would slip the guard. Check
    // cwd against both.
    const cwdReal = real(Deno.cwd());
    let why: "home" | "root" | null = null;
    for (const h of [Deno.env.get("HOME"), Deno.env.get("USERPROFILE")]) {
      why = protectedInitDir(cwdReal, h === undefined ? undefined : real(h));
      if (why) break;
    }
    if (why) {
      console.error(`refusing to init in your ${why} directory`);
      console.error("run `pyr init <name>` to create a new project in a subdirectory");
      Deno.exit(1);
    }
    for (const sentinel of ["pyproject.toml", "requirements.txt", "app/main.py"]) {
      try {
        await Deno.stat(sentinel);
        console.error(`refusing to overwrite ${sentinel}`);
        console.error("run `pyr init <name>` to create a new project in a subdirectory");
        Deno.exit(1);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        // good — doesn't exist
      }
    }
  }

  const python = await ensurePython();

  if (name) {
    await Deno.mkdir(dir, { recursive: true });
  }

  await Deno.mkdir(`${dir}/app`, { recursive: true });

  await write(`${dir}/pyproject.toml`, pyproject(projectName));
  await write(`${dir}/requirements.txt`, "");
  await write(`${dir}/.gitignore`, gitignore());
  await write(`${dir}/app/__init__.py`, "");
  await write(`${dir}/app/config.py`, config());
  await write(`${dir}/app/main.py`, stamp());

  const spinner = makeSpinner("creating venv...");
  const venv = new Deno.Command(python, {
    args: ["-m", "venv", `${dir}/.venv`],
  });
  const result = await venv.output();
  spinner.stop();

  if (!result.success) {
    console.error("failed to create venv");
    Deno.exit(1);
  }

  await stampVenv(dir);
  console.log(`${projectName} ready`);
}

export async function run(args: string[]) {
  // Validate the entrypoint up front; ensureVenv's "no .venv" error is
  // misleading if the user is in the wrong directory entirely.
  try {
    await Deno.stat("app/main.py");
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      console.error("no app/main.py found. are you in a pyr project?");
      console.error("run `pyr init` to scaffold one here.");
      Deno.exit(1);
    }
    throw e;
  }

  await ensureVenv();

  // Auto-sync if pyproject.toml has been edited since the lock was last
  // written (e.g., the user hand-edited [project].dependencies).
  if (await pyprojectNewerThanLock()) {
    await sync({ quiet: true });
  }

  const cmd = new Deno.Command(venvPaths().python, {
    args: ["app/main.py", ...args],
    env: { PYTHONPATH: "." },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const result = await cmd.spawn().status;
  Deno.exit(result.code);
}

export async function add(packages: string[]) {
  if (packages.length === 0) {
    console.error("usage: pyr add <package> [package...]");
    Deno.exit(1);
  }

  // Validate every spec up front so a bad input doesn't leave pyproject
  // half-mutated.
  for (const pkg of packages) {
    const name = parseRequirementName(pkg);
    if (!name) {
      console.error(`cannot parse requirement: ${pkg}`);
      Deno.exit(1);
    }
  }

  await ensureVenv();

  for (const pkg of packages) {
    await addPyprojectDep(pkg);
  }

  await sync();
}

export async function remove(packages: string[]) {
  if (packages.length === 0) {
    console.error("usage: pyr remove <package> [package...]");
    Deno.exit(1);
  }

  await ensureVenv();
  let changed = false;
  for (const pkg of packages) {
    const name = parseRequirementName(pkg) ?? canonicalizeName(pkg);
    const removed = await removePyprojectDep(name);
    if (removed) {
      changed = true;
    } else {
      console.error(`not in pyproject.toml: ${name}`);
    }
  }
  if (changed) await sync();
}

export interface SyncOptions {
  /** Suppress per-step chatter and the no-op summary. */
  quiet?: boolean;
}

/** Packages we never uninstall during sync — they're part of the venv's
 *  bootstrap. Names are PEP 503 canonical. */
const PROTECTED_PKGS = new Set(["pip", "setuptools", "wheel"]);

/** Reconcile the venv and requirements.txt with pyproject.toml [project].
 *  dependencies. Resolves via `pip install --upgrade -r <tmp>`, prunes
 *  orphans (packages in the old lock that pip didn't keep), and writes a
 *  fully-pinned flat lockfile. On resolver failure, the existing lockfile
 *  is left intact. */
export async function sync(opts: SyncOptions = {}): Promise<void> {
  await ensureVenv();

  // Read the declaration before touching anything. Step 3 below treats every
  // installed leaf that is not a top-level dep as an orphan and uninstalls it,
  // looping to promote newly exposed leaves, so an empty list against a
  // populated venv is a full recursive teardown. That is the right thing to do
  // when the file really says `dependencies = []`, and a silent catastrophe
  // when it only looked that way, so refuse to act on a list we could not read.
  const declared = await readPyprojectDepsDetailed();
  if (declared.kind === "indeterminate") {
    throw new Error(
      `sync refused: ${declared.reason}. ` +
        "Nothing was installed, uninstalled or written. " +
        "Declare dependencies as a [project].dependencies array, or manage this environment without pyr sync.",
    );
  }
  const topDeps = declared.kind === "declared" ? declared.deps : [];
  const oldLock = await readLock();

  if (topDeps.length === 0 && oldLock.size === 0) {
    if (!opts.quiet) console.log("nothing to sync");
    return;
  }

  const pip = venvPaths().pip;

  // Step 1: install/upgrade top-level deps. We write to a temp file so pip
  // sees one spec per line; that handles extras and version specifiers
  // without us having to escape anything ourselves.
  if (topDeps.length > 0) {
    const tmpDir = await Deno.makeTempDir();
    const tmpReq = `${tmpDir}/requirements.in`;
    try {
      await Deno.writeTextFile(tmpReq, topDeps.join("\n") + "\n");
      if (!opts.quiet) console.log("resolving dependencies...");
      const install = new Deno.Command(pip, {
        args: ["install", "--upgrade", "-r", tmpReq],
        stdout: "inherit",
        stderr: "inherit",
      });
      const result = await install.spawn().status;
      if (!result.success) {
        console.error("sync failed: pip could not resolve dependencies");
        console.error("requirements.txt is unchanged; venv may be in a partial state");
        Deno.exit(result.code || 1);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }

  // Step 2: capture the post-install state.
  const freeze = await pipFreeze(pip);

  // Step 3: identify orphans. A package in the venv is an orphan if nothing
  // else depends on it (it's a "leaf" per `pip list --not-required`) AND it's
  // not one of the user's top-level deps and not an essential venv package
  // (pip, setuptools, wheel — uninstalling these breaks the venv).
  const topNames = new Set(
    topDeps.map((d) => parseRequirementName(d)).filter(
      (n): n is string => n !== null,
    ),
  );
  const isOrphan = (name: string) => !topNames.has(name) && !PROTECTED_PKGS.has(name);
  const leaves = await pipLeaves(pip);
  const orphans = leaves.filter(isOrphan);

  if (orphans.length > 0) {
    if (!opts.quiet) console.log(`pruning ${orphans.length} orphan(s)...`);
    const uninstall = new Deno.Command(pip, {
      args: ["uninstall", "-y", ...orphans],
      stdout: "inherit",
      stderr: "inherit",
    });
    const result = await uninstall.spawn().status;
    if (!result.success) {
      console.error("warning: pip uninstall failed; lockfile may include stale entries");
    }

    // Removing a leaf can promote its former dependencies to leaf status. Loop
    // until the leaf set is stable. Bound to a few iterations for safety —
    // any sane closure resolves in O(depth-of-tree).
    for (let i = 0; i < 16; i++) {
      const nextLeaves = await pipLeaves(pip);
      const nextOrphans = nextLeaves.filter(isOrphan);
      if (nextOrphans.length === 0) break;
      const u = new Deno.Command(pip, {
        args: ["uninstall", "-y", ...nextOrphans],
        stdout: "inherit",
        stderr: "inherit",
      });
      await u.spawn().status;
    }
  }

  // Step 4: re-freeze (we may have uninstalled) and write the lock.
  const finalFreeze = orphans.length > 0 ? await pipFreeze(pip) : freeze;
  await writeLock(finalFreeze);

  // Step 5: summary.
  if (!opts.quiet) {
    const finalNames = new Set(
      finalFreeze.map((l) => parseRequirementName(l)).filter(
        (n): n is string => n !== null,
      ),
    );
    let added = 0;
    let unchanged = 0;
    for (const name of finalNames) {
      const before = oldLock.get(name);
      const after = finalFreeze.find((l) => parseRequirementName(l) === name);
      if (before === undefined) added++;
      else if (before === after) unchanged++;
      else added++; // version changed; counted as a modification (treated as add)
    }
    const removed = orphans.length;
    console.log(`+${added}  -${removed}  (${unchanged} unchanged)`);
  }
}

/** Run `pip freeze` and return its lines (trimmed, blanks dropped, editable
 *  self-installs and PROTECTED_PKGS filtered). The lock should never include
 *  pip/setuptools/wheel — those are venv plumbing, not user dependencies. */
async function pipFreeze(pip: string): Promise<string[]> {
  const cmd = new Deno.Command(pip, {
    args: ["freeze"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    throw new Error("pip freeze failed");
  }
  const text = new TextDecoder().decode(result.stdout);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l || l.startsWith("#") || l.startsWith("-e ")) return false;
      const name = parseRequirementName(l);
      if (name && PROTECTED_PKGS.has(name)) return false;
      return true;
    });
}

/** Return the canonical names of installed packages that nothing else depends
 *  on (pip's "leaf" packages). Used to detect orphans: a leaf that isn't a
 *  user-declared top-level dep is unreachable and can be pruned. */
async function pipLeaves(pip: string): Promise<string[]> {
  const cmd = new Deno.Command(pip, {
    args: ["list", "--not-required", "--format=json"],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  if (!result.success) {
    console.error(new TextDecoder().decode(result.stderr));
    throw new Error("pip list failed");
  }
  const text = new TextDecoder().decode(result.stdout);
  const parsed = JSON.parse(text) as Array<{ name: string }>;
  return parsed.map((p) => canonicalizeName(p.name));
}

/** True when pyproject.toml has been modified more recently than
 *  requirements.txt (the pyr-managed lock). Used by `run` to auto-sync after
 *  a hand-edit. Returns false if either file is missing. */
async function pyprojectNewerThanLock(): Promise<boolean> {
  try {
    const [pyp, lock] = await Promise.all([
      Deno.stat("pyproject.toml"),
      Deno.stat("requirements.txt"),
    ]);
    const pypTime = pyp.mtime?.getTime() ?? 0;
    const lockTime = lock.mtime?.getTime() ?? 0;
    return pypTime > lockTime;
  } catch {
    return false;
  }
}

export interface PythonPin {
  version: string;
  /** Full python-build-standalone identifier, for example 3.14.7+20260901. */
  build?: string;
}

/** Parse an exact CPython version, optionally qualified by the immutable
 *  python-build-standalone release/build identifier. */
export function parsePythonPin(value: string): PythonPin {
  const match = value.match(/^(\d+\.\d+\.\d+)(?:\+(\d+))?$/);
  if (!match) {
    throw new Error(
      `invalid python version: ${value}; expected X.Y.Z or X.Y.Z+BUILD`,
    );
  }
  return {
    version: match[1],
    build: match[2] ? `${match[1]}+${match[2]}` : undefined,
  };
}

export async function upgrade(args: string[]) {
  if (args.length === 0) {
    await upgradeSelf();
    return;
  }

  let requested: string | undefined;
  if (args[0] === "--python") {
    if (args.length > 2) {
      throw new Error("usage: pyr upgrade --python [X.Y.Z[+BUILD]]");
    }
    requested = args[1];
  } else if (args.length === 1 && args[0].startsWith("--python=")) {
    requested = args[0].slice("--python=".length);
    if (!requested) {
      throw new Error("usage: pyr upgrade --python [X.Y.Z[+BUILD]]");
    }
  } else {
    throw new Error("usage: pyr upgrade [--python [X.Y.Z[+BUILD]]]");
  }

  await upgradePython(requested === undefined ? undefined : parsePythonPin(requested));
}

// --- helpers ---

export function basename(path: string): string {
  // Strip trailing separators, then take the last segment. Splits on both
  // `/` and `\\` so Windows paths like `C:\dev\proj` work.
  const trimmed = path.replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\]+/).pop() ?? "";
  return last;
}

async function write(path: string, content: string) {
  await Deno.writeTextFile(path, content);
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

/** Parse the conventional sha256sum output emitted beside a release. */
export function parseSha256Sums(text: string, filename: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/);
    if (match?.[2] === filename) return match[1].toLowerCase();
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256File(path: string): Promise<string> {
  return await sha256Hex(await Deno.readFile(path));
}

async function verifySha256File(path: string, expected: string, label: string): Promise<void> {
  if (!/^[0-9a-fA-F]{64}$/.test(expected)) {
    throw new Error(`invalid SHA-256 digest for ${label}`);
  }
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${label}`);
  }
}

async function releaseAssetSha256(
  release: { assets?: GithubReleaseAsset[] },
  filename: string,
): Promise<string> {
  const sumsAsset = release.assets?.find((asset) => asset.name === "SHA256SUMS");
  if (!sumsAsset) {
    throw new Error(`release has no SHA256SUMS; refusing to download ${filename}`);
  }

  const response = await fetch(sumsAsset.browser_download_url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`failed to download SHA256SUMS: ${response.status}`);
  }
  const digest = parseSha256Sums(await response.text(), filename);
  if (!digest) {
    throw new Error(`SHA256SUMS has no valid entry for ${filename}`);
  }
  return digest;
}

async function downloadFile(url: string, path: string, failure: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(failure);
  }
  const file = await Deno.open(path, { write: true, createNew: true });
  try {
    await (maybeProgressStream(response) ?? response.body).pipeTo(file.writable);
  } finally {
    try {
      file.close();
    } catch {
      // pipeTo already closed the handle.
    }
  }
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
  };
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

// --- requirement parsing ---

/** PEP 503 normalization: lowercase + collapse runs of [-_.] to single `-`. */
export function canonicalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Extract the canonical package name from a requirement spec string. Handles
 *  comments, environment markers, extras, version specifiers, VCS URLs, and
 *  direct (`name @ url`) references. Returns null for editable installs and
 *  bare local paths (caller should error — names are not derivable without
 *  reading the target's metadata). */
export function parseRequirementName(spec: string): string | null {
  // Strip line comment.
  const noComment = spec.replace(/\s+#.*$/, "").trim();
  if (!noComment) return null;

  // Strip environment marker (everything after `; ...`).
  const preMarker = noComment.split(";")[0].trim();
  if (!preMarker) return null;

  // Strip editable install prefix; bare path that follows is not parseable.
  const editable = preMarker.match(/^(?:-e|--editable)\s+(.+)$/);
  const body = editable ? editable[1].trim() : preMarker;
  if (editable) return null;

  // Local path (./foo, /foo, \\foo, drive letter) — name not derivable.
  if (/^(\.|\/|\\\\|[a-zA-Z]:)/.test(body)) return null;

  // Direct reference: `name @ url`.
  const directMatch = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*@\s+/);
  if (directMatch) return canonicalizeName(directMatch[1]);

  // VCS URL with `#egg=foo`.
  const vcsMatch = body.match(
    /^(?:git|hg|svn|bzr)\+\S+#egg=([A-Za-z0-9][A-Za-z0-9._-]*)/,
  );
  if (vcsMatch) return canonicalizeName(vcsMatch[1]);

  // Bare URL without egg fragment — unparseable.
  if (/^[a-z]+:\/\//i.test(body)) return null;

  // Standard PEP 508 form: name[extras]specifier.
  const normalMatch = body.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
  if (!normalMatch) return null;
  return canonicalizeName(normalMatch[1]);
}

// --- pyproject io ---

/** What a pyproject.toml actually told us about its dependencies.
 *
 *  The three cases are kept apart because "no dependencies" and "I could not
 *  tell" lead to opposite decisions in sync: the first may prune, the second
 *  must not. Collapsing them into an empty array is what makes a missed
 *  spelling delete a working environment. */
export type PyprojectDepsRead =
  | { kind: "absent" }
  | { kind: "declared"; deps: string[] }
  | { kind: "indeterminate"; reason: string };

// PEP 621 lets a build backend supply the dependency list, in which case
// pyproject declares `dynamic = ["dependencies"]` and carries no array at all.
// The list is real, it is just not here, so reading it as an empty list is
// wrong in the most destructive direction.
const DYNAMIC_KEY_RE = /^[ \t]*(?:dynamic|"dynamic"|'dynamic')[ \t]*=[ \t]*\[/m;
// Used only to tell "there is no dependencies key" from "there is one and I
// could not resolve it". Line-anchored and exact, so that the substring in
// [project.optional-dependencies] or build-system.requires cannot match.
const ANY_DEPS_KEY_RE =
  /^[ \t]*(?:(?:project[ \t]*\.[ \t]*)?(?:dependencies|"dependencies"|'dependencies')|"project\.dependencies"|'project\.dependencies')[ \t]*=/m;

/** Read `[project].dependencies` from a pyproject.toml, reporting which of the
 *  three cases applies. Accepts every equivalent TOML spelling of the table and
 *  the key, including quoted keys and the top-level `project.dependencies`
 *  dotted form, and reports `indeterminate` rather than guessing when a
 *  dependency list is declared in a form it cannot resolve. */
export async function readPyprojectDepsDetailed(
  path: string = "pyproject.toml",
): Promise<PyprojectDepsRead> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return { kind: "absent" };
  }

  const project = locateProjectTable(text);
  if (project) {
    const inTable = locateDepsArray(text, project.start, project.end);
    if (inTable) {
      return {
        kind: "declared",
        deps: parseDepsArray(text.slice(inTable.open, inTable.close + 1)),
      };
    }
  }

  const dotted = locateDottedDepsArray(text);
  if (dotted) {
    return {
      kind: "declared",
      deps: parseDepsArray(text.slice(dotted.open, dotted.close + 1)),
    };
  }

  if (project) {
    const dyn = DYNAMIC_KEY_RE.exec(text.slice(project.start, project.end));
    if (dyn) {
      const open = project.start + dyn.index + dyn[0].length - 1;
      let names: string[] = [];
      try {
        const span = bracketSpanFrom(text, open);
        names = parseDepsArray(text.slice(span.open, span.close + 1));
      } catch {
        return {
          kind: "indeterminate",
          reason: `${path}: [project].dynamic could not be read`,
        };
      }
      if (names.includes("dependencies")) {
        return {
          kind: "indeterminate",
          reason:
            `${path}: [project].dynamic declares "dependencies", so the list comes from the build backend and is not in this file`,
        };
      }
    }
  }

  // Nothing resolved. If a dependencies key is nonetheless present, this is a
  // form we do not understand, and saying "no dependencies" would be a guess.
  if (ANY_DEPS_KEY_RE.test(text)) {
    return {
      kind: "indeterminate",
      reason: `${path}: a dependencies key is present in a form this reader could not resolve`,
    };
  }

  return { kind: "absent" };
}

/** Read the [project].dependencies array from a pyproject.toml file. Returns
 *  an empty list if the file or section is absent, or if the list could not be
 *  resolved; callers that act destructively on the result must use
 *  readPyprojectDepsDetailed and distinguish those cases. */
export async function readPyprojectDeps(
  path: string = "pyproject.toml",
): Promise<string[]> {
  const read = await readPyprojectDepsDetailed(path);
  return read.kind === "declared" ? read.deps : [];
}

/** Add or replace a dependency spec in pyproject.toml [project].dependencies.
 *  Existing entries with the same canonical name are removed first. The rest
 *  of the file is preserved verbatim — only the dependencies array is rewritten.
 *  Errors if [project] is missing (pyr does not own pyproject.toml). */
export async function addPyprojectDep(
  spec: string,
  path: string = "pyproject.toml",
): Promise<void> {
  const name = parseRequirementName(spec);
  if (!name) {
    throw new Error(`cannot parse requirement: ${spec}`);
  }
  await editDepsArray(path, (deps) => {
    const filtered = deps.filter((d) => parseRequirementName(d) !== name);
    filtered.push(spec);
    return filtered;
  });
}

/** Remove a dependency by canonical name from pyproject.toml [project].
 *  dependencies. Returns true if anything was removed. */
export async function removePyprojectDep(
  name: string,
  path: string = "pyproject.toml",
): Promise<boolean> {
  const target = canonicalizeName(name);
  let removed = false;
  await editDepsArray(path, (deps) => {
    const next = deps.filter((d) => {
      if (parseRequirementName(d) === target) {
        removed = true;
        return false;
      }
      return true;
    });
    return next;
  });
  return removed;
}

/** Surgically rewrite the [project].dependencies array in `path`, applying
 *  `mutate(currentEntries) -> nextEntries`. Re-emits the array as one entry
 *  per line, 4-space indent, double-quoted. Comments inside the array are
 *  dropped. The rest of the file is untouched. */
async function editDepsArray(
  path: string,
  mutate: (deps: string[]) => string[],
): Promise<void> {
  const text = await Deno.readTextFile(path);
  const project = locateProjectTable(text);
  if (!project) {
    throw new Error(`${path}: missing [project] table`);
  }

  const existing = locateDepsArray(text, project.start, project.end);
  let next: string;
  if (existing) {
    const nextDeps = mutate(parseDepsArray(text.slice(existing.open, existing.close + 1)));
    next = text.slice(0, existing.open) +
      formatDepsArray(nextDeps) +
      text.slice(existing.close + 1);
  } else {
    // No `dependencies =` key; append one immediately after `[project]`.
    const headerEnd = text.indexOf("\n", project.start);
    const insertAt = headerEnd === -1 ? text.length : headerEnd + 1;
    const nextDeps = mutate([]);
    const block = `dependencies = ${formatDepsArray(nextDeps)}\n`;
    next = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  await Deno.writeTextFile(path, next);
}

interface TableSpan {
  start: number; // byte offset of `[project]` header line
  end: number; // byte offset just past the table (next header or EOF)
}

// TOML lets one table be spelled several equivalent ways: leading whitespace is
// allowed before the header, whitespace is allowed inside the brackets, and a
// bare key may be quoted. `[project]`, `[ project ]` and `["project"]` are the
// same table, so a locator that only accepts the first is not reading TOML, it
// is matching one preferred spelling of it.
const PROJECT_HEADER_RE =
  /^[ \t]*\[[ \t]*(?:project|"project"|'project')[ \t]*\][ \t]*(?:#[^\n]*)?$/m;
const ANY_HEADER_RE = /^[ \t]*\[[^\n]*\]/m;

function locateProjectTable(text: string): TableSpan | null {
  const m = PROJECT_HEADER_RE.exec(text);
  if (!m) return null;
  const start = m.index;
  // Find the next table header after this one; the table ends just before it.
  // A sub-table such as [project.optional-dependencies] ends it too, which is
  // what we want: its keys are not [project]'s keys.
  const headerEnd = start + m[0].length;
  const nextMatch = ANY_HEADER_RE.exec(text.slice(headerEnd));
  const end = nextMatch === null ? text.length : headerEnd + nextMatch.index;
  return { start, end };
}

interface ArraySpan {
  open: number; // byte offset of the `[` opening the array
  close: number; // byte offset of the matching `]`
}

// Same spelling problem as the table header: `dependencies`, `"dependencies"`
// and `'dependencies'` are one key. The trailing `\[` must stay the last
// character of the match so its offset is the array's opening bracket.
const DEPS_KEY_RE = /^[ \t]*(?:dependencies|"dependencies"|'dependencies')[ \t]*=[ \t]*\[/m;
// A dotted key is only `project.dependencies` while we are still above the
// first table header. After `[tool.foo]` the same text means
// `tool.foo.project.dependencies`, which is somebody else's key.
const DOTTED_DEPS_KEY_RE =
  /^[ \t]*(?:project|"project"|'project')[ \t]*\.[ \t]*(?:dependencies|"dependencies"|'dependencies')[ \t]*=[ \t]*\[/m;

function bracketSpanFrom(text: string, open: number): ArraySpan {
  const close = findMatchingBracket(text, open);
  if (close === -1) {
    throw new Error("malformed pyproject.toml: unterminated dependencies array");
  }
  return { open, close };
}

function locateDepsArray(text: string, tableStart: number, tableEnd: number): ArraySpan | null {
  // Look for the `dependencies` key inside this table only.
  const slice = text.slice(tableStart, tableEnd);
  const m = DEPS_KEY_RE.exec(slice);
  if (!m) return null;
  return bracketSpanFrom(text, tableStart + m.index + m[0].length - 1);
}

/** Locate a top-level `project.dependencies = [...]` dotted key, which declares
 *  the same thing as a `[project]` table with a `dependencies` key and needs no
 *  `[project]` header to be present at all. */
function locateDottedDepsArray(text: string): ArraySpan | null {
  const firstHeader = ANY_HEADER_RE.exec(text);
  const topLevel = firstHeader === null ? text : text.slice(0, firstHeader.index);
  const m = DOTTED_DEPS_KEY_RE.exec(topLevel);
  if (!m) return null;
  return bracketSpanFrom(text, m.index + m[0].length - 1);
}

/** Walk forward from an opening `[` to its matching `]`, respecting strings.
 *  Handles single, double, basic-multiline, and literal-multiline strings, and
 *  the standard TOML escape `\\"`. */
function findMatchingBracket(text: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      // Detect triple-quoted string.
      if (text.slice(i, i + 3) === c.repeat(3)) {
        const end = text.indexOf(c.repeat(3), i + 3);
        if (end === -1) return -1;
        i = end + 3;
        continue;
      }
      // Single-line string. Skip escapes for "; literal strings (') don't escape.
      i++;
      while (i < text.length) {
        if (c === '"' && text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          i++;
          break;
        }
        if (text[i] === "\n" && c === "'") return -1; // unterminated literal
        i++;
      }
      continue;
    }
    if (c === "#") {
      // Skip to end of line.
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Parse the entries out of an array literal `[...]` (including the brackets).
 *  Strips comments and whitespace. Used for tokens that are guaranteed strings
 *  in our domain (PEP 508 specs). */
function parseDepsArray(literal: string): string[] {
  // Strip the surrounding brackets.
  if (!literal.startsWith("[") || !literal.endsWith("]")) {
    throw new Error("parseDepsArray: expected bracketed literal");
  }
  const body = literal.slice(1, -1);
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === ",") {
      i++;
      continue;
    }
    if (c === "#") {
      const nl = body.indexOf("\n", i);
      i = nl === -1 ? body.length : nl;
      continue;
    }
    if (c === '"' || c === "'") {
      // Read until matching quote (no triple-quote support; deps are single-line).
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < body.length) {
        if (quote === '"' && body[j] === "\\" && j + 1 < body.length) {
          value += body[j + 1];
          j += 2;
          continue;
        }
        if (body[j] === quote) break;
        value += body[j];
        j++;
      }
      if (j >= body.length) {
        throw new Error("parseDepsArray: unterminated string");
      }
      out.push(value);
      i = j + 1;
      continue;
    }
    throw new Error(`parseDepsArray: unexpected character '${c}' at offset ${i}`);
  }
  return out;
}

/** Format a list of dep specs as a multi-line TOML array. Empty list collapses
 *  to `[]`. Otherwise: opening `[`, one entry per line (4-space indent,
 *  double-quoted, trailing comma), closing `]`. */
function formatDepsArray(deps: string[]): string {
  if (deps.length === 0) return "[]";
  const lines = deps.map((d) => `    "${d.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}",`);
  return `[\n${lines.join("\n")}\n]`;
}

// --- lockfile io ---

const LOCK_HEADER_PREFIX = "# generated by pyr";

/** Read a flat pip-style lockfile into a Map<canonicalName, fullLine>. Skips
 *  blank lines and comments (including the pyr-generated header). Returns
 *  empty if the file is missing. */
export async function readLock(
  path: string = "requirements.txt",
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const name = parseRequirementName(line);
    if (!name) continue; // unparseable; skip rather than crash
    out.set(name, line);
  }
  return out;
}

/** Write a flat lockfile with one header comment and one entry per line, sorted
 *  by canonical package name. Local-editable self-installs (lines starting with
 *  `-e `) are filtered out so the lock stays portable. */
export async function writeLock(
  lines: string[],
  path: string = "requirements.txt",
): Promise<void> {
  const filtered = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-e "));

  const annotated = filtered
    .map((line) => ({ line, key: parseRequirementName(line) ?? line.toLowerCase() }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const header = `${LOCK_HEADER_PREFIX} ${PYR_VERSION}; do not edit`;
  const body = annotated.map((e) => e.line).join("\n");
  const text = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
  await Deno.writeTextFile(path, text);
}

// --- venv management ---

export async function managedPythonVersion(): Promise<string | null> {
  try {
    return (await Deno.readTextFile(`${PYR_HOME}/python/.version`)).trim();
  } catch {
    return null;
  }
}

/** Exact python-build-standalone build installed under PYR_HOME. Kept
 *  separately from the CPython version so same-version upstream rebuilds can
 *  be selected without changing the version stamps used by project venvs. */
export async function managedPythonBuild(): Promise<string | null> {
  try {
    return (await Deno.readTextFile(`${PYR_HOME}/python/.build`)).trim();
  } catch {
    return null;
  }
}

export async function venvPythonVersion(): Promise<string | null> {
  try {
    return (await Deno.readTextFile(venvPaths().stamp)).trim();
  } catch {
    return null;
  }
}

async function stampVenv(dir: string) {
  const version = await managedPythonVersion();
  if (version) {
    await Deno.writeTextFile(venvPaths(`${dir}/.venv`).stamp, version);
  }
}

async function ensureVenv() {
  const v = venvPaths();
  try {
    await Deno.stat(v.python);
  } catch {
    console.error("no .venv found. run `pyr init` first.");
    Deno.exit(1);
  }

  const stamped = await venvPythonVersion();
  let managed = await managedPythonVersion();

  // If stamps disagree, we'll need to rebuild — which means we'll need a
  // working managed python. Self-heal a missing or incomplete install before
  // touching the venv so an interrupted bootstrap can't strand the user.
  if (managed && stamped && managed !== stamped) {
    await ensurePython();
    managed = await managedPythonVersion();
  }

  if (managed && stamped && managed !== stamped) {
    console.log(
      `python changed (${stamped} -> ${managed}), rebuilding venv...`,
    );
    await Deno.remove(v.root, { recursive: true });

    const venv = new Deno.Command(managedPython(), {
      args: ["-m", "venv", v.root],
    });
    const result = await venv.output();
    if (!result.success) {
      console.error("failed to recreate venv");
      Deno.exit(1);
    }

    await stampVenv(".");

    try {
      const reqs = (await Deno.readTextFile("requirements.txt")).trim();
      if (reqs) {
        console.log("reinstalling packages...");
        const pip = new Deno.Command(venvPaths().pip, {
          args: ["install", "-r", "requirements.txt"],
          stdout: "inherit",
          stderr: "inherit",
        });
        const pipResult = await pip.output();
        if (!pipResult.success) {
          console.error("failed to reinstall packages from requirements.txt");
          Deno.exit(pipResult.code || 1);
        }
      }
    } catch {
      // no requirements.txt
    }

    console.log("venv rebuilt");
  }
}

// --- upgrade ---

async function upgradePython(pin?: PythonPin) {
  const currentVersion = await managedPythonVersion();
  const currentBuild = await managedPythonBuild();
  await installPython(pin);

  const updatedVersion = await managedPythonVersion();
  const updatedBuild = await managedPythonBuild();
  const current = currentBuild ?? currentVersion;
  const updated = updatedBuild ?? updatedVersion;
  if (currentVersion === updatedVersion && currentBuild === updatedBuild) {
    console.log(`already on ${pin ? "requested" : "latest"} python (${updated})`);
  } else {
    console.log(`upgraded ${current} -> ${updated}`);
    if (currentVersion !== updatedVersion) {
      console.log("project venvs will rebuild on next pyr run");
    }
  }
}

/** Canonical release asset filename for the current platform. Release zips
 *  are named `pyr-<os>-<arch>.zip` and contain a single binary named `pyr`
 *  (Unix) or `pyr.exe` (Windows). install.sh and upgradeSelf both depend on
 *  this contract — change it in lockstep with release.yml. */
function platformAssetName(): string {
  const { os, arch } = Deno.build;
  return `pyr-${os}-${arch}.zip`;
}

/** Name of the binary inside a release zip. */
function binaryNameInZip(): string {
  return isWindows() ? "pyr.exe" : "pyr";
}

/** Best-effort cleanup of a stale `pyr.exe.old` left behind by a previous
 *  Windows self-upgrade. Called from main.ts startup. No-op on non-Windows
 *  and when no stale file exists. */
export async function cleanupSelfUpgradeOld(): Promise<void> {
  if (!isWindows()) return;
  const oldPath = `${Deno.execPath()}.old`;
  try {
    await Deno.remove(oldPath);
  } catch {
    // not present, or locked — both fine
  }
}

async function upgradeSelf() {
  console.log(`pyr ${PYR_VERSION}`);

  const resp = await fetch(
    `https://api.github.com/repos/${PYR_REPO}/releases/latest`,
    { headers: githubHeaders() },
  );

  if (!resp.ok) {
    console.error("failed to check for updates");
    Deno.exit(1);
  }

  const release = await resp.json() as {
    tag_name: string;
    assets: GithubReleaseAsset[];
  };
  const latest = release.tag_name.replace(/^v/, "");

  if (latest === PYR_VERSION) {
    console.log("already up to date");
    return;
  }

  const expected = platformAssetName();
  const asset = release.assets.find((a: { name: string }) => a.name === expected);
  if (!asset) {
    console.error(`no binary found for ${expected}`);
    Deno.exit(1);
  }
  const expectedSha256 = await releaseAssetSha256(release, expected);

  console.log(`updating ${PYR_VERSION} -> ${latest}...`);

  // Download the zip into a workspace tmpdir so we can extract and verify
  // before touching the running binary.
  const work = await Deno.makeTempDir({ prefix: "pyr-upgrade-" });
  const zipPath = `${work}/pyr.zip`;
  try {
    await downloadFile(asset.browser_download_url, zipPath, "download failed");
    await verifySha256File(zipPath, expectedSha256, expected);

    // Extract. unzip is standard on macOS/Linux. On Windows we use
    // PowerShell's Expand-Archive rather than `tar` — `tar` on a Git Bash
    // PATH resolves to GNU tar (/usr/bin/tar), which can't read zip and also
    // chokes on `C:\...` paths (interprets them as host:path). Expand-Archive
    // ships with every Windows 10+ install via PowerShell.
    const spinner = makeSpinner("extracting...");
    const extractCmd = isWindows()
      ? new Deno.Command("powershell", {
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${
            work.replace(/'/g, "''")
          }' -Force`,
        ],
        stderr: "piped",
        stdout: "piped",
      })
      : new Deno.Command("unzip", {
        args: ["-qo", zipPath, "-d", work],
        stderr: "piped",
        stdout: "piped",
      });
    const extractResult = await extractCmd.output();
    spinner.stop();
    if (!extractResult.success) {
      console.error("failed to extract release zip");
      console.error(new TextDecoder().decode(extractResult.stderr));
      Deno.exit(1);
    }

    const extractedBin = `${work}/${binaryNameInZip()}`;
    try {
      await Deno.stat(extractedBin);
    } catch {
      console.error(`zip did not contain expected binary: ${binaryNameInZip()}`);
      Deno.exit(1);
    }

    const selfPath = Deno.execPath();
    const tmpPath = `${selfPath}.tmp`;
    await Deno.copyFile(extractedBin, tmpPath);
    if (!isWindows()) await Deno.chmod(tmpPath, 0o755);

    // Verify before swapping. Size sanity check first (fast), then exec
    // --version and assert it reports the version we just downloaded.
    const stat = await Deno.stat(tmpPath);
    if ((stat.size ?? 0) < 1_000_000) {
      console.error(`downloaded binary is suspiciously small (${stat.size} bytes)`);
      await Deno.remove(tmpPath).catch(() => {});
      Deno.exit(1);
    }

    const verify = new Deno.Command(tmpPath, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });
    const verifyResult = await verify.output();
    if (!verifyResult.success) {
      console.error("downloaded binary failed to run");
      console.error(new TextDecoder().decode(verifyResult.stderr));
      await Deno.remove(tmpPath).catch(() => {});
      Deno.exit(1);
    }
    const reported = new TextDecoder().decode(verifyResult.stdout).trim();
    if (reported !== latest) {
      console.error(`version mismatch: expected ${latest}, got ${reported}`);
      await Deno.remove(tmpPath).catch(() => {});
      Deno.exit(1);
    }

    // Swap. On Windows the running exe is locked — rename ourselves to .old
    // first, then move the new binary into place. main.ts cleans up .old on
    // next startup.
    if (isWindows()) {
      const oldPath = `${selfPath}.old`;
      try {
        await Deno.remove(oldPath);
      } catch {
        // not present
      }
      await Deno.rename(selfPath, oldPath);
    }
    await Deno.rename(tmpPath, selfPath);

    console.log(`pyr ${latest}`);
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

// --- bootstrap ---

export function platformTripleFor(os: string, arch: string): string {
  const triples: Record<string, Record<string, string>> = {
    darwin: {
      aarch64: "aarch64-apple-darwin",
      x86_64: "x86_64-apple-darwin",
    },
    linux: {
      aarch64: "aarch64-unknown-linux-gnu",
      x86_64: "x86_64-unknown-linux-gnu",
    },
    windows: {
      aarch64: "aarch64-pc-windows-msvc",
      x86_64: "x86_64-pc-windows-msvc",
    },
  };
  const triple = triples[os]?.[arch];
  if (!triple) {
    throw new Error(`unsupported platform: ${os}-${arch}`);
  }
  return triple;
}

export function platformTriple(): string {
  return platformTripleFor(Deno.build.os, Deno.build.arch);
}

export async function ensurePython(): Promise<string> {
  const pythonBin = managedPython();

  // Both the binary AND the .version stamp must exist for the install to count
  // as good. A Ctrl-C'd extraction can leave the binary present but the stamp
  // missing — that's a partial install we should redo, not trust.
  try {
    await Deno.stat(pythonBin);
    await Deno.stat(`${PYR_HOME}/python/.version`);
    return pythonBin;
  } catch {
    // not cached or partial install; bootstrap it
  }

  console.log("bootstrapping python...");
  return await installPython();
}

/** Bootstrap and upgrade share one installer. Keep the live tree until a
 *  replacement has actually run, including when repairing a partial install. */
async function installPython(pin?: PythonPin): Promise<string> {
  // Resolve the platform before creating the lock. An unsupported target must
  // never leave a lock behind, even if platform detection changes to exit or
  // throw differently in the future.
  const triple = platformTriple();
  await Deno.mkdir(PYR_HOME, { recursive: true });
  const lock = `${PYR_HOME}/.python-install-lock`;
  try {
    await Deno.mkdir(lock);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `python installation is locked: ${lock}; if a previous pyr was interrupted, ` +
          "confirm no installer is running and inspect .python-install-* before removing the lock",
      );
    }
    throw error;
  }

  try {
    return await installPythonLocked(triple, pin);
  } finally {
    await Deno.remove(lock);
  }
}

async function installPythonLocked(triple: string, pin?: PythonPin): Promise<string> {
  const pythonBin = managedPython();

  const releaseTag = pin?.build?.slice(pin.version.length + 1);
  const releaseUrl = releaseTag
    ? `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${
      encodeURIComponent(releaseTag)
    }`
    : "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";

  const resp = await fetch(
    releaseUrl,
    { headers: githubHeaders() },
  );

  if (!resp.ok) {
    await resp.body?.cancel();
    if (pin?.build) {
      throw new Error(
        `requested python build ${pin.build} is unavailable (github api: ${resp.status}); ` +
          "existing python is untouched",
      );
    }
    throw new Error(`github api error: ${resp.status}; existing python is untouched`);
  }

  const release = await resp.json() as { tag_name?: string; assets: GithubReleaseAsset[] };
  if (releaseTag && release.tag_name !== releaseTag) {
    throw new Error(
      `requested python build ${pin!.build} resolved an unexpected upstream release; ` +
        "existing python is untouched",
    );
  }

  const pattern = new RegExp(
    `^cpython-(\\d+\\.\\d+\\.\\d+)\\+(\\d+)-${triple}-install_only\\.tar\\.gz$`,
  );

  let builds = release.assets
    .flatMap((asset) => {
      const match = asset.name.match(pattern);
      return match ? [{ asset, version: match[1], build: `${match[1]}+${match[2]}` }] : [];
    });

  if (pin) {
    builds = builds.filter((candidate) =>
      candidate.version === pin.version && (!pin.build || candidate.build === pin.build)
    );
  }

  builds.sort((a, b) =>
    b.version.localeCompare(a.version, undefined, { numeric: true }) ||
    b.build.localeCompare(a.build, undefined, { numeric: true })
  );

  if (builds.length === 0) {
    if (pin) {
      throw new Error(
        `requested python ${pin.build ?? pin.version} has no ${triple} install-only asset in ` +
          `${releaseTag ? `upstream release ${releaseTag}` : "the upstream latest release"}; ` +
          "existing python is untouched",
      );
    }
    throw new Error(`no python build found for ${triple}; existing python is untouched`);
  }

  const { asset, version, build } = builds[0];

  // The semantic version alone cannot distinguish upstream rebuilds. Require
  // the exact build stamp too, then probe the runtime before skipping a
  // download. Legacy installs without .build refresh on the next explicit
  // `pyr upgrade --python`.
  if (
    await managedPythonVersion() === version && await managedPythonBuild() === build &&
    await pythonReportsVersion(pythonBin, version)
  ) {
    return pythonBin;
  }
  const expectedSha256 = await releaseAssetSha256(release, asset.name);

  // Stage on the same filesystem so promotion and rollback use renames.
  const work = await Deno.makeTempDir({ dir: PYR_HOME, prefix: ".python-install-" });
  const staged = `${work}/python`;
  let preserveWork = false;
  try {
    console.log(`downloading cpython ${build}...`);
    const tarPath = `${work}/python.tar.gz`;
    await downloadFile(
      asset.browser_download_url,
      tarPath,
      "download failed; existing python is untouched",
    );
    await verifySha256File(tarPath, expectedSha256, asset.name);

    await Deno.mkdir(staged);
    const spinner = makeSpinner("extracting...");
    // MSYS tar misreads native Windows paths. Use Windows' bundled bsdtar.
    const tarBin = isWindows()
      ? `${Deno.env.get("SystemRoot") ?? "C:\\Windows"}\\System32\\tar.exe`
      : "tar";
    let result: Deno.CommandOutput;
    try {
      result = await new Deno.Command(tarBin, {
        args: ["-xzf", tarPath, "-C", staged, "--strip-components=1"],
        stderr: "piped",
        stdout: "piped",
      }).output();
    } finally {
      spinner.stop();
    }
    if (!result.success) {
      throw new Error(
        `failed to extract python: ${new TextDecoder().decode(result.stderr).trim()}`,
      );
    }

    const stagedBin = isWindows() ? `${staged}/python.exe` : `${staged}/bin/python3`;
    if (!await pythonReportsVersion(stagedBin, version)) {
      throw new Error(`downloaded python failed verification (expected ${version})`);
    }
    await Deno.writeTextFile(`${staged}/.version`, version);
    await Deno.writeTextFile(`${staged}/.build`, build);

    const live = `${PYR_HOME}/python`;
    const previous = `${work}/previous`;
    let hadPrevious = false;
    try {
      await Deno.rename(live, previous);
      hadPrevious = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    try {
      await Deno.rename(staged, live);
    } catch (error) {
      if (hadPrevious) {
        try {
          await Deno.rename(previous, live);
        } catch (rollbackError) {
          preserveWork = true;
          throw new Error(
            `could not restore python; previous installation retained at ${previous}`,
            {
              cause: rollbackError,
            },
          );
        }
      }
      throw error;
    }
  } finally {
    if (!preserveWork) await Deno.remove(work, { recursive: true }).catch(() => {});
  }

  console.log(`python ${build} ready`);
  return pythonBin;
}

async function pythonReportsVersion(python: string, expected: string): Promise<boolean> {
  try {
    const result = await new Deno.Command(python, {
      args: [
        "-I",
        "-c",
        "import sys, venv, ensurepip; print('.'.join(map(str, sys.version_info[:3])))",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return result.success && new TextDecoder().decode(result.stdout).trim() === expected;
  } catch {
    return false;
  }
}

// --- stamps ---

export function pyproject(name: string): string {
  return `[project]
name = "${name}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = []
`;
}

export function stamp(): string {
  return `def main():
    print("hello world")


if __name__ == "__main__":
    main()
`;
}

export function config(): string {
  return `import os

ENV = os.getenv("ENV", "development")
`;
}

export function gitignore(): string {
  return `__pycache__/
*.pyc
.venv/
dist/
*.egg-info/
`;
}
