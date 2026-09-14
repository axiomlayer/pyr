import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

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
  const { ensurePython, upgrade, managedPython, platformTriple, isWindows, sha256Hex } =
    await import(
      `./lib.ts?python-install-test=${crypto.randomUUID()}`
    );
  const version = "3.14.1";
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
  const assetUrl = "https://example.invalid/python.tar.gz";
  const checksumUrl = "https://example.invalid/SHA256SUMS";
  const assetName = `cpython-${version}+20260914-${platformTriple()}-install_only.tar.gz`;
  const release = {
    assets: [{
      name: assetName,
      browser_download_url: assetUrl,
    }, {
      name: "SHA256SUMS",
      browser_download_url: checksumUrl,
    }],
  };
  let calls: string[] = [];
  let releaseResponse: () => Response = () => Response.json(release);
  let checksumResponse: () => Response = () => new Response(`${archiveDigest}  ${assetName}\n`);
  let downloadResponse: () => Response = () => new Response(archiveBytes);
  let reportedVersion: string | undefined;
  let failPromotion = false;
  let failRollback = false;

  globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === releaseUrl) return Promise.resolve(releaseResponse());
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

  async function reset(current: string | null = "3.13.7") {
    await Deno.remove(runtimeHome, { recursive: true }).catch(() => {});
    if (current) {
      await Deno.mkdir(`${runtimeHome}/python/bin`, { recursive: true });
      await Deno.writeTextFile(managedPython(), current);
      await Deno.writeTextFile(`${runtimeHome}/python/.version`, current);
      await Deno.writeTextFile(`${runtimeHome}/python/keep.txt`, "original runtime");
    }
    calls = [];
    releaseResponse = () => Response.json(release);
    checksumResponse = () => new Response(`${archiveDigest}  ${assetName}\n`);
    downloadResponse = () => new Response(archiveBytes);
    reportedVersion = undefined;
    failPromotion = false;
    failRollback = false;
  }

  async function assertPreserved(current = "3.13.7") {
    assertEquals(await Deno.readTextFile(managedPython()), current);
    assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), current);
    assertEquals(await Deno.readTextFile(`${runtimeHome}/python/keep.txt`), "original runtime");
    assertEquals(Array.from(Deno.readDirSync(runtimeHome), (e) => e.name), ["python"]);
  }

  try {
    await t.step("cached bootstrap is offline", async () => {
      await reset();
      assertEquals(await ensurePython(), managedPython());
      assertEquals(calls, []);
      await assertPreserved();
    });
    await t.step("same CPython version uses one GET and no download", async () => {
      await reset(version);
      await upgrade(["--python"]);
      assertEquals(calls, [`GET ${releaseUrl}`]);
      await assertPreserved(version);
    });
    await t.step("metadata rate limit leaves the current runtime intact", async () => {
      await reset();
      releaseResponse = () => new Response("rate limited", { status: 403 });
      await assertRejects(() => upgrade(["--python"]), Error, "github api error: 403");
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
      releaseResponse = () => Response.json({ assets: [release.assets[0]] });
      await assertRejects(() => upgrade(["--python"]), Error, "no SHA256SUMS");
      await assertPreserved();
    });
    await t.step("asset HTTP failure leaves the current runtime intact", async () => {
      await reset();
      downloadResponse = () => new Response("unavailable", { status: 503 });
      await assertRejects(() => upgrade(["--python"]), Error, "download failed");
      await assertPreserved();
    });
    await t.step("tampered archive is rejected before extraction", async () => {
      await reset();
      const tampered = archiveBytes.slice();
      tampered[0] ^= 0xff;
      downloadResponse = () => new Response(tampered);
      await assertRejects(() => upgrade(["--python"]), Error, "SHA-256 mismatch");
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
      await assertRejects(() => upgrade(["--python"]), Deno.errors.PermissionDenied);
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
    });
    await t.step(
      "successful upgrade promotes the verified runtime and clears staging",
      async () => {
        await reset();
        await upgrade(["--python"]);
        assertEquals(await Deno.readTextFile(managedPython()), version);
        assertEquals(await Deno.readTextFile(`${runtimeHome}/python/.version`), version);
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
        assertEquals(calls, [`GET ${releaseUrl}`, `GET ${checksumUrl}`, `GET ${assetUrl}`]);
      }
    });
    await t.step(
      "an active installer excludes another writer before any network request",
      async () => {
        await reset();
        await Deno.mkdir(`${runtimeHome}/.python-install-lock`);
        await assertRejects(() => upgrade(["--python"]), Error, "python installation is locked");
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
