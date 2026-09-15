import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
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
        digest: `sha256:${manifest.checksumManifest.sha256}`,
        browser_download_url: manifest.checksumManifest.url,
      },
      ...manifest.assets.map((asset) => ({
        id: asset.releaseAssetId,
        name: asset.name,
        size: asset.archive.size,
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

function storedZip(name: string, contents: Uint8Array): Uint8Array {
  const filename = new TextEncoder().encode(name);
  const localSize = 30 + filename.length + contents.length;
  const centralSize = 46 + filename.length;
  const result = new Uint8Array(localSize + centralSize + 22);
  const crc = crc32(contents);

  setU32(result, 0, 0x04034b50);
  setU16(result, 4, 20);
  setU16(result, 6, 0);
  setU16(result, 8, 0);
  setU32(result, 14, crc);
  setU32(result, 18, contents.length);
  setU32(result, 22, contents.length);
  setU16(result, 26, filename.length);
  result.set(filename, 30);
  result.set(contents, 30 + filename.length);

  const central = localSize;
  setU32(result, central, 0x02014b50);
  setU16(result, central + 4, 20);
  setU16(result, central + 6, 20);
  setU16(result, central + 8, 0);
  setU16(result, central + 10, 0);
  setU32(result, central + 16, crc);
  setU32(result, central + 20, contents.length);
  setU32(result, central + 24, contents.length);
  setU16(result, central + 28, filename.length);
  setU32(result, central + 42, 0);
  result.set(filename, central + 46);

  const eocd = central + centralSize;
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

  const changedDigest = clone(release);
  changedDigest.assets[1].digest = `sha256:${"0".repeat(64)}`;
  assertThrows(
    () => validatePublishedMetadata(manifest, changedDigest, ref),
    Error,
    "server-side digest changed",
  );

  const replacement = clone(release);
  replacement.assets[1].id++;
  assertThrows(
    () => validatePublishedMetadata(manifest, replacement, ref),
    Error,
    "release asset ID changed",
  );

  const appended = clone(release);
  appended.assets.push({
    id: 999,
    name: "surprise.zip",
    size: 1,
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
  const fixture = await assetFixture(x64Binary, "aarch64");
  fixture.asset.executable.sha256 = await sha256Hex(x64Binary);
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, fixture.archive),
    Error,
    "contains x86_64 code, not aarch64",
  );
});

Deno.test("release ZIP refuses extra entries before extraction", async () => {
  const binary = pe(0x8664);
  const fixture = await assetFixture(binary);
  const changed = fixture.archive.slice();
  const view = new DataView(changed.buffer);
  const eocd = changed.length - 22;
  view.setUint16(eocd + 8, 2, true);
  view.setUint16(eocd + 10, 2, true);
  fixture.asset.archive.sha256 = await sha256Hex(changed);
  await assertRejects(
    () => verifyAssetArchive(fixture.asset, changed),
    Error,
    "release ZIP must contain exactly one entry",
  );
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
