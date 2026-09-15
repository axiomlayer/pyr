import { assert, assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

// Test-only sentinel: live code must never depend on GitHub's retired-owner redirect.
const retiredOwnerRepository = "jasenc7/pyr";

Deno.test("Windows installer selects a published asset and handles old ARM releases", async () => {
  const script = await Deno.readTextFile(
    new URL("./site/assets/install.ps1", import.meta.url),
  );
  assertMatch(script, /\$Repo = "axiomlayer\/pyr"/);
  assert(
    !script.includes(retiredOwnerRepository),
    "installer must not depend on the retired owner redirect",
  );
  assertMatch(script, /\$Release\.assets/);
  assertMatch(script, /windows-aarch64/);
  assertMatch(script, /windows-x86_64/);
  assertMatch(script, /no native Windows ARM64 asset/);
  assertMatch(script, /Windows x86_64 emulation/);
  assertMatch(script, /SHA256SUMS/);
  assertMatch(script, /does not contain pyr\.exe at its archive root/);

  const tls = script.indexOf("[Net.ServicePointManager]::SecurityProtocol");
  const firstGithubRequest = script.indexOf("Invoke-RestMethod");
  assert(tls >= 0, "installer must configure TLS");
  assert(firstGithubRequest >= 0, "installer must fetch release metadata");
  assert(tls < firstGithubRequest, "installer must configure TLS before contacting GitHub");
});

Deno.test("POSIX installer is HTTPS-only and redirects Windows compatibility shells", async () => {
  const script = await Deno.readTextFile(
    new URL("./site/assets/install.sh", import.meta.url),
  );
  assertMatch(script, /REPO="axiomlayer\/pyr"/);
  assert(
    !script.includes(retiredOwnerRepository),
    "installer must not depend on the retired owner redirect",
  );
  assertMatch(script, /mingw\*\|msys\*\|cygwin\*/);
  assertMatch(script, /run install\.ps1 from PowerShell/);
  assertMatch(script, /curl --proto '=https' --tlsv1\.2 -fsSL/);

  const platformCheck = script.indexOf('case "$os" in');
  const prerequisiteCheck = script.indexOf("command -v unzip");
  assert(platformCheck >= 0, "installer must classify the host OS");
  assert(prerequisiteCheck >= 0, "installer must check unzip");
  assert(
    platformCheck < prerequisiteCheck,
    "Git Bash must receive Windows guidance before POSIX prerequisite checks",
  );
});
