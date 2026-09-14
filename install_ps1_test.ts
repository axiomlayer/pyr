import { assertMatch } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("Windows installer selects a published asset and handles old ARM releases", async () => {
  const script = await Deno.readTextFile(
    new URL("./site/assets/install.ps1", import.meta.url),
  );
  assertMatch(script, /\$Release\.assets/);
  assertMatch(script, /windows-aarch64/);
  assertMatch(script, /windows-x86_64/);
  assertMatch(script, /no native Windows ARM64 asset/);
  assertMatch(script, /Windows x86_64 emulation/);
  assertMatch(script, /SHA256SUMS/);
  assertMatch(script, /does not contain pyr\.exe at its archive root/);
});
