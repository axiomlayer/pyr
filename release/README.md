# Release evidence

`pyr-v0.1.1.json` is an independently measured, reviewable pin for the currently published Pyr
release. It records four distinct things that the release's own `SHA256SUMS` cannot prove alone:

1. the exact GitHub release, tag commit, release-asset IDs, names, sizes, and download URLs;
2. a locally pinned digest for `SHA256SUMS` itself;
3. a locally pinned digest for every ZIP; and
4. a second digest for the executable extracted from each ZIP, plus its executable format and CPU
   architecture.

The scheduled `release-integrity` workflow resolves only the exact tag and exact asset URLs in this
file. It never resolves `latest`, downloads anonymously, bounds every response, permits only
GitHub's single release-CDN redirect, rejects a changed or missing release, and re-measures both
layers. GitHub-hosted Linux and macOS runners execute all four matching Unix binaries. A separate
workflow with no pull-request trigger executes the pinned Windows ARM64 PE on Ocelot and the x86_64
PE on Siberian, then proves each host refuses the opposite architecture before execution.

The two Windows runners must belong to the non-default `fleet-trusted` runner group. Restrict that
group to this workflow at the fully qualified `refs/heads/main` ref; labels route to Ocelot or
Siberian but are not an authorization boundary. When the repository moves from `jasenc7` to
`axiomlayer`, update that selected-workflow owner atomically with the move.

This manifest is source evidence, not a fleet distribution endpoint. `jasenc7/pyr` remains the
current publisher. The ownership fields reserve AxiomLayer as the promotion boundary without
inventing a mirror URL that does not yet exist; fleet consumers must wait for an independently
published and pinned AxiomLayer promotion manifest.

## Updating the pin

Treat a pin update as a release review, not a mechanical checksum refresh. Confirm the tag commit
and release metadata, download every archive, inspect that it contains exactly one root executable,
measure both the archive and executable bytes, and run the native Windows jobs. A release asset
replacement changes its asset ID as well as its digest and must be explained in review.

The verifier can be run locally with:

```sh
deno run \
  --allow-net=api.github.com,github.com,release-assets.githubusercontent.com \
  --allow-read \
  scripts/verify-release-integrity.ts
```

To retain one verified executable for a native smoke test:

```sh
deno run \
  --allow-net=api.github.com,github.com,release-assets.githubusercontent.com \
  --allow-read \
  --allow-write \
  scripts/verify-release-integrity.ts \
  --asset windows-aarch64 \
  --output-dir ./verified-release
```
