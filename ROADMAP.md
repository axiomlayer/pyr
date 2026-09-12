# pyr roadmap

This roadmap outlines goals for pyr. Priorities are driven by user feedback, maintainability, and
the Python ecosystem’s needs.

---

### **1. Stability & Polish**

- **Checksum Verification:** Enforce checksum verification in install scripts.

### **2. Platform Support**

- **Windows ARM64:** Native Windows ARM64 binaries.
  - _Status:_ Done. `deno compile` supports `aarch64-pc-windows-msvc`; CI builds
    `pyr-windows-aarch64.zip` and smoke-tests it on a `windows-11-arm` runner.

---

## **Non-Goals**

- **Package Management / Packaging:** pyr is not a package manager. It's a project / app manager.
  See `pip`.
- **Plugins** pyr is not a runtime. it will not have plugins for lint, test, deploy, etc.

---

## **How to Influence the Roadmap**

- **Open an issue** for feature requests or bugs.
- **Vote on discussions** to show interest in a specific feature.
- **Contribute code** (see [CONTRIBUTING.md](CONTRIBUTING.md)).

---

**Last Updated:** September 2026
