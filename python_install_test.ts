import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Exercise real download streams, archives, filesystem moves, and cleanup.
// Only the interpreter probe is simulated, so these tests need no CPython
// distribution, network, or platform-specific executable fixture.
Deno.test("Python installation preserves the live runtime until replacement is verified", async (t) => {
  const originalHome = Deno.env.get("PYR_HOME");
  const originalFetch = globalThis.fetch;
  const OriginalCommand = Deno.Command;
  const originalRename = Deno.rename;
  const root = await Deno.makeTempDir();
  const runtimeHome = `${root.replaceAll("\\", "/")}/pyr home`;
  Deno.env.set("PYR_HOME", runtimeHome);
  const {
    ensurePython,
    upgrade,
    managedPython,
    managedPythonBuild,
    platformTriple,
    isWindows,
    sha256Hex,
  } = await import(`./lib.ts?python-install-test=${crypto.randomUUID()}`);
  const version = "3.14.1";
  const build = `${version}+20260914`;
  const previousBuild = `${version}+20260825`;
  const binaryRelative = isWindows() ? "python.exe" : "bin/python3";
  const archiveRoot = `${root}/archive`;
  const fixtureBin = `${archiveRoot}/python/${binaryRelative}`;
  await Deno.mkdir(`${archiveRoot}/python/bin`, { recursive: true });
  await Deno.writeTextFile(fixtureBin, version);
  const tar = isWindows()
    ? `${Deno.env.get("SystemRoot") ?? "C:\\Windows"}\\System32\\tar.exe`
    : "tar";
  const archive = `${root}/python.tar.gz`;
  const packed = await new OriginalCommand(tar, {
    args: ["-czf", archive, "-C", archiveRoot, "python"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(packed.success, true, new TextDecoder().decode(packed.stderr));
  const archiveBytes = await Deno.readFile(archive);
  const archiveDigest = await sha256Hex(archiveBytes);
  const releaseUrl =
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest";
  const pinnedReleaseUrl =
    "https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/20260914";
  const assetUrl = "https://example.invalid/python.tar.gz";
  const previousAssetUrl = "https://example.invalid/python-previous.tar.gz";
  const checksumUrl = "https://example.invalid/SHA256SUMS";
  const assetName = `cpython-${build}-${platformTriple()}-install_only.tar.gz`;
  const previousAssetName = `cpython-${previousBuild}-${platformTriple()}-install_only.tar.gz`;
  const release = {
    tag_name: "20260914",
    assets: [{
      // Deliberately first: selection must not depend on GitHub's asset order.
      name: previousAssetName,
      browser_download_url: previousAssetUrl,
    }, {
      name: assetName,
      browser_download_url: assetUrl,
    }, {
      name: "SHA256SUMS",
      browser_download_url: checksumUrl,
    }],
  };
  let calls: string[] = [];
  let releaseResponse: () => Response = () => Response.json(release);
  let pinnedReleaseResponse: () => Response = () => Response.json(release);
  let checksumResponse: () => Response = () => new Response(`${archiveDigest}  ${assetName}\n`);
  let downloadResponse: () => Response = () => new Response(archiveBytes);
  let reportedVersion: string | undefined;
  let failPromotion = false;
  let failRollback = false;

  globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === releaseUrl) return Promise.resolve(releaseResponse());
    if (url === pinnedReleaseUrl) return Promise.resolve(pinnedReleaseResponse());
    if (url === checksumUrl) return Promise.resolve(checksumResponse());
    if (url === assetUrl) return Promise.resolve(downloadResponse());
    throw new Error(`unexpected network request: ${url}`);
  };
  Deno.Command = class extends OriginalCommand {
    constructor(private command: string | URL, private options?: Deno.CommandOptions) {
      super(command, options);
    }
    override async output(): Promise<Deno.CommandOutput> {
      if (!String(this.command).replaceAll("\\", "/").endsWith(`/${binaryRelative}`)) {
        return await super.output();
      }
      assertEquals(this.options?.args?.slice(0, 2), ["-I", "-c"]);
      // A missing fixture must fail just like a missing interpreter would.
      const fixtureVersion = await Deno.readTextFile(this.command);
      return {
        success: true,
        code: 0,
        signal: null,
        stdout: new TextEncoder().encode(`${reportedVersion ?? fixtureVersion}\n`),
        stderr: new Uint8Array(),
      };
    }
  };
  Deno.rename = async (from, to) => {
    const source = String(from).replaceAll("\\", "/");
    const destination = String(to).replaceAll("\\", "/");
    if (destination === `${runtimeHome}/python`) {
      if (failPromotion && source.endsWith("/python")) {
        throw new Deno.errors.PermissionDenied("simulated promotion failure");
      }
      if (failRollback && source.endsWith("/previous")) {
        throw new Deno.errors.PermissionDenied("simulated rollback failure");
      }
    }
    await originalRename(from, to);
  };

  async function reset(
    current: string | null = "3.13.7",
    currentBuild: string | null = current ? `${current}+20260825` : null,
  ) {
    await Deno.remove(runtimeHome, { recursive: true }).catch(() => {});
    if (current) {
      await Deno.mkdir(`${runtimeHome}/python/bin`, { recursive: true });
      await Deno.writeTextFile(managedPython(), current);
      await Deno.writeTextFile(`${runtimeHome}/python/.version`, current);
      if (currentBuild) {
        await Deno.writeTextFile(`${runtimeHome}/python/.build`, currentBuild);
      }
      await Deno.writeTextFile(`${runtimeHome}/python/keep.txt`, "original runtime");
    }
    calls = [];
    releaseResponse = () => Response.json(release);
    pinnedReleaseResponse = () => Response.json(release);
    checksumResponse = () => new Response(`${archiveDigest}  ${assetName}\n`);
    downloadResponse = () => new Response(archiveBytes);
    reportedVersion = undefined;
    failPromotion = false;
    failRollback = false;
  }

  async function assertPreserved(
    current = "3.13.7",
    currentBuild: string | null = `${current}+20260825`,
  ) {
    assertEquals(await Deno.readTextFile(managedPython()), current);
    assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), current);
    assertEquals(await managedPythonBuild(), currentBuild);
    assertEquals(await Deno.readTextFile(`${runtimeHome}/python/keep.txt`), "original runtime");
    assertEquals(Array.from(Deno.readDirSync(runtimeHome), (e) => e.name), ["python"]);
  }

  try {
    await t.step("cached bootstrap is offline with new or legacy stamps", async () => {
      for (const currentBuild of ["3.13.7+20260825", null]) {
        await reset("3.13.7", currentBuild);
        assertEquals(await ensurePython(), managedPython());
        assertEquals(calls, []);
        await assertPreserved("3.13.7", currentBuild);
      }
    });
    await t.step("same CPython build uses one GET and no download", async () => {
      await reset(version, build);
      await upgrade(["--python"]);
      assertEquals(calls, [`GET ${releaseUrl}`]);
      await assertPreserved(version, build);
    });
    await t.step("newer same-version rebuild is selected and installed", async () => {
      await reset(version, previousBuild);
      await upgrade(["--python"]);
      assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      assertEquals(await Deno.readTextFile(managedPython()), version);
      assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
      assertEquals(await managedPythonBuild(), build);
      assertEquals(Array.from(Deno.readDirSync(runtimeHome), (e) => e.name), ["python"]);
    });
    await t.step("semantic pin selects only the requested CPython version", async () => {
      await reset("3.13.7");
      const otherAsset = {
        name: `cpython-3.15.0+20260914-${platformTriple()}-install_only.tar.gz`,
        browser_download_url: "https://example.invalid/python-3.15.tar.gz",
      };
      releaseResponse = () =>
        Response.json({
          ...release,
          assets: [otherAsset, ...release.assets],
        });
      await upgrade(["--python", version]);
      assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
      assertEquals(await managedPythonBuild(), build);
    });
    await t.step("build-qualified pin resolves that immutable upstream release", async () => {
      await reset("3.13.7");
      await upgrade(["--python", build]);
      assertEquals(calls, [
        `GET ${pinnedReleaseUrl}`,
        `GET ${checksumUrl}`,
        `GET ${assetUrl}`,
      ]);
      assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
      assertEquals(await managedPythonBuild(), build);
    });
    await t.step("missing semantic pin never falls back to another version", async () => {
      await reset();
      releaseResponse = () =>
        Response.json({
          tag_name: "20260914",
          assets: [{
            name: `cpython-3.15.0+20260914-${platformTriple()}-install_only.tar.gz`,
            browser_download_url: "https://example.invalid/python-3.15.tar.gz",
          }, release.assets[2]],
        });
      await assertRejects(
        () => upgrade(["--python", version]),
        Error,
        `requested python ${version}`,
      );
      assertEquals(calls, [`GET ${releaseUrl}`]);
      await assertPreserved();
    });
    await t.step("missing exact build never falls back within its release", async () => {
      await reset();
      pinnedReleaseResponse = () =>
        Response.json({
          tag_name: "20260914",
          assets: [release.assets[0], release.assets[2]],
        });
      await assertRejects(
        () => upgrade(["--python", build]),
        Error,
        `requested python ${build}`,
      );
      assertEquals(calls, [`GET ${pinnedReleaseUrl}`]);
      await assertPreserved();
    });
    await t.step("missing pinned release never falls back to latest", async () => {
      await reset();
      pinnedReleaseResponse = () => new Response("not found", { status: 404 });
      await assertRejects(
        () => upgrade(["--python", build]),
        Error,
        `requested python build ${build} is unavailable`,
      );
      assertEquals(calls, [`GET ${pinnedReleaseUrl}`]);
      await assertPreserved();
    });
    await t.step("invalid pin is rejected before locking or network", async () => {
      await reset();
      await assertRejects(
        () => upgrade(["--python", "3.14"]),
        Error,
        "expected X.Y.Z or X.Y.Z+BUILD",
      );
      assertEquals(calls, []);
      await assertPreserved();
    });
    await t.step("legacy version-only stamp refreshes to an exact build", async () => {
      await reset(version, null);
      await upgrade(["--python"]);
      assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
      assertEquals(await managedPythonBuild(), build);
    });
    await t.step("metadata rate limit leaves the current runtime intact", async () => {
      await reset();
      releaseResponse = () => new Response("rate limited", { status: 403 });
      await assertRejects(() => upgrade(["--python"]), Error, "github api error: 403");
      await assertPreserved();
    });
    // A bare "403" sends a reader looking for a permissions problem. These two
    // steps pin the message to the cause and the fix, because that is the
    // whole point of the header read: a 403 with remaining=0 is a queue, not a
    // refusal, and which one it is decides what the human does next.
    await t.step("an exhausted shared pool names the token as the fix", async () => {
      await reset();
      // Both names are cleared, not just one: pyr accepts either, so leaving
      // GH_TOKEN set would make this step report "authenticated" on a runner
      // that happens to export it and pass or fail by environment.
      const before = { gh: Deno.env.get("GH_TOKEN"), github: Deno.env.get("GITHUB_TOKEN") };
      Deno.env.delete("GITHUB_TOKEN");
      Deno.env.delete("GH_TOKEN");
      try {
        releaseResponse = () =>
          new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-limit": "60",
              "x-ratelimit-reset": "1789430400",
            },
          });
        const error = await assertRejects(() => upgrade(["--python"]), Error);
        assertStringIncludes(error.message, "rate limited (unauthenticated, 60 per hour");
        assertStringIncludes(error.message, "set GITHUB_TOKEN");
        assertStringIncludes(error.message, "2026-09-15T00:00:00Z");
      } finally {
        for (
          const [name, value] of [["GH_TOKEN", before.gh], ["GITHUB_TOKEN", before.github]] as const
        ) {
          if (value === undefined) Deno.env.delete(name);
          else Deno.env.set(name, value);
        }
      }
      await assertPreserved();
    });
    // The fleet is split on the name: dotfiles' workflow exports GH_TOKEN and
    // .agentic-dotfiles' exports GITHUB_TOKEN. Reading only one would make a
    // token that is present look like no token at all.
    await t.step("GH_TOKEN alone counts as authenticated", async () => {
      await reset();
      const before = { gh: Deno.env.get("GH_TOKEN"), github: Deno.env.get("GITHUB_TOKEN") };
      Deno.env.delete("GITHUB_TOKEN");
      Deno.env.set("GH_TOKEN", "stand-in");
      try {
        releaseResponse = () =>
          new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000" },
          });
        const error = await assertRejects(() => upgrade(["--python"]), Error);
        assertStringIncludes(error.message, "rate limited (authenticated");
        assertStringIncludes(error.message, "budget is spent");
      } finally {
        for (
          const [name, value] of [["GH_TOKEN", before.gh], ["GITHUB_TOKEN", before.github]] as const
        ) {
          if (value === undefined) Deno.env.delete(name);
          else Deno.env.set(name, value);
        }
      }
      await assertPreserved();
    });
    // GitHub throttles in two ways and only one sets remaining to 0. A
    // secondary limit is identifiable by retry-after when it is sent and by
    // the body phrase when it is not, so both paths are pinned; reporting one
    // of these as an ordinary refusal is the ambiguity this all exists to end.
    await t.step("retry-after is reported as GitHub's own instruction", async () => {
      await reset();
      releaseResponse = () =>
        new Response("slow down", { status: 403, headers: { "retry-after": "60" } });
      const error = await assertRejects(() => upgrade(["--python"]), Error);
      assertStringIncludes(error.message, "GitHub asks for 60s before retrying");
      await assertPreserved();
    });
    await t.step("a secondary limit with no headers is read from the body", async () => {
      await reset();
      releaseResponse = () =>
        new Response(
          JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
          { status: 403, headers: { "x-ratelimit-remaining": "4999" } },
        );
      const error = await assertRejects(() => upgrade(["--python"]), Error);
      assertStringIncludes(error.message, "secondary rate limit");
      assertStringIncludes(error.message, "wait at least a minute");
      await assertPreserved();
    });
    await t.step("a 403 that is not a rate limit does not blame the token", async () => {
      await reset();
      releaseResponse = () =>
        new Response("forbidden", {
          status: 403,
          headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000" },
        });
      const error = await assertRejects(() => upgrade(["--python"]), Error);
      assertEquals(error.message.includes("rate limited"), false, error.message);
      await assertPreserved();
    });
    await t.step("metadata connection failure leaves the current runtime intact", async () => {
      await reset();
      releaseResponse = () => {
        throw new TypeError("offline");
      };
      await assertRejects(() => upgrade(["--python"]), TypeError, "offline");
      await assertPreserved();
    });
    await t.step("missing platform build does not remove Python", async () => {
      await reset();
      releaseResponse = () => Response.json({ assets: [] });
      await assertRejects(() => upgrade(["--python"]), Error, "no python build found");
      await assertPreserved();
    });
    await t.step("missing checksum manifest leaves Python untouched", async () => {
      await reset();
      releaseResponse = () => Response.json({ assets: [release.assets[1]] });
      await assertRejects(() => upgrade(["--python"]), Error, "no SHA256SUMS");
      await assertPreserved();
    });
    await t.step("asset HTTP failure leaves the current runtime intact", async () => {
      await reset();
      downloadResponse = () => new Response("unavailable", { status: 503 });
      await assertRejects(() => upgrade(["--python"]), Error, "download failed");
      await assertPreserved();
    });
    await t.step("tampered archive for an exact pin is rejected before extraction", async () => {
      await reset();
      const tampered = archiveBytes.slice();
      tampered[0] ^= 0xff;
      downloadResponse = () => new Response(tampered);
      await assertRejects(() => upgrade(["--python", build]), Error, "SHA-256 mismatch");
      assertEquals(calls, [
        `GET ${pinnedReleaseUrl}`,
        `GET ${checksumUrl}`,
        `GET ${assetUrl}`,
      ]);
      await assertPreserved();
    });
    await t.step("interrupted download removes staging and keeps the current runtime", async () => {
      await reset();
      downloadResponse = () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(archiveBytes.slice(0, 10));
              controller.error(new Error("connection lost"));
            },
          }),
        );
      await assertRejects(() => upgrade(["--python"]), Error, "connection lost");
      await assertPreserved();
    });
    await t.step("invalid archive cannot replace Python", async () => {
      await reset();
      downloadResponse = () => new Response("not a tar archive");
      await assertRejects(() => upgrade(["--python"]), Error, "SHA-256 mismatch");
      await assertPreserved();
    });
    await t.step("incorrect interpreter version cannot replace Python", async () => {
      await reset();
      reportedVersion = "3.10.0";
      await assertRejects(() => upgrade(["--python"]), Error, "failed verification");
      await assertPreserved();
    });
    await t.step("failed promotion restores the previous runtime", async () => {
      await reset();
      failPromotion = true;
      await assertRejects(
        () => upgrade(["--python", build]),
        Deno.errors.PermissionDenied,
      );
      await assertPreserved();
    });
    await t.step("failed rollback preserves the recovery tree", async () => {
      await reset();
      failPromotion = true;
      failRollback = true;
      await assertRejects(() => upgrade(["--python"]), Error, "previous installation retained at");
      const entries = Array.from(Deno.readDirSync(runtimeHome));
      assertEquals(entries.length, 1);
      const previous = `${runtimeHome}/${entries[0].name}/previous`;
      assertEquals(await Deno.readTextFile(`${previous}/keep.txt`), "original runtime");
      assertEquals(await Deno.readTextFile(`${previous}/${binaryRelative}`), "3.13.7");
      assertEquals(await Deno.readTextFile(`${previous}/.build`), "3.13.7+20260825");
    });
    await t.step(
      "successful upgrade promotes the verified runtime and clears staging",
      async () => {
        await reset();
        await upgrade(["--python"]);
        assertEquals(await Deno.readTextFile(managedPython()), version);
        assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
        assertEquals(await managedPythonBuild(), build);
        assertEquals(Array.from(Deno.readDirSync(runtimeHome), (e) => e.name), ["python"]);
        assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      },
    );
    await t.step("fresh bootstrap and partial-install repair use the same installer", async () => {
      for (const partial of [false, true]) {
        await reset(null);
        if (partial) {
          await Deno.mkdir(`${runtimeHome}/python/bin`, { recursive: true });
          await Deno.writeTextFile(managedPython(), "unfinished");
        }
        assertEquals(await ensurePython(), managedPython());
        assertEquals(await Deno.readTextFile(managedPython()), version);
        assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
        assertEquals(await managedPythonBuild(), build);
        assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      }
    });
    await t.step(
      "an active installer excludes another writer before any network request",
      async () => {
        await reset();
        await Deno.mkdir(`${runtimeHome}/.python-install-lock`);
        await assertRejects(
          () => upgrade(["--python", build]),
          Error,
          "python installation is locked",
        );
        assertEquals(calls, []);
        await Deno.remove(`${runtimeHome}/.python-install-lock`);
        await assertPreserved();
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    Deno.Command = OriginalCommand;
    Deno.rename = originalRename;
    if (originalHome === undefined) Deno.env.delete("PYR_HOME");
    else Deno.env.set("PYR_HOME", originalHome);
    await Deno.remove(root, { recursive: true });
  }
});
