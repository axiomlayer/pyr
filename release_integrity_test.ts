import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  executableArchitecture,
  fetchGitHubJson,
  type FetchLike,
  fetchPinnedBytes,
  fetchWithReleasePolicy,
  loadReleaseManifest,
  parseReleaseManifest,
  type ReleaseAssetPin,
  sha256Hex,
  validatePublishedMetadata,
  verifyAssetArchive,
  verifyChecksumManifest,
} from "./scripts/verify-release-integrity.ts";

const manifestUrl = new URL("./release/pyr-v0.1.1.json", import.meta.url);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function releaseApiFixture(manifest: Awaited<ReturnType<typeof loadReleaseManifest>>) {
  return {
    id: manifest.release.releaseId,
    tag_name: manifest.release.tag,
    target_commitish: manifest.release.targetCommitish,
    published_at: manifest.release.publishedAt,
    draft: false,
    prerelease: false,
    assets: [
      {
        id: manifest.checksumManifest.releaseAssetId,
        name: manifest.checksumManifest.name,
        size: manifest.checksumManifest.size,
        state: "uploaded",
        digest: `sha256:${manifest.checksumManifest.sha256}`,
        browser_download_url: manifest.checksumManifest.url,
      },
      ...manifest.assets.map((asset) => ({
        id: asset.releaseAssetId,
        name: asset.name,
        size: asset.archive.size,
        state: "uploaded",
        digest: `sha256:${asset.archive.sha256}`,
        browser_download_url: asset.url,
      })),
    ],
  };
}

function tagRefFixture(manifest: Awaited<ReturnType<typeof loadReleaseManifest>>) {
  return {
    ref: `refs/tags/${manifest.release.tag}`,
    object: { type: "commit", sha: manifest.release.commit },
  };
}

function setU16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZipEntries(entries: Array<{ name: string; contents: Uint8Array }>): Uint8Array {
  const encoded = entries.map(({ name, contents }) => ({
    name: new TextEncoder().encode(name),
    contents,
  }));
  const localSize = encoded.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.contents.length,
    0,
  );
  const centralSize = encoded.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const result = new Uint8Array(localSize + centralSize + 22);
  const localOffsets: number[] = [];
  let local = 0;
  for (const entry of encoded) {
    localOffsets.push(local);
    const crc = crc32(entry.contents);
    setU32(result, local, 0x04034b50);
    setU16(result, local + 4, 20);
    setU16(result, local + 6, 0);
    setU16(result, local + 8, 0);
    setU32(result, local + 14, crc);
    setU32(result, local + 18, entry.contents.length);
    setU32(result, local + 22, entry.contents.length);
    setU16(result, local + 26, entry.name.length);
    result.set(entry.name, local + 30);
    result.set(entry.contents, local + 30 + entry.name.length);
    local += 30 + entry.name.length + entry.contents.length;
  }

  let central = localSize;
  for (const [index, entry] of encoded.entries()) {
    const crc = crc32(entry.contents);
    setU32(result, central, 0x02014b50);
    setU16(result, central + 4, 20);
    setU16(result, central + 6, 20);
    setU16(result, central + 8, 0);
    setU16(result, central + 10, 0);
    setU32(result, central + 16, crc);
    setU32(result, central + 20, entry.contents.length);
    setU32(result, central + 24, entry.contents.length);
    setU16(result, central + 28, entry.name.length);
    setU32(result, central + 42, localOffsets[index]);
    result.set(entry.name, central + 46);
    central += 46 + entry.name.length;
  }

  const eocd = localSize + centralSize;
  setU32(result, eocd, 0x06054b50);
  setU16(result, eocd + 8, entries.length);
  setU16(result, eocd + 10, entries.length);
  setU32(result, eocd + 12, centralSize);
  setU32(result, eocd + 16, localSize);
  return result;
}

function storedZip(name: string, contents: Uint8Array): Uint8Array {
  return storedZipEntries([{ name, contents }]);
}

async function deflatedZipWithClaim(
  name: string,
  contents: Uint8Array,
  declaredUncompressedSize: number,
): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(name);
  const compressed = new Uint8Array(
    await new Response(
      new Blob([Uint8Array.from(contents).buffer]).stream().pipeThrough(
        new CompressionStream("deflate-raw"),
      ),
    ).arrayBuffer(),
  );
  const localSize = 30 + nameBytes.length + compressed.length;
  const centralSize = 46 + nameBytes.length;
  const result = new Uint8Array(localSize + centralSize + 22);
  const crc = crc32(contents);

  setU32(result, 0, 0x04034b50);
  setU16(result, 4, 20);
  setU16(result, 8, 8);
  setU32(result, 14, crc);
  setU32(result, 18, compressed.length);
  setU32(result, 22, declaredUncompressedSize);
  setU16(result, 26, nameBytes.length);
  result.set(nameBytes, 30);
  result.set(compressed, 30 + nameBytes.length);

  const central = localSize;
  setU32(result, central, 0x02014b50);
  setU16(result, central + 4, 20);
  setU16(result, central + 6, 20);
  setU16(result, central + 10, 8);
  setU32(result, central + 16, crc);
  setU32(result, central + 20, compressed.length);
  setU32(result, central + 24, declaredUncompressedSize);
  setU16(result, central + 28, nameBytes.length);
  result.set(nameBytes, central + 46);

  const eocd = localSize + centralSize;
  setU32(result, eocd, 0x06054b50);
  setU16(result, eocd + 8, 1);
  setU16(result, eocd + 10, 1);
  setU32(result, eocd + 12, centralSize);
  setU32(result, eocd + 16, central);
  return result;
}

function pe(machine: number): Uint8Array {
  const result = new Uint8Array(128);
  result[0] = 0x4d;
  result[1] = 0x5a;
  setU32(result, 0x3c, 0x40);
  setU32(result, 0x40, 0x00004550);
  setU16(result, 0x44, machine);
  for (let index = 0x50; index < result.length; index++) result[index] = index;
  return result;
}

function elf(machine: number): Uint8Array {
  const result = new Uint8Array(64);
  result.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  setU16(result, 18, machine);
  return result;
}

function machO(cpuType: number): Uint8Array {
  const result = new Uint8Array(32);
  setU32(result, 0, 0xfeedfacf);
  setU32(result, 4, cpuType);
  return result;
}

function sequenceFetch(responses: Array<Response | Error>): FetchLike {
  return () => {
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("unexpected fetch"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
}

async function assetFixture(
  binary: Uint8Array,
  architecture: "aarch64" | "x86_64" = "x86_64",
): Promise<{ asset: ReleaseAssetPin; archive: Uint8Array }> {
  const archive = storedZip("pyr.exe", binary);
  return {
    archive,
    asset: {
      key: `windows-${architecture}`,
      os: "windows",
      architecture,
      releaseAssetId: 1,
      name: `pyr-windows-${architecture}.zip`,
      url: `https://example.invalid/pyr-windows-${architecture}.zip`,
      archive: { size: archive.length, sha256: await sha256Hex(archive) },
      executable: {
        path: "pyr.exe",
        format: "pe",
        size: binary.length,
        sha256: await sha256Hex(binary),
      },
    },
  };
}

Deno.test("checked-in release manifest is complete and contains no mutable endpoint", async () => {
  const manifest = await loadReleaseManifest(manifestUrl);
  assertEquals(manifest.assets.length, 6);
  assertEquals(manifest.ownership.promotionTargetOwner, "axiomlayer");
  assertEquals(manifest.ownership.fleetConsumption, "source-evidence-only");
  const serialized = JSON.stringify(manifest);
  assertEquals(serialized.includes("/latest"), false);
  assertEquals(serialized.includes("releases/download/v0.1.1/"), true);
});

Deno.test("manifest validation refuses a mutable release URL", async () => {
  const raw = JSON.parse(await Deno.readTextFile(manifestUrl));
  raw.checksumManifest.url = "https://github.com/jasenc7/pyr/releases/latest/download/SHA256SUMS";
  assertThrows(
    () => parseReleaseManifest(raw),
    Error,
    "checksumManifest.url must be the exact pinned-tag download URL",
  );
});

Deno.test("published metadata pins release identity, tag commit, and exact asset set", async () => {
  const manifest = await loadReleaseManifest(manifestUrl);
  const release = releaseApiFixture(manifest);
  const ref = tagRefFixture(manifest);
  validatePublishedMetadata(manifest, release, ref);

  for (
    const [field, value, message] of [
      ["id", release.id + 1, "published release ID changed"],
      ["tag_name", "v0.1.1-moved", "published release tag changed"],
      ["target_commitish", "other", "published release target_commitish changed"],
      ["published_at", "2026-09-15T00:00:00Z", "published release timestamp changed"],
      ["draft", true, "pinned release is now a draft or prerelease"],
    ] as const
  ) {
    const changed = clone(release) as Record<string, unknown>;
    changed[field] = value;
    assertThrows(() => validatePublishedMetadata(manifest, changed, ref), Error, message);
  }

  const changedDigest = clone(release);
  changedDigest.assets[1].digest = `sha256:${"0".repeat(64)}`;
  assertThrows(
    () => validatePublishedMetadata(manifest, changedDigest, ref),
    Error,
    "server-side digest changed",
  );

  const incompleteUpload = clone(release);
  incompleteUpload.assets[1].state = "new";
  assertThrows(
    () => validatePublishedMetadata(manifest, incompleteUpload, ref),
    Error,
    "is not in the uploaded state",
  );

  const replacement = clone(release);
  replacement.assets[1].id++;
  assertThrows(
    () => validatePublishedMetadata(manifest, replacement, ref),
    Error,
    "release asset ID changed",
  );

  const resized = clone(release);
  resized.assets[1].size++;
  assertThrows(
    () => validatePublishedMetadata(manifest, resized, ref),
    Error,
    "published size changed",
  );

  const movedAsset = clone(release);
  movedAsset.assets[1].browser_download_url += "?changed";
  assertThrows(
    () => validatePublishedMetadata(manifest, movedAsset, ref),
    Error,
    "download URL changed",
  );

  const appended = clone(release);
  appended.assets.push({
    id: 999,
    name: "surprise.zip",
    size: 1,
    state: "uploaded",
    digest: `sha256:${"0".repeat(64)}`,
    browser_download_url: "https://example.invalid/surprise.zip",
  });
  assertThrows(
    () => validatePublishedMetadata(manifest, appended, ref),
    Error,
    "published release asset names differ",
  );

  const movedTag = clone(ref);
  movedTag.object.sha = "0".repeat(40);
  assertThrows(
    () => validatePublishedMetadata(manifest, release, movedTag),
    Error,
    "pinned tag commit changed",
  );

  const annotatedTag = clone(ref);
  annotatedTag.object.type = "tag";
  assertThrows(
    () => validatePublishedMetadata(manifest, release, annotatedTag),
    Error,
    "pinned tag no longer resolves directly to a commit",
  );
});

Deno.test("release checksum file is independently pinned and exact", async () => {
  const manifest = await loadReleaseManifest(manifestUrl);
  const contents = `${
    manifest.assets.map((asset) => `${asset.archive.sha256}  ${asset.name}`).join("\n")
  }\n`;
  const bytes = new TextEncoder().encode(contents);
  assertEquals(bytes.length, manifest.checksumManifest.size);
  assertEquals(await sha256Hex(bytes), manifest.checksumManifest.sha256);
  await verifyChecksumManifest(manifest, bytes);

  const tampered = bytes.slice();
  tampered[0] = tampered[0] === 0x30 ? 0x31 : 0x30;
  await assertRejects(
    () => verifyChecksumManifest(manifest, tampered),
    Error,
    "SHA256SUMS digest changed",
  );
});

Deno.test("archive and extracted executable pins fail independently", async () => {
  const binary = pe(0x8664);
  const valid = await assetFixture(binary);
  const verified = await verifyAssetArchive(valid.asset, valid.archive);
  assertEquals(verified.binary, binary);

  const archiveTamper = valid.archive.slice();
  archiveTamper[archiveTamper.length - 1] ^= 1;
  await assertRejects(
    () => verifyAssetArchive(valid.asset, archiveTamper),
    Error,
    "archive SHA-256 mismatch",
  );

  const changedBinary = binary.slice();
  changedBinary[0x60] ^= 1;
  const changedArchive = storedZip("pyr.exe", changedBinary);
  const independentlyReapprovedArchive = clone(valid.asset);
  independentlyReapprovedArchive.archive = {
    size: changedArchive.length,
    sha256: await sha256Hex(changedArchive),
  };
  await assertRejects(
    () => verifyAssetArchive(independentlyReapprovedArchive, changedArchive),
    Error,
    "extracted executable SHA-256 mismatch",
  );
});

Deno.test("encoded machine must match the declared release architecture", async () => {
  const x64Binary = pe(0x8664);
  const x64AsArm = await assetFixture(x64Binary, "aarch64");
  x64AsArm.asset.executable.sha256 = await sha256Hex(x64Binary);
  await assertRejects(
    () => verifyAssetArchive(x64AsArm.asset, x64AsArm.archive),
    Error,
    "contains x86_64 code, not aarch64",
  );

  const armBinary = pe(0xaa64);
  const armAsX64 = await assetFixture(armBinary, "x86_64");
  armAsX64.asset.executable.sha256 = await sha256Hex(armBinary);
  await assertRejects(
    () => verifyAssetArchive(armAsX64.asset, armAsX64.archive),
    Error,
    "contains aarch64 code, not x86_64",
  );
});

Deno.test("PE, ELF, and Mach-O headers report only the pinned CPU families", () => {
  assertEquals(executableArchitecture(pe(0x8664), "pe"), "x86_64");
  assertEquals(executableArchitecture(pe(0xaa64), "pe"), "aarch64");
  assertEquals(executableArchitecture(elf(62), "elf"), "x86_64");
  assertEquals(executableArchitecture(elf(183), "elf"), "aarch64");
  assertEquals(executableArchitecture(machO(0x01000007), "mach-o"), "x86_64");
  assertEquals(executableArchitecture(machO(0x0100000c), "mach-o"), "aarch64");
  assertThrows(() => executableArchitecture(pe(0x014c), "pe"), Error, "unsupported PE machine");
  assertThrows(() => executableArchitecture(elf(3), "elf"), Error, "unsupported ELF machine");
  assertThrows(
    () => executableArchitecture(machO(7), "mach-o"),
    Error,
    "unsupported Mach-O CPU type",
  );
});

Deno.test("release ZIP refuses real duplicate entries before extraction", async () => {
  const binary = pe(0x8664);
  const fixture = await assetFixture(binary);
  const changed = storedZipEntries([
    { name: "pyr.exe", contents: binary },
    { name: "pyr.exe", contents: binary },
  ]);
  fixture.asset.archive.sha256 = await sha256Hex(changed);
  fixture.asset.archive.size = changed.length;
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, changed),
    Error,
    "release ZIP must contain exactly one entry; found 2",
  );
});

Deno.test("release ZIP refuses traversal names without filesystem extraction", async () => {
  const binary = pe(0x8664);
  const fixture = await assetFixture(binary);
  const changed = storedZip("../pyr.exe", binary);
  fixture.asset.archive = { size: changed.length, sha256: await sha256Hex(changed) };
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, changed),
    Error,
    "must contain only pyr.exe at its root",
  );
});

Deno.test("release ZIP refuses an inflated-size claim before decompression", async () => {
  const binary = pe(0x8664);
  const fixture = await assetFixture(binary);
  const changed = fixture.archive.slice();
  const view = new DataView(changed.buffer);
  const eocd = changed.length - 22;
  const central = view.getUint32(eocd + 16, true);
  setU32(changed, 22, binary.length + 1);
  setU32(changed, central + 24, binary.length + 1);
  fixture.asset.archive.sha256 = await sha256Hex(changed);
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, changed),
    Error,
    "ZIP executable size differs from the independent pin",
  );
});

Deno.test("release ZIP bounds actual decompression to the independent size pin", async () => {
  const binary = pe(0x8664);
  const fixture = await assetFixture(binary);
  const expanded = new Uint8Array(binary.length + 4096);
  expanded.set(binary);
  expanded.fill(0x41, binary.length);
  const changed = await deflatedZipWithClaim("pyr.exe", expanded, binary.length);
  fixture.asset.archive = { size: changed.length, sha256: await sha256Hex(changed) };
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, changed),
    Error,
    "decompressed executable exceeds the ZIP directory size",
  );
});

Deno.test("release bytes allow only one GitHub CDN redirect and never send authorization", async () => {
  const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect }> =
    [];
  const responses: Response[] = [
    new Response(null, {
      status: 302,
      headers: {
        location: "https://release-assets.githubusercontent.com/object?ephemeral=redacted",
      },
    }),
    new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }),
  ];
  const fetcher: FetchLike = (input, init) => {
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      redirect: init?.redirect ?? "follow",
    });
    const response = responses.shift();
    return response ? Promise.resolve(response) : Promise.reject(new Error("unexpected fetch"));
  };
  const bytes = await fetchPinnedBytes(
    "https://github.com/jasenc7/pyr/releases/download/v0.1.1/SHA256SUMS",
    3,
    fetcher,
  );
  assertEquals(bytes, new Uint8Array([1, 2, 3]));
  assertEquals(requests.map(({ authorization }) => authorization), [null, null]);
  assertEquals(requests.map(({ redirect }) => redirect), ["manual", "manual"]);
  assertEquals(new URL(requests[0].url).hostname, "github.com");
  assertEquals(new URL(requests[1].url).hostname, "release-assets.githubusercontent.com");
});

Deno.test("GitHub API authentication stays on the exact API request", async () => {
  const requests: Array<{
    authorization: string | null;
    apiVersion: string | null;
    url: string;
  }> = [];
  const fetcher: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("authorization"),
      apiVersion: headers.get("x-github-api-version"),
      url: String(input),
    });
    return Promise.resolve(new Response("{}"));
  };
  await fetchGitHubJson(
    "https://api.github.com/repos/jasenc7/pyr/releases/tags/v0.1.1",
    fetcher,
    "fabricated-ci-token",
  );
  assertEquals(requests, [{
    authorization: "Bearer fabricated-ci-token",
    apiVersion: "2022-11-28",
    url: "https://api.github.com/repos/jasenc7/pyr/releases/tags/v0.1.1",
  }]);

  let assetAuthorization: string | null | undefined;
  await fetchWithReleasePolicy(
    "https://github.com/jasenc7/pyr/releases/download/v0.1.1/SHA256SUMS",
    "release-asset",
    (_input, init) => {
      assetAuthorization = new Headers(init?.headers).get("authorization");
      return Promise.resolve(new Response(new Uint8Array()));
    },
    "fabricated-ci-token",
  );
  assertEquals(assetAuthorization, null);
});

Deno.test("network policy refuses API and off-CDN redirects", async () => {
  const apiUrl = "https://api.github.com/repos/jasenc7/pyr/releases/tags/v0.1.1";
  await assertRejects(
    () =>
      fetchWithReleasePolicy(
        apiUrl,
        "github-api",
        sequenceFetch([
          new Response(null, {
            status: 302,
            headers: { location: "https://api.github.com/elsewhere" },
          }),
        ]),
      ),
    Error,
    "refused an API redirect",
  );
  await assertRejects(
    () =>
      fetchPinnedBytes(
        "https://github.com/jasenc7/pyr/releases/download/v0.1.1/SHA256SUMS",
        1,
        sequenceFetch([
          new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid/payload" },
          }),
        ]),
      ),
    Error,
    "refused a redirect outside GitHub's release-asset CDN",
  );
  await assertRejects(
    () =>
      fetchPinnedBytes(
        "https://github.com/jasenc7/pyr/releases/download/v0.1.1/SHA256SUMS",
        1,
        sequenceFetch([
          new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/first" },
          }),
          new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/second" },
          }),
        ]),
      ),
    Error,
    "exceeded its single allowed redirect",
  );
});

Deno.test("network failures and rate limits fail closed without retrying", async () => {
  const apiUrl = "https://api.github.com/repos/jasenc7/pyr/releases/tags/v0.1.1";
  await assertRejects(
    () => fetchGitHubJson(apiUrl, sequenceFetch([new TypeError("offline")])),
    Error,
    "network failure: TypeError",
  );
  await assertRejects(
    () =>
      fetchGitHubJson(
        apiUrl,
        sequenceFetch([new DOMException("signed URL omitted", "TimeoutError")]),
      ),
    Error,
    "network failure: request timed out",
  );
  await assertRejects(
    () => fetchGitHubJson(apiUrl, sequenceFetch([new Response("upstream", { status: 500 })])),
    Error,
    "failed: 500",
  );
  await assertRejects(
    () =>
      fetchGitHubJson(
        apiUrl,
        sequenceFetch([
          new Response("rate limited", {
            status: 403,
            headers: {
              "retry-after": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1800000000",
            },
          }),
        ]),
      ),
    Error,
    "rate limited (403; retry-after=60s, reset=1800000000)",
  );
  await assertRejects(
    () => fetchGitHubJson(apiUrl, sequenceFetch([new Response("slow down", { status: 429 })])),
    Error,
    "rate limited (429)",
  );
  await assertRejects(
    () =>
      fetchGitHubJson(
        apiUrl,
        sequenceFetch([
          new Response('{"message":"You have exceeded a secondary rate limit"}', {
            status: 403,
            headers: { "x-ratelimit-remaining": "4999" },
          }),
        ]),
      ),
    Error,
    "rate limited (403; secondary)",
  );
  await assertRejects(
    () =>
      fetchGitHubJson(
        apiUrl,
        sequenceFetch([
          new Response("forbidden", {
            status: 403,
            headers: { "x-ratelimit-remaining": "4999" },
          }),
        ]),
      ),
    Error,
    "failed: 403",
  );
});

Deno.test("network response bounds reject declared and streamed size mismatches", async () => {
  const url = "https://github.com/jasenc7/pyr/releases/download/v0.1.1/SHA256SUMS";
  await assertRejects(
    () =>
      fetchPinnedBytes(
        url,
        2,
        sequenceFetch([
          new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/object" },
          }),
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }),
        ]),
      ),
    Error,
    "exceeds the 2-byte response limit",
  );
  await assertRejects(
    () =>
      fetchPinnedBytes(
        url,
        3,
        sequenceFetch([
          new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/object" },
          }),
          new Response(new Uint8Array([1, 2])),
        ]),
      ),
    Error,
    "response byte length changed",
  );
});

Deno.test("persistent Windows runners have a trusted-only workflow and exact host routing", async () => {
  const hosted = (await Deno.readTextFile(".github/workflows/release-integrity.yml")).replaceAll(
    "\r\n",
    "\n",
  );
  const native = (await Deno.readTextFile(
    ".github/workflows/release-integrity-native-windows.yml",
  )).replaceAll("\r\n", "\n");
  assertEquals(hosted.includes("\non:\n  pull_request:\n  push:\n"), true);
  const triggerBlock = native.split("\non:\n", 2)[1]?.split("\npermissions:", 1)[0] ?? "";
  for (
    const forbidden of ["pull_request:", "pull_request_target:", "workflow_run:", "workflow_call:"]
  ) {
    assertEquals(triggerBlock.includes(forbidden), false);
  }
  assertEquals(hosted.includes("self-hosted"), false);
  assertEquals(native.includes("group: fleet-trusted"), true);
  assertEquals(native.includes("- self-hosted"), true);
  assertEquals(native.includes("- host: ocelot\n            architecture: aarch64"), true);
  assertEquals(native.includes("- host: siberian\n            architecture: x86_64"), true);
  assertEquals(hosted.includes("runner: ubuntu-24.04-arm"), true);
  assertEquals(hosted.includes("runner: macos-15-intel"), true);
  for (const workflow of [hosted, native]) {
    assertEquals(workflow.includes("environment:"), false);
    assertEquals(workflow.includes("secrets."), false);
    assertEquals(workflow.includes("codex_security_gate"), false);
    assertEquals(workflow.includes("releases/latest"), false);
    assertEquals(workflow.includes("latest/download"), false);
  }
});

Deno.test("pin records both Windows native architectures", async () => {
  const manifest = await loadReleaseManifest(manifestUrl);
  const windows = manifest.assets.filter((asset) => asset.os === "windows");
  assertEquals(windows.map((asset) => asset.architecture).sort(), ["aarch64", "x86_64"]);
  for (const asset of windows) {
    assertEquals(asset.executable.path, "pyr.exe");
    assertEquals(asset.executable.format, "pe");
    assertMatch(asset.executable.sha256, /^[0-9a-f]{64}$/);
  }
});
