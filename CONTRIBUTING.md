# Contributing to pyr

Thanks for your interest! pyr is a minimal tool, and contributions should focus on reducing ceremony
for Python projects.

---

## **Reporting Bugs**

Open an [issue](https://github.com/jasenc7/pyr/issues) with:

- Steps to reproduce.
- Expected/actual behavior.
- OS, Python version, and `pyr --version`.

---

## **Suggesting Features**

Open a [Discussion](https://github.com/jasenc7/pyr/discussions) first. pyr’s scope is intentionally
narrow:

- Does it reduce ceremony for Python projects?
- Would it make sense for `pip` or `venv` to do this?\
  If not, it’s likely out of scope.

---

## **Pull Requests**

1. Fork the repo and create a branch.
2. Run checks:

```sh
deno fmt
deno lint
deno check
deno run test
```

3. Open a PR with:

- A clear description.
- Reference to any related issues.

---

## **Code Style**

- **TypeScript:** Use `deno fmt`.
- **Shell scripts:** Use `shellcheck`.

---

## **Development Setup**

```sh
git clone https://github.com/jasenc7/pyr.git
cd pyr
deno fmt
deno lint
deno check
deno run test
```

### **Cross-Compile Locally**

```sh
# Apple Silicon
deno compile --target aarch64-apple-darwin main.ts
# Windows x86
deno compile --target x86_64-pc-windows-msvc main.ts
# Windows ARM64
deno compile --target aarch64-pc-windows-msvc main.ts
# Linux x86
deno compile --target x86_64-unknown-linux-gnu main.ts
# Linux ARM
deno compile --target aarch64-unknown-linux-gnu main.ts
# Apple Intel x86
deno compile --target x86_64-apple-darwin main.ts
```

### **Verify a Published Release**

The release sidecar uses an exact-tag manifest and anonymous public downloads; it does not consume a
GitHub token or repository secret:

```sh
deno test --allow-read release_integrity_test.ts
deno run --allow-net --allow-read --allow-write scripts/verify-release-integrity.ts
```

See [`release/README.md`](./release/README.md) before changing a published-release pin.

### **Site Development**

```sh
cd site
deno run dev
```

The site runs in Vite with HMR.

---

## **Git Hooks (Optional)**

To automate local checks, add these scripts to `.git/hooks/` and make them executable:

### **1. Pre-Commit Hook**

Save as `.git/hooks/pre-commit`:

```sh
#!/bin/sh
set -eu
echo "🔍 Running pre-commit checks..."
deno fmt --check
deno lint
deno check
deno run test
```

### **2. Pre-Push Hook**

Save as `.git/hooks/pre-push`:

```sh
#!/bin/sh
set -eu
echo "🔍 Running pre-push checks..."
deno compile --target aarch64-apple-darwin main.ts
deno compile --target x86_64-pc-windows-msvc main.ts
deno compile --target aarch64-pc-windows-msvc main.ts
deno compile --target x86_64-unknown-linux-gnu main.ts
deno compile --target aarch64-unknown-linux-gnu main.ts
deno compile --target x86_64-apple-darwin main.ts
```

### **3. Commit Message Hook**

Save as `.git/hooks/commit-msg`:

```sh
#!/bin/sh
set -eu
if ! grep -qE '^(feat|fix|docs|style|refactor|perf|test|chore|revert)!:? .{1,72}' "$1"; then
  echo "❌ Commit message does not follow conventional format."
  echo "   Use: type(scope): description (e.g., 'feat: add Windows ARM64 support')"
  exit 1
fi
```

**Make hooks executable:**

```sh
chmod +x .git/hooks/pre-commit .git/hooks/pre-push .git/hooks/commit-msg
```

**Skip hooks if needed:**

```sh
git commit --no-verify
git push --no-verify
```

---

**Note:** pyr is not an app—it’s a tool. Keep changes minimal and focused.
