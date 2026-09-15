# [pyr](http://pyrun.dev)

**Python without the ceremony.**\
A project manager that bootstraps its own runtime, manages your venv, and gets out of the way.\
Six commands. One honest lockfile.

[Website](https://pyrun.dev)\
[Docs](https://pyrun.dev/docs)\
[App Convention](https://pyrun.dev/app-convention)\
[Blog: Why pyr?](https://jasencarroll.com/python-project-manager.html)\
[Blog: How pyr Works](https://jasencarroll.com/how-pyr-works.html)

---

## **Installation**

### macOS / Linux

```sh
curl -fsSL https://pyrun.dev/install.sh | sh
```

The script installs `pyr` to `~/.pyr/bin/`. Add this to your `PATH`.

WSL is a Linux environment: run this installer inside WSL and keep its Linux `~/.pyr` separate from
native Windows Pyr. A WSL install uses Linux binaries and `bin/` venv layouts; it cannot safely
share `%USERPROFILE%\.pyr` or project venvs with the Windows executable.

### Windows

```powershell
irm https://pyrun.dev/install.ps1 | iex
```

Installs `pyr.exe` to `%USERPROFILE%\.pyr\bin\`. Add this to your `PATH`. On Windows ARM64, the
installer selects the native ARM64 ZIP when the latest release has one; older releases without that
asset use the x86_64 ZIP under Windows emulation and print a warning.

Git Bash is still native Windows. Run the PowerShell installer (not `install.sh`), then restart Git
Bash so it inherits the updated user `PATH`. Native Pyr prefers `%USERPROFILE%` over Git Bash's
POSIX-looking `$HOME`; set `PYR_HOME` explicitly when a different Windows-native location is wanted.

Every release publishes a `SHA256SUMS` file next to the zips. The installers resolve one release
tag, verify the selected ZIP against that manifest, and only then install it; `pyr upgrade` and the
managed CPython bootstrap apply the same fail-closed check. The v0.1.0 manifest was backfilled for
compatibility with the first release.

The [release evidence manifest](./release/README.md) independently pins the current release object,
tag commit, asset IDs, archive bytes, and extracted executable bytes. A scheduled sidecar downloads
all six exact-tag assets, and native Windows x86_64 and ARM64 jobs execute the corresponding pinned
PE rather than accepting an asset name as architecture proof.

The shipped executable is standalone: it neither uses nor modifies an existing Deno, fnm, Node, or
npm installation. Its release compilation graph uses only local source and Deno/Node built-ins—no
JSR packages. The website has a separate build toolchain and is not embedded in release artifacts.

---

## **Quickstart**

```sh
pyr init myapp        # Scaffold a project
cd myapp
pyr run               # Run app/main.py
pyr add httpx         # Add a dependency
pyr remove httpx      # Remove a dependency
pyr sync              # Reconcile venv + lock with pyproject.toml
pyr upgrade           # Update pyr itself
pyr upgrade --python  # Update the managed CPython
pyr upgrade --python 3.14.7+20260901  # Install one exact upstream CPython build
```

---

## **Why pyr?**

- **Zero system deps:** Bootstraps its own CPython. No brew, no apt, no pyenv.
- **Six commands:** `init`, `run`, `add`, `remove`, `sync`, `upgrade`. No `activate`, no
  `pip freeze`.
- **Honest lockfile:** `pyproject.toml` is the source of truth. `requirements.txt` is a generated,
  fully-pinned lock.
- **Self-updating:** `pyr upgrade` updates the tool. `pyr upgrade --python` updates the runtime.
- **Not written in Python:** The tool that manages Python shouldn’t need Python to install.

---

## **Project Layout**

After `pyr init myapp`:

```
myapp/
  pyproject.toml         # Edit dependencies here
  requirements.txt       # Generated lockfile
  .gitignore
  app/
    __init__.py
    config.py            # ENV from os.getenv
    main.py              # Entrypoint
  .venv/                 # Project-local venv
```

---

## **How It Works**

- **Bootstrapping:** Downloads a standalone CPython into `~/.pyr/python` on first use.
- **Venv Management:** Creates a project-local `.venv` from the managed Python. Rebuilds
  automatically if the Python version changes.
- **Dependency Resolution:** Delegates to `pip`. `requirements.txt` is a generated lockfile.
- **TOML Surgery:** Edits `pyproject.toml` without destroying comments or formatting.
- **Self-Upgrades:** Replaces the running binary with the latest release.

Python bootstrap and upgrade use the same installer. `pyr upgrade --python` checks release metadata
once and skips the download only when the installed CPython version and exact upstream build both
match and pass a runtime check. Otherwise it obtains the upstream checksum manifest, verifies the
archive before extracting, then checks the replacement before moving the existing runtime. Older
installs without an exact-build stamp refresh once on their next explicit Python upgrade. A failed
replacement move restores the previous installation.

`pyr upgrade --python X.Y.Z` selects only that CPython version from the current upstream release and
fails if it is absent—there is no fallback to the release's newest Python. For a durable runtime
manifest, use `X.Y.Z+BUILD` (for example `3.14.7+20260901`): pyr resolves that exact
python-build-standalone release and asset, verifies its release checksum, and records the full build
identifier. Both forms use the same lock, staging, interpreter probe, and rollback path.

For a deep dive, see:

- [How pyr Works](https://jasencarroll.com/how-pyr-works.html)
- [The App Convention](https://pyrun.dev/app-convention)

---

## **Philosophy**

> The thing that manages Python shouldn’t be Python.

`pyr` is a single compiled binary. It drives `pip` and the standalone CPython runtime; it doesn’t
depend on them to install itself.

---

## **Dogfooding**

This repo uses `pyr` to manage its own Python tooling — even though the project itself is
TypeScript/Deno.

[`scripts/generate-og`](./scripts/generate-og) generates the OG image for pyrun.dev using Pillow.
It's a self-contained Python sub-app living inside a Deno repo:

```sh
pyr init generate-og
cd generate-og
pyr add pillow
pyr run
```

The `.gitignore` that ships with `pyr init` makes it safe to bury Python sub-apps anywhere in a
repo, regardless of the primary language.

---

## **Community & Support**

- **Discussions:** [GitHub Discussions](https://github.com/jasenc7/pyr/discussions)
- **Issues:** [GitHub Issues](https://github.com/jasenc7/pyr/issues)
- **Email:** [Publicly listed on GitHub profile](https://github.com/jasenc7)
