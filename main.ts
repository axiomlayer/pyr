import { parseArgs } from "@std/cli/parse-args";
import {
  add,
  cleanupSelfUpgradeOld,
  init,
  PYR_VERSION,
  remove,
  run,
  sync,
  upgrade,
} from "./lib.ts";

// --- command registry ---

type Handler = (args: string[]) => Promise<void> | void;

interface Command {
  name: string;
  summary: string;
  usage: string;
  handler: Handler;
}

const COMMANDS: Command[] = [
  {
    name: "init",
    summary: "create a new project",
    usage: "pyr init [name]\n\n" +
      "creates ./<name>/ (or cwd if omitted) with app/, pyproject.toml,\n" +
      "requirements.txt, .gitignore, and a fresh .venv.\n" +
      "refuses to adopt your home directory or a filesystem root as cwd.",
    handler: (args) => init(args[0]),
  },
  {
    name: "run",
    summary: "run app/main.py",
    usage: "pyr run [-- args...]\n\n" +
      "runs app/main.py in the project venv with PYTHONPATH=. .\n" +
      "args after `--` are forwarded to python.",
    handler: (args) => run(args),
  },
  {
    name: "add",
    summary: "add packages to pyproject.toml and sync the venv",
    usage: "pyr add <package> [package...]\n\n" +
      "adds the package(s) to pyproject.toml [project].dependencies\n" +
      "and syncs the venv (resolving and pinning the full tree to\n" +
      "requirements.txt).",
    handler: (args) => add(args),
  },
  {
    name: "remove",
    summary: "remove packages from pyproject.toml and the venv",
    usage: "pyr remove <package> [package...]\n\n" +
      "removes the package(s) from pyproject.toml [project].dependencies\n" +
      "and syncs the venv (uninstalling anything no longer required).",
    handler: (args) => remove(args),
  },
  {
    name: "sync",
    summary: "reconcile venv + requirements.txt with pyproject.toml",
    usage: "pyr sync\n\n" +
      "resolves [project].dependencies in pyproject.toml, installs/\n" +
      "uninstalls to match, and writes a fully-pinned requirements.txt.",
    handler: (_args) => sync(),
  },
  {
    name: "upgrade",
    summary: "update pyr (--python to update runtime)",
    usage: "pyr upgrade [--python]\n\n" +
      "  (no flags)   update the pyr binary to the latest release\n" +
      "  --python     update the managed cpython in ~/.pyr/python",
    handler: (args) => upgrade(args),
  },
];

// --- help / dispatch ---

function printUsage() {
  const pad = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = COMMANDS.map(
    (c) => `  ${c.name.padEnd(pad)}  ${c.summary}`,
  );
  console.log(
    `pyr ${PYR_VERSION}\n\n` +
      `usage: pyr <command> [args...]\n\n` +
      `commands:\n${lines.join("\n")}\n\n` +
      `run 'pyr help <command>' for details on a command.`,
  );
}

function printCommandUsage(cmd: Command) {
  console.log(cmd.usage);
}

function find(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}

// --- main ---

// Best-effort: clean up a stale `pyr.exe.old` left by a prior Windows
// self-upgrade. No-op on other platforms and when nothing is stale.
await cleanupSelfUpgradeOld();

// Top-level parse. `stopEarly` halts flag parsing at the first positional —
// keeping subcommand args raw so handlers (and pip downstream) see them
// verbatim. The `--` separator is supported by every command via the same
// convention: anything after `--` is passed through unchanged.
const parsed = parseArgs(Deno.args, {
  boolean: ["help", "version"],
  alias: { h: "help", v: "version" },
  stopEarly: true,
});

// `pyr --help` / `pyr -h` (with no subcommand) — top-level help.
if (parsed.help && parsed._.length === 0) {
  printUsage();
  Deno.exit(0);
}

// `pyr --version` / `pyr -v`.
if (parsed.version) {
  console.log(PYR_VERSION);
  Deno.exit(0);
}

// No args at all.
if (parsed._.length === 0) {
  printUsage();
  Deno.exit(0);
}

const [first, ...subArgs] = parsed._.map(String);

// `pyr help` / `pyr help <cmd>`.
if (first === "help") {
  const target = subArgs[0];
  if (!target) {
    printUsage();
    Deno.exit(0);
  }
  const cmd = find(target);
  if (!cmd) {
    console.error(`unknown command: ${target}`);
    Deno.exit(1);
  }
  printCommandUsage(cmd);
  Deno.exit(0);
}

const cmd = find(first);
if (!cmd) {
  console.error(`unknown command: ${first}`);
  console.error(`run 'pyr --help' for usage`);
  Deno.exit(1);
}

// `pyr <cmd> --help` / `pyr <cmd> -h` — intercept and show command usage.
// Users who want to forward `--help` downstream (e.g. to python via `pyr
// run`) use `pyr run -- --help`.
if (subArgs[0] === "--help" || subArgs[0] === "-h") {
  printCommandUsage(cmd);
  Deno.exit(0);
}

// Drop a leading `--` if present; it's the explicit pyr-flags-end marker
// and shouldn't be forwarded to handlers.
const handlerArgs = subArgs[0] === "--" ? subArgs.slice(1) : subArgs;

await cmd.handler(handlerArgs);
