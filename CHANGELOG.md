## Unreleased

- `pyr upgrade --python X.Y.Z[+BUILD]` installs only the requested CPython version/build and fails
  closed when it is unavailable, while retaining checksum verification, locking, and rollback
- Managed Python upgrades track the exact upstream build, so same-version rebuilds are not skipped
- Release builds no longer resolve JSR packages; the executable graph is local source plus built-ins
- Native Windows uses `%USERPROFILE%` ahead of Git Bash's `$HOME`; WSL and Windows installs stay
  separate, and the POSIX installer rejects MSYS shells with PowerShell guidance
- The POSIX installer restricts curl to HTTPS with TLS 1.2 or newer
- CI adds native Windows tests, Git Bash bootstrap coverage, and a Windows PowerShell 5.1 installer
  check

## v0.1.1 (2026-09-14)

- Windows ARM64 (aarch64) build, so `install.ps1` works on ARM64 hosts; v0.1.0 shipped no such asset
  and the installer stopped at the SHA256SUMS lookup for `pyr-windows-aarch64.zip`
- Every release now carries a SHA256SUMS file, and both installers verify the downloaded ZIP against
  it before extracting; pyr verifies its own upgrades and managed CPython archives the same way
- Managed Python upgrades are recoverable: a failed upgrade leaves the previous interpreter in place
- `pyr init` refuses to run without a name in `$HOME` (or `%USERPROFILE%`) or at a filesystem root,
  including UNC and extended-length roots
- The Windows installer prints a correct user PATH hint
- CI builds and exercises native x86_64 and ARM64 Windows binaries on every pull request

## v0.1.0 (2026-04-14)

- Initial release
