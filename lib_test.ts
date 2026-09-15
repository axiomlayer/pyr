import {
  assertEquals,
  assertMatch,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fileURLToPath as fromFileUrl } from "node:url";
import {
  addPyprojectDep,
  basename,
  canonicalizeName,
  config,
  gitignore,
  isWindows,
  managedPython,
  parsePythonPin,
  parseRequirementName,
  parseSha256Sums,
  platformTriple,
  platformTripleFor,
  protectedInitDir,
  pyproject,
  pyrHome,
  readLock,
  readPyprojectDeps,
  readPyprojectDepsDetailed,
  removePyprojectDep,
  sha256Hex,
  stamp,
  sync,
  userHome,
  venvPaths,
  writeLock,
} from "./lib.ts";

// --- unit tests ---

Deno.test("release checksum parsing matches exact assets", () => {
  const digest = "a".repeat(64);
  assertEquals(
    parseSha256Sums(`${digest}  pyr-linux-x86_64.zip\n`, "pyr-linux-x86_64.zip"),
    digest,
  );
  assertEquals(
    parseSha256Sums(`${digest} *pyr-linux-x86_64.zip\n`, "pyr-linux-x86_64.zip"),
    digest,
  );
  assertEquals(parseSha256Sums(`${digest}  other.zip\n`, "pyr-linux-x86_64.zip"), null);
  assertEquals(
    parseSha256Sums(`not-a-digest  pyr-linux-x86_64.zip\n`, "pyr-linux-x86_64.zip"),
    null,
  );
});

Deno.test("sha256Hex hashes downloaded bytes", async () => {
  assertEquals(
    await sha256Hex(new TextEncoder().encode("hello")),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
});

Deno.test("basename extracts last segment", () => {
  assertEquals(basename("/foo/bar/baz"), "baz");
  assertEquals(basename("single"), "single");
  assertEquals(basename("/trailing/slash/"), "slash");
  assertEquals(basename("/trailing/slashes///"), "slashes");
  assertEquals(basename(""), "");
  assertEquals(basename("/"), "");
  // Windows-style separators.
  assertEquals(basename("C:\\dev\\proj"), "proj");
  assertEquals(basename("C:\\dev\\proj\\"), "proj");
  assertEquals(basename("a/mixed\\path/here"), "here");
});

Deno.test("platformTriple returns a valid triple", () => {
  const triple = platformTriple();
  assertMatch(
    triple,
    /^(aarch64|x86_64)-(apple-darwin|unknown-linux-gnu|pc-windows-msvc)$/,
  );
});

Deno.test("platformTripleFor rejects unsupported targets without exiting", () => {
  let message = "";
  try {
    platformTripleFor("plan9", "mips64");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertEquals(message, "unsupported platform: plan9-mips64");
});

Deno.test("pyproject stamp contains project name", () => {
  const result = pyproject("myapp");
  assertMatch(result, /name = "myapp"/);
  assertMatch(result, /requires-python/);
});

Deno.test("stamp is runnable python", () => {
  const result = stamp();
  assertMatch(result, /def main\(\)/);
  assertMatch(result, /if __name__/);
});

Deno.test("config stamp has ENV default", () => {
  const result = config();
  assertMatch(result, /ENV.*development/);
});

Deno.test("gitignore includes .venv and __pycache__", () => {
  const result = gitignore();
  assertMatch(result, /\.venv/);
  assertMatch(result, /__pycache__/);
});

// --- platform helpers ---

Deno.test("venvPaths returns shape matching current OS", () => {
  const v = venvPaths();
  assertEquals(v.root, ".venv");
  if (isWindows()) {
    assertEquals(v.binDir, ".venv\\Scripts");
    assertEquals(v.python, ".venv\\Scripts\\python.exe");
    assertEquals(v.pip, ".venv\\Scripts\\pip.exe");
    assertEquals(v.stamp, ".venv\\.pyr-python");
  } else {
    assertEquals(v.binDir, ".venv/bin");
    assertEquals(v.python, ".venv/bin/python");
    assertEquals(v.pip, ".venv/bin/pip");
    assertEquals(v.stamp, ".venv/.pyr-python");
  }
});

Deno.test("venvPaths honors a custom root", () => {
  const v = venvPaths("project/.venv");
  if (isWindows()) {
    assertEquals(v.python, "project/.venv\\Scripts\\python.exe");
  } else {
    assertEquals(v.python, "project/.venv/bin/python");
  }
});

Deno.test("managedPython matches platform", () => {
  const home = pyrHome();
  const expected = isWindows() ? `${home}/python/python.exe` : `${home}/python/bin/python3`;
  assertEquals(managedPython(), expected);
});

Deno.test("pyrHome honors PYR_HOME", () => {
  const prev = Deno.env.get("PYR_HOME");
  try {
    Deno.env.set("PYR_HOME", "/tmp/test-pyr");
    assertEquals(pyrHome(), "/tmp/test-pyr");
  } finally {
    if (prev === undefined) Deno.env.delete("PYR_HOME");
    else Deno.env.set("PYR_HOME", prev);
  }
});

Deno.test("native Windows prefers USERPROFILE while Unix prefers HOME", () => {
  const previousHome = Deno.env.get("HOME");
  const previousProfile = Deno.env.get("USERPROFILE");
  try {
    Deno.env.set("HOME", "/c/Users/fleet-user");
    Deno.env.set("USERPROFILE", "C:\\Users\\fleet-user");
    assertEquals(
      userHome(),
      isWindows() ? "C:\\Users\\fleet-user" : "/c/Users/fleet-user",
    );
  } finally {
    if (previousHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", previousHome);
    if (previousProfile === undefined) Deno.env.delete("USERPROFILE");
    else Deno.env.set("USERPROFILE", previousProfile);
  }
});

Deno.test("release dependency graph has no JSR modules", async () => {
  const mainTs = fromFileUrl(new URL("./main.ts", import.meta.url));
  const configPath = fromFileUrl(new URL("./deno.json", import.meta.url));
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--config", configPath, mainTs],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.success, true, new TextDecoder().decode(result.stderr));
  const graph = new TextDecoder().decode(result.stdout);
  assertEquals(/(?:jsr:|https:\/\/jsr\.io\/)/.test(graph), false);
});

Deno.test("parsePythonPin accepts exact versions and build-qualified pins", () => {
  assertEquals(parsePythonPin("3.14.7"), { version: "3.14.7", build: undefined });
  assertEquals(parsePythonPin("3.14.7+20260901"), {
    version: "3.14.7",
    build: "3.14.7+20260901",
  });
  for (const invalid of ["3.14", "latest", "v3.14.7", "3.14.7+", "3.14.7+nightly"]) {
    assertThrows(() => parsePythonPin(invalid), Error, "expected X.Y.Z or X.Y.Z+BUILD");
  }
});

// --- requirement parsing ---

Deno.test("canonicalizeName follows PEP 503", () => {
  assertEquals(canonicalizeName("Requests"), "requests");
  assertEquals(canonicalizeName("My_Package.Name"), "my-package-name");
  assertEquals(canonicalizeName("a..b__c--d"), "a-b-c-d");
});

Deno.test("parseRequirementName handles common shapes", () => {
  const cases: Array<[string, string | null]> = [
    ["requests", "requests"],
    ["requests==2.31.0", "requests"],
    ["requests>=1.0,<2.0", "requests"],
    ["requests~=2.0", "requests"],
    ["requests[security]", "requests"],
    ["httpx[http2]==0.27.0", "httpx"],
    ["git+https://github.com/org/repo.git@main#egg=foo", "foo"],
    ["foo @ git+https://github.com/org/foo.git", "foo"],
    [`requests; python_version >= "3.8"`, "requests"],
    ["requests  # needed for X", "requests"],
    ["My_Package.Name", "my-package-name"],
    ["-e ./path/to/pkg", null],
    ["--editable ./path/to/pkg", null],
    ["./path/to/pkg", null],
    ["", null],
    ["   # only comment", null],
    ["https://example.com/x.tar.gz", null],
  ];
  for (const [input, expected] of cases) {
    assertEquals(
      parseRequirementName(input),
      expected,
      `input: ${JSON.stringify(input)}`,
    );
  }
});

// --- pyproject io ---

async function withTmpToml(
  initial: string,
  fn: (path: string) => Promise<void>,
): Promise<string> {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(path, initial);
    await fn(path);
    return await Deno.readTextFile(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("readPyprojectDeps returns empty for missing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const deps = await readPyprojectDeps(`${dir}/pyproject.toml`);
    assertEquals(deps, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPyprojectDeps returns empty when [project] is absent", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(path, `[tool.poetry]\nname = "foo"\n`);
    assertEquals(await readPyprojectDeps(path), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPyprojectDeps returns empty list when section is empty", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(
      path,
      `[project]\nname = "foo"\nversion = "0.1.0"\ndependencies = []\n`,
    );
    assertEquals(await readPyprojectDeps(path), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPyprojectDeps preserves specs with extras and constraints", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(
      path,
      `[project]\nname = "foo"\ndependencies = [\n  "requests>=2,<3",\n  "httpx[http2]==0.27.0",\n]\n`,
    );
    assertEquals(await readPyprojectDeps(path), [
      "requests>=2,<3",
      "httpx[http2]==0.27.0",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPyprojectDeps decodes quoted markers and ignores later tables", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(
      path,
      `[project]\ndependencies = [\n  "typing-extensions; python_version < \\"3.13\\"", # compatibility\n]\n\n[tool.example]\ndependencies = ["wrong"]\n`,
    );
    assertEquals(await readPyprojectDeps(path), [
      'typing-extensions; python_version < "3.13"',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("addPyprojectDep appends to empty deps", async () => {
  const result = await withTmpToml(
    `[project]\nname = "foo"\nversion = "0.1.0"\ndependencies = []\n`,
    async (p) => {
      await addPyprojectDep("requests", p);
    },
  );
  assertMatch(result, /dependencies = \[\n {4}"requests",\n\]/);
});

Deno.test("addPyprojectDep deduplicates by canonical name", async () => {
  const result = await withTmpToml(
    `[project]\nname = "foo"\ndependencies = [\n    "Requests==1.0",\n]\n`,
    async (p) => {
      await addPyprojectDep("requests==2.31.0", p);
    },
  );
  // Only the new spec should remain (existing "Requests==1.0" canonicalized to
  // "requests" matches the new one and is replaced).
  assertMatch(result, /"requests==2\.31\.0"/);
  assertEquals(result.match(/"[Rr]equests/g)?.length, 1);
});

Deno.test("addPyprojectDep preserves comments and other tables", async () => {
  const initial = `# top-of-file comment
[project]
name = "foo"  # inline comment
dependencies = [
    "click",
]

[tool.ruff]
line-length = 100
`;
  const result = await withTmpToml(initial, async (p) => {
    await addPyprojectDep("requests==2.31.0", p);
  });
  assertMatch(result, /^# top-of-file comment$/m);
  assertMatch(result, /name = "foo" {2}# inline comment/);
  assertMatch(result, /\[tool\.ruff\]/);
  assertMatch(result, /line-length = 100/);
  assertMatch(result, /"click"/);
  assertMatch(result, /"requests==2\.31\.0"/);
});

Deno.test("addPyprojectDep creates dependencies key when missing", async () => {
  const result = await withTmpToml(
    `[project]\nname = "foo"\nversion = "0.1.0"\n`,
    async (p) => {
      await addPyprojectDep("requests", p);
    },
  );
  assertMatch(result, /dependencies = \[\n {4}"requests",\n\]/);
});

Deno.test("addPyprojectDep errors when [project] is missing", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(path, `[tool.poetry]\nname = "foo"\n`);
    let threw = false;
    try {
      await addPyprojectDep("requests", path);
    } catch (e) {
      threw = true;
      assertMatch(String(e), /missing \[project\]/);
    }
    assertEquals(threw, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("removePyprojectDep deletes by canonical name", async () => {
  const initial = `[project]
name = "foo"
dependencies = [
    "Requests==1.0",
    "click",
]
`;
  const result = await withTmpToml(initial, async (p) => {
    const removed = await removePyprojectDep("requests", p);
    assertEquals(removed, true);
  });
  assertEquals(/[Rr]equests/.test(result), false);
  assertMatch(result, /"click"/);
});

Deno.test("removePyprojectDep returns false when name not present", async () => {
  const initial = `[project]\nname = "foo"\ndependencies = [\n    "click",\n]\n`;
  await withTmpToml(initial, async (p) => {
    const removed = await removePyprojectDep("requests", p);
    assertEquals(removed, false);
  });
});

// --- lockfile io ---

Deno.test("readLock returns empty for missing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const m = await readLock(`${dir}/requirements.txt`);
    assertEquals(m.size, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLock parses pinned entries keyed by canonical name", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    await Deno.writeTextFile(
      path,
      `# generated by pyr 0.2.0; do not edit
Requests==2.31.0
httpx[http2]==0.27.0
`,
    );
    const m = await readLock(path);
    assertEquals(m.size, 2);
    assertEquals(m.get("requests"), "Requests==2.31.0");
    assertEquals(m.get("httpx"), "httpx[http2]==0.27.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readLock skips comments and blanks", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    await Deno.writeTextFile(path, `# header\n\n# another comment\nclick==8.1.7\n\n`);
    const m = await readLock(path);
    assertEquals(m.size, 1);
    assertEquals(m.get("click"), "click==8.1.7");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeLock emits sorted entries with header", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    await writeLock(["requests==2.31.0", "click==8.1.7", "anyio==4.3.0"], path);
    const text = await Deno.readTextFile(path);
    const lines = text.split("\n");
    assertMatch(lines[0], /^# generated by pyr/);
    assertEquals(lines.slice(1, 4), ["anyio==4.3.0", "click==8.1.7", "requests==2.31.0"]);
    // Trailing newline.
    assertEquals(lines[4], "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeLock filters local-editable self-installs", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    await writeLock(["click==8.1.7", "-e .", "-e file:///tmp/foo"], path);
    const text = await Deno.readTextFile(path);
    assertEquals(/^-e /m.test(text), false);
    assertMatch(text, /^click==8\.1\.7$/m);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeLock + readLock round-trip preserves VCS-style entries", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    const input = [
      "anyio==4.3.0",
      "foo @ git+https://github.com/org/foo.git@main",
      "httpx[http2]==0.27.0",
    ];
    await writeLock(input, path);
    const m = await readLock(path);
    assertEquals(m.size, 3);
    assertEquals(m.get("anyio"), "anyio==4.3.0");
    assertEquals(m.get("foo"), "foo @ git+https://github.com/org/foo.git@main");
    assertEquals(m.get("httpx"), "httpx[http2]==0.27.0");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("writeLock with empty input writes header only", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/requirements.txt`;
  try {
    await writeLock([], path);
    const text = await Deno.readTextFile(path);
    assertMatch(text, /^# generated by pyr [^\n]+\n$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- guards ---

/** Run `deno run -A main.ts <args>` from `cwd`, capturing stdout/stderr/code.
 *  Used to test guards that call Deno.exit, which would terminate the test
 *  runner if invoked in-process. */
async function runPyr(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  // fromFileUrl, not URL.pathname: on Windows the latter yields "/C:/..." which
  // Deno can load but won't discover deno.json from. Pass --config explicitly
  // so resolution never depends on the subprocess cwd (always a temp dir).
  const mainTs = fromFileUrl(new URL("./main.ts", import.meta.url));
  const config = fromFileUrl(new URL("./deno.json", import.meta.url));
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", config, mainTs, ...args],
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await cmd.output();
  return {
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

Deno.test("handler failures are concise and do not escape as uncaught promises", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const invalidHome = `${tmp}/not-a-directory`;
    await Deno.writeTextFile(invalidHome, "file blocks PYR_HOME");
    const result = await runPyr(tmp, ["upgrade", "--python"], {
      PYR_HOME: invalidHome,
    });
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("Uncaught"), false);
    assertEquals(result.stderr.trim().length > 0, true);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("top-level parser rejects unknown options before dispatch", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const result = await runPyr(tmp, ["--typo", "init", "must-not-exist"]);
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /unknown option: --typo/);
    assertEquals(await exists(`${tmp}/must-not-exist`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("init refuses non-empty target dir", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/myproject`);
    await Deno.writeTextFile(`${tmp}/myproject/existing.txt`, "hi");
    const result = await runPyr(tmp, ["init", "myproject"]);
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /exists and is not empty/);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("init refuses to overwrite sentinel files in cwd", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${tmp}/pyproject.toml`, `[project]\nname = "x"\n`);
    const result = await runPyr(tmp, ["init"]);
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /refusing to overwrite pyproject\.toml/);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("protectedInitDir flags home and roots, not ordinary dirs", () => {
  assertEquals(protectedInitDir("/home/jasen", "/home/jasen"), "home");
  assertEquals(protectedInitDir("/home/jasen/", "/home/jasen"), "home");
  assertEquals(protectedInitDir("/home/jasen/dev/proj", "/home/jasen"), null);
  assertEquals(protectedInitDir("/home/jasen", undefined), null);
  assertEquals(protectedInitDir("/", "/home/jasen"), "root");
  assertEquals(protectedInitDir("C:\\", "C:\\Users\\jasen"), "root");
  assertEquals(protectedInitDir("C:\\Users\\jasen", "C:/Users/jasen/"), "home");
  assertEquals(protectedInitDir("C:\\Users\\jasen\\dev", "C:\\Users\\jasen"), null);
  if (isWindows()) {
    assertEquals(protectedInitDir("c:\\users\\JASEN", "C:\\Users\\jasen"), "home");
  }
});

Deno.test("protectedInitDir flags UNC and extended-length roots", () => {
  // A share root is as unsafe to scaffold into as a drive root.
  assertEquals(protectedInitDir("\\\\server\\share", "C:\\Users\\jasen"), "root");
  assertEquals(protectedInitDir("\\\\server\\share\\", "C:\\Users\\jasen"), "root");
  assertEquals(protectedInitDir("//server/share", "/home/jasen"), "root");
  assertEquals(protectedInitDir("\\\\server", "C:\\Users\\jasen"), "root");
  // Anything below the share is an ordinary directory.
  assertEquals(protectedInitDir("\\\\server\\share\\proj", "C:\\Users\\jasen"), null);
  assertEquals(protectedInitDir("//server/share/team/proj", "/home/jasen"), null);
  // A home directory on a share is still home, not root.
  assertEquals(
    protectedInitDir("\\\\server\\share\\jasen", "\\\\server\\share\\jasen"),
    "home",
  );
  // Extended-length prefixes unwrap to the same answers.
  assertEquals(protectedInitDir("\\\\?\\C:\\", "C:\\Users\\jasen"), "root");
  assertEquals(protectedInitDir("\\\\?\\C:\\Users\\jasen\\dev", "C:\\Users\\jasen"), null);
  assertEquals(protectedInitDir("\\\\?\\UNC\\server\\share", "C:\\Users\\jasen"), "root");
  assertEquals(protectedInitDir("\\\\?\\UNC\\server\\share\\proj", "C:\\Users\\jasen"), null);
});

Deno.test("init with no name refuses the home directory", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Point both home variables at the temp dir and run from inside it.
    const result = await runPyr(tmp, ["init"], { HOME: tmp, USERPROFILE: tmp });
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /refusing to init in your home directory/);
    assertMatch(result.stderr, /pyr init <name>/);
    assertEquals(await exists(`${tmp}/pyproject.toml`), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("init with no name refuses USERPROFILE even when HOME differs", async () => {
  // Regression for the case userHome()'s `??` misses: HOME and USERPROFILE
  // set to different directories. Running from the one HOME doesn't point at
  // must still be refused.
  const home = await Deno.makeTempDir();
  const profile = await Deno.makeTempDir();
  try {
    const result = await runPyr(profile, ["init"], { HOME: home, USERPROFILE: profile });
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /refusing to init in your home directory/);
    assertEquals(await exists(`${profile}/pyproject.toml`), false);
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(profile, { recursive: true });
  }
});

Deno.test("init with no name refuses a filesystem root", async () => {
  // Derive the drive from cwd instead of assuming C: exists. Windows can boot
  // from another letter, and a cwd that does not exist stops the subprocess
  // from starting at all, failing the suite before the guard is exercised.
  const drive = Deno.cwd().match(/^[a-zA-Z]:/)?.[0];
  const root = isWindows() ? `${drive ?? "C:"}\\` : "/";
  const result = await runPyr(root, ["init"]);
  assertEquals(result.code, 1);
  assertMatch(result.stderr, /refusing to init in your root directory/);
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("run errors when app/main.py is missing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const result = await runPyr(tmp, ["run"]);
    assertEquals(result.code, 1);
    assertMatch(result.stderr, /no app\/main\.py found/);
    assertMatch(result.stderr, /pyr init/);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// --- integration ---

Deno.test({
  name: "init creates project structure",
  ignore: Deno.env.get("CI") === "true" && !Deno.env.get("PYR_INTEGRATION"),
  fn: async () => {
    const { init } = await import("./lib.ts");
    const tmp = await Deno.makeTempDir();
    const prev = Deno.cwd();
    Deno.chdir(tmp);

    try {
      await init("testproject");

      const stat = async (p: string) => {
        try {
          await Deno.stat(`testproject/${p}`);
          return true;
        } catch {
          return false;
        }
      };

      assertEquals(await stat("pyproject.toml"), true);
      assertEquals(await stat("requirements.txt"), true);
      assertEquals(await stat(".gitignore"), true);
      assertEquals(await stat("app/__init__.py"), true);
      assertEquals(await stat("app/config.py"), true);
      assertEquals(await stat("app/main.py"), true);
      assertEquals(await stat(venvPaths().python), true);

      const toml = await Deno.readTextFile("testproject/pyproject.toml");
      assertMatch(toml, /name = "testproject"/);
    } finally {
      Deno.chdir(prev);
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "sync resolves, locks, and prunes",
  ignore: Deno.env.get("CI") === "true" && !Deno.env.get("PYR_INTEGRATION"),
  fn: async () => {
    const { init } = await import("./lib.ts");
    const tmp = await Deno.makeTempDir();
    const prev = Deno.cwd();
    Deno.chdir(tmp);

    try {
      await init("syncproject");
      Deno.chdir("syncproject");

      // Add click (small pure-Python pkg) to pyproject; sync should install
      // it and write a flat lock with the pyr header.
      await addPyprojectDep("click==8.1.7");
      await sync({ quiet: true });

      const lockText = await Deno.readTextFile("requirements.txt");
      assertMatch(lockText, /^# generated by pyr/);
      assertMatch(lockText, /^click==8\.1\.7$/m);

      // The venv should now have click importable.
      const importCheck = new Deno.Command(venvPaths().python, {
        args: ["-c", "import click; print(click.__version__)"],
        stdout: "piped",
        stderr: "piped",
      });
      const importResult = await importCheck.output();
      assertEquals(importResult.success, true);
      assertMatch(new TextDecoder().decode(importResult.stdout), /8\.1\.7/);

      // sync is idempotent: a second call with no changes is a no-op.
      const lockBefore = await Deno.readTextFile("requirements.txt");
      await sync({ quiet: true });
      const lockAfter = await Deno.readTextFile("requirements.txt");
      assertEquals(lockBefore, lockAfter);

      // Remove click; sync should prune it from both lock and venv.
      assertEquals(await removePyprojectDep("click"), true);
      await sync({ quiet: true });

      const lockAfterRemove = await Deno.readTextFile("requirements.txt");
      assertEquals(/click/i.test(lockAfterRemove), false);

      const showCheck = new Deno.Command(venvPaths().pip, {
        args: ["show", "click"],
        stdout: "null",
        stderr: "null",
      });
      const showResult = await showCheck.output();
      assertEquals(showResult.success, false); // click is gone
    } finally {
      Deno.chdir(prev);
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// --- pyproject dependency reads: equivalent TOML spellings ---
//
// TOML has more than one valid way to write the same table and the same key.
// A reader that accepts only the preferred spelling returns an empty list for
// a file that genuinely declares dependencies, and sync then treats every
// installed leaf as an orphan and uninstalls the tree. Each case below is a
// valid pyproject that means dependencies = ["requests"].
const EQUIVALENT_REQUESTS: Array<[string, string]> = [
  ["canonical", `[project]\nname = "x"\ndependencies = ["requests"]\n`],
  ["quoted key", `[project]\n"dependencies" = ["requests"]\n`],
  ["literal-quoted key", `[project]\n'dependencies' = ['requests']\n`],
  ["dotted top-level key", `project.dependencies = ["requests"]\n`],
  ["dotted key with spaces", `project . dependencies = ["requests"]\n`],
  ["dotted key, quoted segments", `"project"."dependencies" = ["requests"]\n`],
  ["quoted table header", `["project"]\ndependencies = ["requests"]\n`],
  ["spaced table header", `[ project ]\ndependencies = ["requests"]\n`],
  ["indented header and key", `  [project]\n  dependencies = ["requests"]\n`],
  ["header with trailing comment", `[project] # x\ndependencies = ["requests"]\n`],
  ["tab separators", `[project]\n\tdependencies\t=\t["requests"]\n`],
];

Deno.test("readPyprojectDeps accepts every equivalent TOML spelling", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    for (const [label, text] of EQUIVALENT_REQUESTS) {
      await Deno.writeTextFile(path, text);
      assertEquals(await readPyprojectDeps(path), ["requests"], label);
      const read = await readPyprojectDepsDetailed(path);
      assertEquals(read.kind, "declared", label);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readPyprojectDepsDetailed separates absent from indeterminate", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    // Genuinely no dependency list: pruning against this is correct.
    await Deno.writeTextFile(path, `[project]\nname = "x"\n`);
    assertEquals((await readPyprojectDepsDetailed(path)).kind, "absent");

    // An explicitly empty list is a declaration, not an absence.
    await Deno.writeTextFile(path, `[project]\ndependencies = []\n`);
    const empty = await readPyprojectDepsDetailed(path);
    assertEquals(empty.kind, "declared");
    assertEquals(empty.kind === "declared" ? empty.deps : null, []);

    // The build backend supplies the list. It exists, it is just not here, so
    // reading it as empty would be wrong in the destructive direction.
    await Deno.writeTextFile(
      path,
      `[project]\nname = "x"\ndynamic = ["dependencies"]\n`,
    );
    assertEquals((await readPyprojectDepsDetailed(path)).kind, "indeterminate");

    // dynamic that does not cover dependencies still reads normally.
    await Deno.writeTextFile(
      path,
      `[project]\ndynamic = ["version"]\ndependencies = ["requests"]\n`,
    );
    assertEquals(await readPyprojectDeps(path), ["requests"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a dependencies key outside [project] is not mistaken for one", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    // optional-dependencies is a different table and must not leak in.
    await Deno.writeTextFile(
      path,
      `[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n`,
    );
    assertEquals((await readPyprojectDepsDetailed(path)).kind, "absent");

    // build-system.requires is not the project's dependency list either.
    await Deno.writeTextFile(
      path,
      `[build-system]\nrequires = ["setuptools"]\n[project]\nname = "x"\n`,
    );
    assertEquals((await readPyprojectDepsDetailed(path)).kind, "absent");

    // A dotted project.dependencies below a table header belongs to that
    // table, not to [project], so it must not be read as the project's.
    await Deno.writeTextFile(
      path,
      `[tool.other]\nproject.dependencies = ["requests"]\n`,
    );
    assertEquals(await readPyprojectDeps(path), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("extras, markers and comments survive the read", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pyproject.toml`;
  try {
    await Deno.writeTextFile(
      path,
      `[project]\ndependencies = [\n  "uvicorn[standard]>=0.30", # server\n  'httpx; python_version>="3.11"',\n]\n`,
    );
    assertEquals(await readPyprojectDeps(path), [
      "uvicorn[standard]>=0.30",
      'httpx; python_version>="3.11"',
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
