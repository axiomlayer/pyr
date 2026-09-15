type ReleaseOs = "darwin" | "linux" | "windows";
type Architecture = "aarch64" | "x86_64";
type ExecutableFormat = "elf" | "mach-o" | "pe";

interface PinnedDigest {
  size: number;
  sha256: string;
}

export interface ReleaseAssetPin {
  key: string;
  os: ReleaseOs;
  architecture: Architecture;
  releaseAssetId: number;
  name: string;
  url: string;
  archive: PinnedDigest;
  executable: PinnedDigest & {
    path: string;
    format: ExecutableFormat;
  };
}

export interface ReleaseManifest {
  schemaVersion: number;
  release: {
    repository: string;
    releaseId: number;
    tag: string;
    version: string;
    commit: string;
    targetCommitish: string;
    publishedAt: string;
  };
  ownership: {
    currentOwner: string;
    promotionTargetOwner: string;
    fleetConsumption: string;
  };
  checksumManifest: PinnedDigest & {
    name: string;
    releaseAssetId: number;
    url: string;
  };
  assets: ReleaseAssetPin[];
}

interface VerifiedAsset {
  binary: Uint8Array;
  archiveSha256: string;
  executableSha256: string;
}

const REQUIRED_ASSETS = new Map<string, {
  os: ReleaseOs;
  architecture: Architecture;
  format: ExecutableFormat;
  executable: string;
}>([
  ["darwin-aarch64", {
    os: "darwin",
    architecture: "aarch64",
    format: "mach-o",
    executable: "pyr",
  }],
  ["darwin-x86_64", {
    os: "darwin",
    architecture: "x86_64",
    format: "mach-o",
    executable: "pyr",
  }],
  ["linux-aarch64", {
    os: "linux",
    architecture: "aarch64",
    format: "elf",
    executable: "pyr",
  }],
  ["linux-x86_64", {
    os: "linux",
    architecture: "x86_64",
    format: "elf",
    executable: "pyr",
  }],
  ["windows-aarch64", {
    os: "windows",
    architecture: "aarch64",
    format: "pe",
    executable: "pyr.exe",
  }],
  ["windows-x86_64", {
    os: "windows",
    architecture: "x86_64",
    format: "pe",
    executable: "pyr.exe",
  }],
]);

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function textField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function integerField(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertExactKeys(
  actual: Iterable<string>,
  expected: Iterable<string>,
  label: string,
): void {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (actualSorted.join("\n") !== expectedSorted.join("\n")) {
    fail(
      `${label} differ: expected [${expectedSorted.join(", ")}], got [${actualSorted.join(", ")}]`,
    );
  }
}

/** Parse and fully validate a release pin before any network request is made. */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  const root = record(value, "manifest");
  if (integerField(root.schemaVersion, "schemaVersion") !== 1) {
    fail("unsupported release manifest schemaVersion");
  }

  const release = record(root.release, "release");
  const ownership = record(root.ownership, "ownership");
  const checksum = record(root.checksumManifest, "checksumManifest");
  if (!Array.isArray(root.assets)) fail("assets must be an array");

  const repository = textField(release.repository, "release.repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail("release.repository must be an owner/repository pair");
  }
  const tag = textField(release.tag, "release.tag");
  if (!/^v[0-9A-Za-z._-]+$/.test(tag)) fail("release.tag is not safe for an exact release URL");
  const version = textField(release.version, "release.version");
  if (version !== tag.slice(1)) fail("release.version must equal release.tag without its v prefix");
  const commit = textField(release.commit, "release.commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("release.commit must be a full lowercase Git SHA");
  textField(release.targetCommitish, "release.targetCommitish");
  const publishedAt = textField(release.publishedAt, "release.publishedAt");
  if (Number.isNaN(Date.parse(publishedAt))) fail("release.publishedAt must be an ISO timestamp");

  const currentOwner = textField(ownership.currentOwner, "ownership.currentOwner");
  if (repository.split("/", 1)[0] !== currentOwner) {
    fail("ownership.currentOwner must match the release repository owner");
  }
  if (
    textField(ownership.promotionTargetOwner, "ownership.promotionTargetOwner") !== "axiomlayer"
  ) {
    fail("ownership.promotionTargetOwner must preserve the AxiomLayer promotion boundary");
  }
  if (
    textField(ownership.fleetConsumption, "ownership.fleetConsumption") !== "source-evidence-only"
  ) {
    fail("ownership.fleetConsumption must prevent direct fleet consumption");
  }

  const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;
  const checksumName = textField(checksum.name, "checksumManifest.name");
  if (checksumName !== "SHA256SUMS") fail("checksumManifest.name must be SHA256SUMS");
  if (textField(checksum.url, "checksumManifest.url") !== `${baseUrl}/${checksumName}`) {
    fail("checksumManifest.url must be the exact pinned-tag download URL");
  }
  assertSha256(textField(checksum.sha256, "checksumManifest.sha256"), "checksumManifest.sha256");
  integerField(checksum.size, "checksumManifest.size");
  integerField(checksum.releaseAssetId, "checksumManifest.releaseAssetId");

  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();
  const seenIds = new Set<number>();
  for (const [index, rawAsset] of root.assets.entries()) {
    const asset = record(rawAsset, `assets[${index}]`);
    const key = textField(asset.key, `assets[${index}].key`);
    const required = REQUIRED_ASSETS.get(key);
    if (!required) fail(`assets[${index}].key is not a required release target: ${key}`);
    if (seenKeys.has(key)) fail(`duplicate asset key: ${key}`);
    seenKeys.add(key);

    const os = textField(asset.os, `${key}.os`);
    const architecture = textField(asset.architecture, `${key}.architecture`);
    if (os !== required.os || architecture !== required.architecture) {
      fail(`${key} declares the wrong operating system or architecture`);
    }

    const name = textField(asset.name, `${key}.name`);
    if (name !== `pyr-${key}.zip`) fail(`${key}.name must be pyr-${key}.zip`);
    if (seenNames.has(name)) fail(`duplicate asset name: ${name}`);
    seenNames.add(name);
    if (textField(asset.url, `${key}.url`) !== `${baseUrl}/${name}`) {
      fail(`${key}.url must be the exact pinned-tag download URL`);
    }

    const releaseAssetId = integerField(asset.releaseAssetId, `${key}.releaseAssetId`);
    if (seenIds.has(releaseAssetId)) fail(`duplicate release asset ID: ${releaseAssetId}`);
    seenIds.add(releaseAssetId);

    const archive = record(asset.archive, `${key}.archive`);
    integerField(archive.size, `${key}.archive.size`);
    assertSha256(textField(archive.sha256, `${key}.archive.sha256`), `${key}.archive.sha256`);

    const executable = record(asset.executable, `${key}.executable`);
    if (textField(executable.path, `${key}.executable.path`) !== required.executable) {
      fail(`${key} must contain exactly ${required.executable} at the archive root`);
    }
    if (textField(executable.format, `${key}.executable.format`) !== required.format) {
      fail(`${key} declares the wrong executable format`);
    }
    integerField(executable.size, `${key}.executable.size`);
    assertSha256(
      textField(executable.sha256, `${key}.executable.sha256`),
      `${key}.executable.sha256`,
    );
  }
  assertExactKeys(seenKeys, REQUIRED_ASSETS.keys(), "release asset keys");

  const manifest = value as ReleaseManifest;
  integerField(manifest.release.releaseId, "release.releaseId");
  return manifest;
}

export async function loadReleaseManifest(path: string | URL): Promise<ReleaseManifest> {
  const contents = await Deno.readTextFile(path);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    fail(
      `could not parse release manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseReleaseManifest(value);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apiAssetMap(release: Record<string, unknown>): Map<string, Record<string, unknown>> {
  if (!Array.isArray(release.assets)) fail("release API response has no assets array");
  const assets = new Map<string, Record<string, unknown>>();
  for (const [index, rawAsset] of release.assets.entries()) {
    const asset = record(rawAsset, `release.assets[${index}]`);
    const name = textField(asset.name, `release.assets[${index}].name`);
    if (assets.has(name)) fail(`release API response repeats asset ${name}`);
    assets.set(name, asset);
  }
  return assets;
}

function assertPublishedAsset(
  apiAsset: Record<string, unknown> | undefined,
  expected: {
    name: string;
    releaseAssetId: number;
    url: string;
    size: number;
    sha256: string;
  },
): void {
  if (!apiAsset) fail(`published release is missing ${expected.name}`);
  if (integerField(apiAsset.id, `${expected.name}.id`) !== expected.releaseAssetId) {
    fail(`${expected.name} release asset ID changed`);
  }
  if (integerField(apiAsset.size, `${expected.name}.size`) !== expected.size) {
    fail(`${expected.name} published size changed`);
  }
  if (
    textField(apiAsset.browser_download_url, `${expected.name}.browser_download_url`) !==
      expected.url
  ) {
    fail(`${expected.name} download URL changed`);
  }
  if (textField(apiAsset.digest, `${expected.name}.digest`) !== `sha256:${expected.sha256}`) {
    fail(`${expected.name} server-side digest changed`);
  }
}

/** Validate exact release metadata and the tag ref without trusting either for byte integrity. */
export function validatePublishedMetadata(
  manifest: ReleaseManifest,
  releaseValue: unknown,
  refValue: unknown,
): void {
  const release = record(releaseValue, "release API response");
  if (integerField(release.id, "release.id") !== manifest.release.releaseId) {
    fail("published release ID changed");
  }
  if (textField(release.tag_name, "release.tag_name") !== manifest.release.tag) {
    fail("published release tag changed");
  }
  if (
    textField(release.target_commitish, "release.target_commitish") !==
      manifest.release.targetCommitish
  ) {
    fail("published release target_commitish changed");
  }
  if (textField(release.published_at, "release.published_at") !== manifest.release.publishedAt) {
    fail("published release timestamp changed");
  }
  if (release.draft !== false || release.prerelease !== false) {
    fail("pinned release is now a draft or prerelease");
  }

  const apiAssets = apiAssetMap(release);
  const expectedNames = [
    manifest.checksumManifest.name,
    ...manifest.assets.map((asset) => asset.name),
  ];
  assertExactKeys(apiAssets.keys(), expectedNames, "published release asset names");
  assertPublishedAsset(apiAssets.get(manifest.checksumManifest.name), {
    ...manifest.checksumManifest,
  });
  for (const asset of manifest.assets) {
    assertPublishedAsset(apiAssets.get(asset.name), {
      name: asset.name,
      releaseAssetId: asset.releaseAssetId,
      url: asset.url,
      ...asset.archive,
    });
  }

  const ref = record(refValue, "tag ref API response");
  if (textField(ref.ref, "tag ref.ref") !== `refs/tags/${manifest.release.tag}`) {
    fail("tag ref name changed");
  }
  const object = record(ref.object, "tag ref.object");
  if (textField(object.type, "tag ref.object.type") !== "commit") {
    fail("pinned tag no longer resolves directly to a commit");
  }
  if (textField(object.sha, "tag ref.object.sha") !== manifest.release.commit) {
    fail("pinned tag commit changed");
  }
}

/** Verify the independently pinned checksum-manifest bytes and their exact inventory. */
export async function verifyChecksumManifest(
  manifest: ReleaseManifest,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== manifest.checksumManifest.size) {
    fail("SHA256SUMS byte length changed");
  }
  if (await sha256Hex(bytes) !== manifest.checksumManifest.sha256) {
    fail("SHA256SUMS digest changed");
  }

  let contents: string;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("SHA256SUMS is not valid UTF-8");
  }
  const sums = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) fail(`SHA256SUMS has a malformed line: ${line}`);
    const [, digest, name] = match;
    if (sums.has(name)) fail(`SHA256SUMS repeats ${name}`);
    sums.set(name, digest);
  }
  assertExactKeys(sums.keys(), manifest.assets.map((asset) => asset.name), "SHA256SUMS names");
  for (const asset of manifest.assets) {
    if (sums.get(asset.name) !== asset.archive.sha256) {
      fail(`SHA256SUMS does not match the independent archive pin for ${asset.name}`);
    }
  }
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireRange(bytes: Uint8Array, offset: number, length: number, label: string): void {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    fail(`${label} is outside the ZIP archive`);
  }
}

function u16(view: DataView, offset: number, label: string): number {
  if (offset + 2 > view.byteLength) fail(`${label} is truncated`);
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number, label: string): number {
  if (offset + 4 > view.byteLength) fail(`${label} is truncated`);
  return view.getUint32(offset, true);
}

function decodeFilename(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  compressed: Uint8Array;
}

/** Read the deliberately tiny release ZIP contract without a package-manager dependency. */
export function readOnlyZipEntry(archive: Uint8Array): ZipEntry {
  const view = dataView(archive);
  const minimumEocd = 22;
  if (archive.byteLength < minimumEocd) fail("ZIP archive is too short");
  const searchStart = Math.max(0, archive.byteLength - minimumEocd - 0xffff);
  let eocd = -1;
  for (let offset = archive.byteLength - minimumEocd; offset >= searchStart; offset--) {
    if (u32(view, offset, "ZIP end record") !== 0x06054b50) continue;
    const commentLength = u16(view, offset + 20, "ZIP comment length");
    if (offset + minimumEocd + commentLength === archive.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("ZIP end record is missing");

  if (u16(view, eocd + 4, "ZIP disk") !== 0 || u16(view, eocd + 6, "ZIP central disk") !== 0) {
    fail("multi-disk ZIP archives are forbidden");
  }
  const entriesOnDisk = u16(view, eocd + 8, "ZIP disk entry count");
  const entries = u16(view, eocd + 10, "ZIP entry count");
  if (entriesOnDisk !== 1 || entries !== 1) {
    fail(`release ZIP must contain exactly one entry; found ${entries}`);
  }
  const centralSize = u32(view, eocd + 12, "ZIP central directory size");
  const centralOffset = u32(view, eocd + 16, "ZIP central directory offset");
  if (centralOffset + centralSize !== eocd) {
    fail("ZIP central directory is not contiguous with its end record");
  }
  requireRange(archive, centralOffset, centralSize, "ZIP central directory");
  if (u32(view, centralOffset, "ZIP central entry") !== 0x02014b50) {
    fail("ZIP central directory entry is missing");
  }

  const flags = u16(view, centralOffset + 8, "ZIP flags");
  const method = u16(view, centralOffset + 10, "ZIP compression method");
  const crc = u32(view, centralOffset + 16, "ZIP CRC");
  const compressedSize = u32(view, centralOffset + 20, "ZIP compressed size");
  const uncompressedSize = u32(view, centralOffset + 24, "ZIP uncompressed size");
  const filenameLength = u16(view, centralOffset + 28, "ZIP filename length");
  const extraLength = u16(view, centralOffset + 30, "ZIP extra length");
  const commentLength = u16(view, centralOffset + 32, "ZIP entry comment length");
  const localOffset = u32(view, centralOffset + 42, "ZIP local entry offset");
  const centralEntrySize = 46 + filenameLength + extraLength + commentLength;
  if (centralEntrySize !== centralSize) fail("ZIP contains hidden or trailing central entries");
  requireRange(archive, centralOffset + 46, filenameLength, "ZIP central filename");
  const name = decodeFilename(
    archive.subarray(centralOffset + 46, centralOffset + 46 + filenameLength),
    "ZIP filename",
  );

  if ((flags & 0x0001) !== 0) fail("encrypted ZIP entries are forbidden");
  if ((flags & 0x0008) !== 0) fail("ZIP data descriptors are forbidden");
  if (method !== 0 && method !== 8) fail(`unsupported ZIP compression method ${method}`);
  if (localOffset !== 0) fail("release ZIP must begin with its only local entry");
  if (u32(view, localOffset, "ZIP local entry") !== 0x04034b50) {
    fail("ZIP local entry is missing");
  }
  if (u16(view, localOffset + 6, "ZIP local flags") !== flags) {
    fail("ZIP local and central flags differ");
  }
  if (u16(view, localOffset + 8, "ZIP local method") !== method) {
    fail("ZIP local and central compression methods differ");
  }
  if (u32(view, localOffset + 14, "ZIP local CRC") !== crc) {
    fail("ZIP local and central CRC values differ");
  }
  if (
    u32(view, localOffset + 18, "ZIP local compressed size") !== compressedSize ||
    u32(view, localOffset + 22, "ZIP local uncompressed size") !== uncompressedSize
  ) {
    fail("ZIP local and central sizes differ");
  }
  const localNameLength = u16(view, localOffset + 26, "ZIP local filename length");
  const localExtraLength = u16(view, localOffset + 28, "ZIP local extra length");
  requireRange(archive, localOffset + 30, localNameLength, "ZIP local filename");
  const localName = decodeFilename(
    archive.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    "ZIP local filename",
  );
  if (localName !== name) fail("ZIP local and central filenames differ");
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  requireRange(archive, dataOffset, compressedSize, "ZIP compressed payload");
  if (dataOffset + compressedSize !== centralOffset) {
    fail("ZIP has bytes outside its only entry");
  }
  return {
    name,
    compressionMethod: method,
    compressedSize,
    uncompressedSize,
    compressed: archive.subarray(dataOffset, dataOffset + compressedSize),
  };
}

async function inflate(entry: ZipEntry): Promise<Uint8Array> {
  if (entry.compressionMethod === 0) return entry.compressed.slice();
  let buffer: ArrayBuffer;
  try {
    const stream = new Blob([Uint8Array.from(entry.compressed).buffer]).stream().pipeThrough(
      new DecompressionStream("deflate-raw"),
    );
    buffer = await new Response(stream).arrayBuffer();
  } catch (error) {
    fail(
      `could not decompress ZIP entry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== entry.uncompressedSize) {
    fail("decompressed executable size does not match the ZIP directory");
  }
  return bytes;
}

/** Return the CPU architecture encoded by an ELF, Mach-O, or PE executable header. */
export function executableArchitecture(
  bytes: Uint8Array,
  format: ExecutableFormat,
): Architecture {
  const view = dataView(bytes);
  if (format === "pe") {
    requireRange(bytes, 0, 64, "PE header");
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail("expected an MZ executable");
    const peOffset = u32(view, 0x3c, "PE header offset");
    requireRange(bytes, peOffset, 6, "PE signature");
    if (u32(view, peOffset, "PE signature") !== 0x00004550) fail("expected a PE signature");
    const machine = u16(view, peOffset + 4, "PE machine");
    if (machine === 0xaa64) return "aarch64";
    if (machine === 0x8664) return "x86_64";
    fail(`unsupported PE machine 0x${machine.toString(16)}`);
  }

  if (format === "elf") {
    requireRange(bytes, 0, 20, "ELF header");
    if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      fail("expected an ELF executable");
    }
    if (bytes[4] !== 2 || bytes[5] !== 1) fail("expected a little-endian ELF64 executable");
    const machine = u16(view, 18, "ELF machine");
    if (machine === 183) return "aarch64";
    if (machine === 62) return "x86_64";
    fail(`unsupported ELF machine ${machine}`);
  }

  requireRange(bytes, 0, 8, "Mach-O header");
  if (u32(view, 0, "Mach-O magic") !== 0xfeedfacf) {
    fail("expected a little-endian 64-bit Mach-O executable");
  }
  const cpuType = u32(view, 4, "Mach-O CPU type");
  if (cpuType === 0x0100000c) return "aarch64";
  if (cpuType === 0x01000007) return "x86_64";
  fail(`unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

/** Verify both independently pinned byte layers and the executable's encoded architecture. */
export async function verifyAssetArchive(
  asset: ReleaseAssetPin,
  archive: Uint8Array,
): Promise<VerifiedAsset> {
  if (archive.byteLength !== asset.archive.size) {
    fail(`${asset.name} archive byte length changed`);
  }
  const archiveSha256 = await sha256Hex(archive);
  if (archiveSha256 !== asset.archive.sha256) {
    fail(`${asset.name} archive SHA-256 mismatch`);
  }

  const entry = readOnlyZipEntry(archive);
  if (entry.name !== asset.executable.path) {
    fail(`${asset.name} must contain only ${asset.executable.path} at its root`);
  }
  const binary = await inflate(entry);
  if (binary.byteLength !== asset.executable.size) {
    fail(`${asset.name} extracted executable byte length changed`);
  }
  const executableSha256 = await sha256Hex(binary);
  if (executableSha256 !== asset.executable.sha256) {
    fail(`${asset.name} extracted executable SHA-256 mismatch`);
  }
  const architecture = executableArchitecture(binary, asset.executable.format);
  if (architecture !== asset.architecture) {
    fail(`${asset.name} contains ${architecture} code, not ${asset.architecture}`);
  }
  return { binary, archiveSha256, executableSha256 };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "pyr-release-integrity/1",
    },
  });
  if (!response.ok) fail(`GET ${url} failed: ${response.status}`);
  return await response.json();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: { "User-Agent": "pyr-release-integrity/1" },
  });
  if (!response.ok) fail(`GET ${url} failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function verifyPublishedRelease(
  manifest: ReleaseManifest,
  selectedKeys: string[],
  outputDir?: string,
): Promise<void> {
  const selected = selectedKeys.map((key) => {
    const asset = manifest.assets.find((candidate) => candidate.key === key);
    if (!asset) fail(`unknown release asset key: ${key}`);
    return asset;
  });
  if (new Set(selectedKeys).size !== selectedKeys.length) fail("an asset key was selected twice");

  const repository = manifest.release.repository;
  const tag = manifest.release.tag;
  const apiBase = `https://api.github.com/repos/${repository}`;
  const release = await fetchJson(`${apiBase}/releases/tags/${tag}`);
  const ref = await fetchJson(`${apiBase}/git/ref/tags/${tag}`);
  validatePublishedMetadata(manifest, release, ref);

  const checksumBytes = await fetchBytes(manifest.checksumManifest.url);
  await verifyChecksumManifest(manifest, checksumBytes);
  console.log(
    `verified ${repository} ${tag}: release metadata, tag commit, and ${manifest.checksumManifest.name}`,
  );

  for (const asset of selected) {
    const archive = await fetchBytes(asset.url);
    const verified = await verifyAssetArchive(asset, archive);
    console.log(
      `verified ${asset.name}: archive ${verified.archiveSha256}; executable ${verified.executableSha256}; ${asset.architecture}`,
    );
    if (outputDir) {
      const destinationDir = selected.length === 1 ? outputDir : `${outputDir}/${asset.key}`;
      await Deno.mkdir(destinationDir, { recursive: true });
      const destination = `${destinationDir}/${asset.executable.path}`;
      await Deno.writeFile(destination, verified.binary, { mode: 0o755 });
      if (Deno.build.os !== "windows") await Deno.chmod(destination, 0o755);
      console.log(`wrote verified executable to ${destination}`);
    }
  }
}

interface CliOptions {
  manifestPath: string | URL;
  selectedKeys: string[];
  outputDir?: string;
}

function usage(): string {
  return [
    "usage: deno run --allow-net --allow-read --allow-write scripts/verify-release-integrity.ts",
    "       [--manifest PATH] [--asset KEY ...] [--output-dir PATH]",
    "",
    "With no --asset flag, verifies every pinned release archive.",
  ].join("\n");
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: new URL("../release/pyr-v0.1.1.json", import.meta.url),
    selectedKeys: [],
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      Deno.exit(0);
    }
    if (arg === "--manifest" || arg === "--asset" || arg === "--output-dir") {
      const value = args[++index];
      if (!value) fail(`${arg} requires a value`);
      if (arg === "--manifest") options.manifestPath = value;
      if (arg === "--asset") options.selectedKeys.push(value);
      if (arg === "--output-dir") options.outputDir = value;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (options.selectedKeys.length === 0) options.selectedKeys = [...REQUIRED_ASSETS.keys()];
  return options;
}

if (import.meta.main) {
  try {
    const options = parseArgs(Deno.args);
    const manifest = await loadReleaseManifest(options.manifestPath);
    await verifyPublishedRelease(manifest, options.selectedKeys, options.outputDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
