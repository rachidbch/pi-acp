#!/usr/bin/env node

// src/index.ts
import { ndJsonStream } from "@agentclientprotocol/sdk/unstable";

// src/acp/connection.ts
import {
  agent as agentApp
} from "@agentclientprotocol/sdk/unstable";

// src/acp/agent.ts
import {
  PROTOCOL_VERSION,
  RequestError as RequestError4
} from "@agentclientprotocol/sdk/unstable";

// src/acp/auth.ts
var PI_SETUP_METHOD_ID = "pi_terminal_login";
function getAuthMethods(opts) {
  const supportsTerminalAuth = opts?.supportsTerminalAuth === true;
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta === true;
  if (!supportsTerminalAuth && !supportsTerminalAuthMeta) return [];
  const base = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login"
  };
  const method = supportsTerminalAuth ? { ...base, type: "terminal", args: ["--terminal-login"], env: {} } : base;
  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec();
    method._meta = {
      ...method._meta ?? {},
      "terminal-auth": {
        ...launch,
        label: "Launch pi"
      }
    };
  }
  return [method];
}
function terminalAuthLaunchSpec() {
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }
  return { command: "pi-acp", args: ["--terminal-login"] };
}

// src/acp/session.ts
import { RequestError as RequestError2 } from "@agentclientprotocol/sdk/unstable";

// src/acp/steering.ts
var Steering = class {
  constructor(send) {
    this.send = send;
  }
  phase = "start";
  entries = [];
  pending = /* @__PURE__ */ new Set();
  failure;
  generation = 0;
  get hasPending() {
    return this.entries.length > 0;
  }
  start() {
    this.generation++;
    this.phase = "start";
  }
  ended() {
    this.generation++;
    this.phase = "end";
  }
  clear() {
    this.generation++;
    this.entries = [];
    this.failure = void 0;
    this.phase = "end";
  }
  async inject(text2) {
    const entry = { text: text2, sent: false };
    this.entries.push(entry);
    if (this.phase === "running") await this.deliver(entry);
  }
  deliver(entry) {
    entry.sent = true;
    const work = this.send(entry.text).then(
      (disposition) => {
        if (disposition === "handled") this.entries = this.entries.filter((item) => item !== entry);
      },
      (error) => {
        if (this.entries.includes(entry)) this.failure = error;
        throw error;
      }
    );
    this.pending.add(work);
    return work.finally(() => this.pending.delete(work));
  }
  async running() {
    const generation = ++this.generation;
    this.phase = "running";
    for (const entry of this.entries) {
      if (generation !== this.generation || this.phase !== "running") break;
      if (!entry.sent) await this.deliver(entry);
    }
  }
  async leftovers(clear) {
    await Promise.all(this.pending);
    if (this.failure) throw this.failure;
    const queue = await clear();
    const remaining = [...queue.steering];
    for (const entry of this.entries) {
      if (!entry.sent) remaining.push(entry.text);
    }
    this.entries = [];
    return [...remaining, ...queue.followUp];
  }
  async drain() {
    await Promise.allSettled(this.pending);
  }
};

// src/acp/session.ts
import { randomUUID as randomUUID3 } from "crypto";
import { readFileSync as readFileSync2 } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";

// src/pi-rpc/process.ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import crossSpawn from "cross-spawn";
import { z } from "zod";

// src/pi-rpc/system-prompt.ts
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
function prepareSystemPrompt(prompt) {
  if (!prompt) return { args: [], dispose: () => {
  } };
  const directory = mkdtempSync(join(tmpdir(), "pi-acp-prompt-"));
  const dispose = () => {
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const path = join(directory, "prompt.md");
    writeFileSync(path, prompt.text, { encoding: "utf-8", mode: 384, flag: "wx" });
    return { args: [prompt.mode === "append" ? "--append-system-prompt" : "--system-prompt", path], dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}

// src/pi-rpc/command.ts
import { platform } from "os";
function defaultPiCommand() {
  return platform() === "win32" ? "pi.cmd" : "pi";
}
function getPiCommand(override) {
  return override ?? defaultPiCommand();
}
function shouldUseShellForPiCommand(cmd) {
  if (platform() !== "win32") return false;
  const normalized = cmd.trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

// src/acp/mcp-descriptor.ts
import { randomUUID } from "crypto";
import { closeSync, openSync, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { tmpdir as tmpdir2 } from "os";
import { join as join2 } from "path";
var PI_ACP_MCP_DESCRIPTOR_ENV = "PI_ACP_MCP_DESCRIPTOR";
var descriptorCleanups = /* @__PURE__ */ new Set();
process.once("exit", () => {
  for (const cleanup of descriptorCleanups) cleanup();
});
function pairsToMap(pairs) {
  const map = {};
  for (const pair of pairs ?? []) {
    if (typeof pair?.name === "string" && typeof pair?.value === "string") {
      map[pair.name] = pair.value.replace(/\$/g, () => "$$").replace(/^!/, () => "$!");
    }
  }
  return map;
}
function buildMcpDescriptor(servers) {
  const entries = {};
  const warnings = [];
  for (const server of servers ?? []) {
    const name = typeof server?.name === "string" ? server.name : "";
    if (!name) {
      warnings.push("skipped an MCP server entry without a name");
      continue;
    }
    if (entries[name]) {
      warnings.push(`skipped duplicate MCP server "${name}"`);
      continue;
    }
    if ("type" in server && server.type === "http") {
      entries[name] = { url: server.url, headers: pairsToMap(server.headers) };
      continue;
    }
    if ("type" in server && (server.type === "sse" || server.type === "acp")) {
      warnings.push(`skipped MCP server "${name}": transport "${server.type}" is not supported`);
      continue;
    }
    const stdio = server;
    if (typeof stdio.command !== "string" || !stdio.command) {
      warnings.push(`skipped MCP server "${name}": missing command`);
      continue;
    }
    entries[name] = {
      command: stdio.command,
      args: [...stdio.args ?? []],
      env: pairsToMap(stdio.env)
    };
  }
  const descriptor = Object.keys(entries).length ? { mcpServers: entries } : null;
  return { descriptor, warnings };
}
function prepareMcpInjection(servers) {
  const { descriptor, warnings } = buildMcpDescriptor(servers ?? []);
  const serverNames = Object.keys(descriptor?.mcpServers ?? {});
  for (const warning of warnings) console.warn(`[pi-acp] MCP injection: ${warning}`);
  if (!descriptor) {
    return { descriptorPath: null, serverNames: [], warnings, cleanup: () => {
    } };
  }
  const descriptorPath = join2(tmpdir2(), `pi-acp-mcp-${randomUUID()}.json`);
  let created = false;
  const cleanup = () => {
    if (!created) return;
    try {
      unlinkSync(descriptorPath);
      created = false;
      descriptorCleanups.delete(cleanup);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        created = false;
        descriptorCleanups.delete(cleanup);
      }
    }
  };
  try {
    const fd = openSync(descriptorPath, "wx", 384);
    created = true;
    descriptorCleanups.add(cleanup);
    try {
      writeFileSync2(fd, JSON.stringify(descriptor));
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    cleanup();
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    const warning = `could not write MCP descriptor (${code}); continuing without client MCP servers`;
    warnings.push(warning);
    console.warn(`[pi-acp] MCP injection: ${warning}`);
    return { descriptorPath: null, serverNames: [], warnings, cleanup };
  }
  return { descriptorPath, serverNames, warnings, cleanup };
}

// src/pi-rpc/process.ts
import { fileURLToPath } from "url";
var PiRpcSpawnError = class extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code;
  constructor(message, opts) {
    super(message);
    this.name = "PiRpcSpawnError";
    this.code = opts?.code;
    this.cause = opts?.cause;
  }
};
var ESC = String.fromCharCode(27);
var CSI = String.fromCharCode(155);
var ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE_REGEX, "");
}
var rpcEventSchema = z.object({ type: z.string().min(1) }).passthrough();
var rpcResponseSchema = z.object({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
});
var promptResultSchema = z.object({ disposition: z.enum(["handled", "started", "queued"]).optional() });
var STARTUP_EVENT_MAX_COUNT = 1024;
var STARTUP_EVENT_MAX_BYTES = 4 * 1024 * 1024;
var SESSION_STATS_TIMEOUT_MS = 1e3;
var CONTROL_TIMEOUT_MS = 3e4;
var COMPACT_TIMEOUT_MS = 3e5;
var KILL_GRACE_MS = 3e3;
var MIN_PI_VERSION_FOR_MCP_INJECTION = "1.0.0";
var PI_VERSION_TIMEOUT_MS = 2e3;
var PI_VERSION_MAX_OUTPUT_BYTES = 64 * 1024;
function compareVersion(a, b) {
  const pa = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function resolveBootstrapPath(name) {
  const candidates = [
    fileURLToPath(new URL(`./pi-extension/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../pi-extension/${name}`, import.meta.url))
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
var liveVersionProbes = /* @__PURE__ */ new Set();
process.once("exit", () => {
  for (const cleanup of liveVersionProbes) cleanup();
});
function killVersionProbeTree(child) {
  const killChild = () => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
  };
  if (!child.pid) {
    killChild();
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = crossSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: PI_VERSION_TIMEOUT_MS,
        killSignal: "SIGKILL"
      });
      killer.on("error", killChild);
      killer.on("exit", (code) => {
        if (code !== 0) killChild();
      });
    } catch {
      killChild();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    killChild();
  }
}
function probePiVersion(cmd, cwd) {
  return new Promise((resolve4, reject) => {
    const child = crossSpawn(cmd, ["--version"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    const cleanup = () => killVersionProbeTree(child);
    liveVersionProbes.add(cleanup);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new Error("version probe timed out")), PI_VERSION_TIMEOUT_MS);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(error);
    };
    const capture = (chunk, stream2) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > PI_VERSION_MAX_OUTPUT_BYTES) {
        fail(new Error("version probe output exceeded limit"));
        return;
      }
      if (stream2 === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout?.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => capture(chunk, "stderr"));
    child.on("error", () => fail(new Error("version probe could not start")));
    child.on("close", (code) => {
      liveVersionProbes.delete(cleanup);
      if (settled) return;
      if (code !== 0) {
        fail(new Error("version probe exited unsuccessfully"));
        return;
      }
      const raw = stdout.trim() || stderr.trim();
      const version = raw.replace(/^v/i, "").split(/[\s-]/)[0] ?? "";
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail(new Error("version probe returned an invalid version"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve4(version);
    });
  });
}
async function canInjectMcpWithPi(cmd, cwd) {
  let version;
  try {
    version = await probePiVersion(cmd, cwd);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "version probe failed";
    console.warn(`[pi-acp] MCP injection: ${reason}; skipping client MCP servers`);
    return false;
  }
  if (compareVersion(version, MIN_PI_VERSION_FOR_MCP_INJECTION) < 0) {
    throw new PiRpcSpawnError(
      `pi v${version} does not support MCP injection: forwarding client MCP servers requires pi >= ${MIN_PI_VERSION_FOR_MCP_INJECTION}. Update pi (\`npm install -g @earendil-works/pi-coding-agent\`) or disable client MCP servers in your ACP client.`
    );
  }
  return true;
}
var PiRpcProcess = class _PiRpcProcess {
  constructor(child, mcpInjection, removePromptFile, killGraceMs = KILL_GRACE_MS) {
    this.killGraceMs = killGraceMs;
    this.child = child;
    this.mcpInjection = mcpInjection;
    this.removePromptFile = removePromptFile;
    child.stdin.on?.("error", () => {
    });
    const onLine = (line) => {
      if (!line.trim()) return;
      if (this.terminalError) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const cleaned = stripAnsi(String(line)).trimEnd();
        if (cleaned) this.preludeLines.push(cleaned);
        return;
      }
      const event = rpcEventSchema.safeParse(msg);
      if (!event.success) return;
      if (event.data.type === "response") {
        const id = typeof event.data.id === "string" ? event.data.id : void 0;
        if (id !== void 0) {
          const response = rpcResponseSchema.safeParse(msg);
          if (response.success) this.pending.get(id)?.resolve(response.data);
          else this.pending.get(id)?.reject(new Error("pi returned an invalid RPC response"));
        }
        return;
      }
      if (this.startupEvents !== null) {
        this.startupEventBytes += Buffer.byteLength(line, "utf8");
        if (this.startupEvents.length >= STARTUP_EVENT_MAX_COUNT || this.startupEventBytes > STARTUP_EVENT_MAX_BYTES) {
          this.fail(new Error("pi startup event buffer exceeded limit (1024 events / 4 MiB); refusing to drop events"));
          this.dispose("SIGKILL");
          return;
        }
        this.startupEvents.push(event.data);
        return;
      }
      for (const h of this.eventHandlers) h(event.data);
    };
    let stdoutRest = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutRest += chunk;
      let newline;
      while ((newline = stdoutRest.indexOf("\n")) !== -1) {
        const line = stdoutRest.slice(0, newline).replace(/\r$/, "");
        stdoutRest = stdoutRest.slice(newline + 1);
        onLine(line);
      }
    });
    child.on("close", (code, signal) => {
      this.closed = true;
      clearTimeout(this.killTimer);
      if (stdoutRest.trim()) onLine(stdoutRest.replace(/\r$/, ""));
      stdoutRest = "";
      this.mcpInjection?.cleanup();
      this.fail(new Error(`pi process exited (code=${code}, signal=${signal})`));
    });
    child.on("error", (err) => {
      this.mcpInjection?.cleanup();
      this.fail(err);
    });
  }
  child;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = [];
  preludeLines = [];
  mcpInjection;
  removePromptFile;
  startupEvents = [];
  startupEventBytes = 0;
  terminalError;
  closed = false;
  killTimer;
  static async spawn(params) {
    const cmd = getPiCommand(params.piCommand);
    let mcpInjection = params.mcpInjection?.descriptorPath ? params.mcpInjection : null;
    let mcpBootstrapPath = null;
    if (mcpInjection) {
      try {
        if (await canInjectMcpWithPi(cmd, params.cwd)) {
          mcpBootstrapPath = resolveBootstrapPath("mcp-bootstrap.js");
          if (!mcpBootstrapPath) {
            console.warn(
              "[pi-acp] MCP injection: bundled pi extension not found next to the pi-acp install; skipping client MCP servers"
            );
          }
        }
      } catch (error) {
        mcpInjection.cleanup();
        throw error;
      }
      if (!mcpBootstrapPath) {
        mcpInjection.cleanup();
        mcpInjection = null;
      }
    }
    const systemPrompt = prepareSystemPrompt(params.systemPrompt);
    const args = ["--mode", "rpc", "--no-themes", ...params.launchArgs ?? [], ...systemPrompt.args];
    if (mcpBootstrapPath) args.push("-e", mcpBootstrapPath);
    if (params.sessionPath) args.push("--session", params.sessionPath);
    if (params.forkSessionPath) args.push("--fork", params.forkSessionPath);
    const childEnv = { ...process.env };
    delete childEnv[PI_ACP_MCP_DESCRIPTOR_ENV];
    if (mcpInjection?.descriptorPath) childEnv[PI_ACP_MCP_DESCRIPTOR_ENV] = mcpInjection.descriptorPath;
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn;
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: "pipe",
      env: childEnv,
      // Own process group (POSIX), so dispose reaches pi's tool and MCP children too.
      detached: process.platform !== "win32"
    });
    try {
      await new Promise((resolve4, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve4();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (e) {
      mcpInjection?.cleanup();
      systemPrompt.dispose();
      const code = typeof e?.code === "string" ? e.code : void 0;
      if (code === "ENOENT") {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        );
      }
      if (code === "EACCES") {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e });
      }
      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
    }
    let stderrRest = "";
    child.stderr.on("data", (chunk) => {
      const text2 = stderrRest + chunk.toString();
      const lines = text2.split("\n");
      stderrRest = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) process.stderr.write(`[pi] ${line}
`);
      }
    });
    child.once("close", () => systemPrompt.dispose());
    const proc = new _PiRpcProcess(child, mcpInjection, systemPrompt.dispose, params.killGraceMs);
    try {
      const state = await proc.getState(3e4);
      const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
      if (sessionFile) {
        const { mkdirSync } = await import("fs");
        const { dirname: dirname2 } = await import("path");
        mkdirSync(dirname2(sessionFile), { recursive: true });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") {
        proc.dispose();
        throw new PiRpcSpawnError(
          "Pi RPC did not become ready within 30 seconds. If a pi extension blocks startup, defer that work until a command or tool runs and try again.",
          { code: "ETIMEDOUT", cause: error }
        );
      }
    }
    if (proc.terminalError) throw proc.terminalError;
    return proc;
  }
  /**
   * The first subscriber synchronously receives the events emitted before it attached,
   * in wire order; later subscribers receive live events only. Until the first
   * subscription, exceeding 1024 buffered events or 4 MiB kills the process rather
   * than dropping events (a dropped permission request would deadlock the session).
   */
  onEvent(handler) {
    if (this.terminalError) throw this.terminalError;
    this.eventHandlers.push(handler);
    const startupEvents = this.startupEvents;
    this.startupEvents = null;
    this.startupEventBytes = 0;
    if (startupEvents) {
      for (const event of startupEvents) handler(event);
    }
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }
  dispose(signal = "SIGTERM") {
    this.mcpInjection?.cleanup();
    this.removePromptFile();
    this.fail(new Error("pi process disposed"));
    if (this.closed) return;
    this.signalGroup(signal);
    if (signal !== "SIGKILL" && this.killTimer === void 0) {
      this.killTimer = setTimeout(() => this.signalGroup("SIGKILL"), this.killGraceMs);
      this.killTimer.unref?.();
    }
  }
  /** Signal pi and everything it started: its group on POSIX (pi leads it, see spawn), else pi alone. */
  signalGroup(signal) {
    const pid = this.child.pid;
    try {
      if (pid !== void 0 && process.platform !== "win32") process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
    }
  }
  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines() {
    const lines = this.preludeLines.splice(0, this.preludeLines.length);
    return lines;
  }
  async prompt(message, images = [], timeoutMs, onDisposition) {
    let disposition;
    await this.request(
      { type: "prompt", message, images },
      {
        timeoutMs,
        onResponse: (res) => {
          if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
          if (res.data !== void 0) {
            const result = promptResultSchema.safeParse(res.data);
            if (!result.success) throw new Error("pi prompt returned invalid disposition");
            disposition = result.data.disposition;
          }
          onDisposition?.(disposition);
        }
      }
    );
    return disposition;
  }
  async steer(message) {
    const res = await this.request({ type: "steer", message });
    if (!res.success) throw new Error(`pi steer failed: ${res.error}`);
    return res.data?.disposition;
  }
  async clearQueue() {
    const res = await this.request({ type: "clear_queue" });
    if (!res.success) throw new Error(`pi clear_queue failed: ${res.error}`);
    return res.data;
  }
  async abort() {
    const res = await this.request({ type: "abort" });
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getState(timeoutMs) {
    const res = await this.request({ type: "get_state" }, { timeoutMs });
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getAvailableModels() {
    const res = await this.request({ type: "get_available_models" });
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setModel(provider, modelId) {
    const res = await this.request({ type: "set_model", provider, modelId });
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getAvailableThinkingLevels() {
    const res = await this.request({ type: "get_available_thinking_levels" });
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`);
    const data = res.data;
    const levels = data && typeof data === "object" && "levels" in data ? data.levels : void 0;
    if (!Array.isArray(levels) || levels.length === 0 || !levels.every((level) => typeof level === "string" && level.length > 0)) {
      throw new Error("pi get_available_thinking_levels returned invalid levels");
    }
    return levels;
  }
  async setThinkingLevel(level) {
    const res = await this.request({ type: "set_thinking_level", level });
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setFollowUpMode(mode) {
    const res = await this.request({ type: "set_follow_up_mode", mode });
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setSteeringMode(mode) {
    const res = await this.request({ type: "set_steering_mode", mode });
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async compact(customInstructions) {
    const res = await this.request({ type: "compact", customInstructions }, { timeoutMs: COMPACT_TIMEOUT_MS });
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setAutoCompaction(enabled) {
    const res = await this.request({ type: "set_auto_compaction", enabled });
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getSessionStats(timeoutMs) {
    const res = await this.request({ type: "get_session_stats" }, { timeoutMs });
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data ?? {};
  }
  async setSessionName(name) {
    const res = await this.request({ type: "set_session_name", name });
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async exportHtml(outputPath) {
    const res = await this.request({ type: "export_html", outputPath });
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
    const data = res.data;
    return { path: String(data?.path ?? "") };
  }
  async switchSession(sessionPath) {
    const res = await this.request({ type: "switch_session", sessionPath });
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getMessages() {
    const res = await this.request({ type: "get_messages" });
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getCommands() {
    const res = await this.request({ type: "get_commands" });
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async sendExtensionUiResponse(response) {
    await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}
`);
  }
  request(cmd, opts) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    const id = crypto.randomUUID();
    const withId = { ...cmd, id };
    const timeoutMs = opts?.timeoutMs ?? CONTROL_TIMEOUT_MS;
    const line = `${JSON.stringify(withId)}
`;
    return new Promise((resolve4, reject) => {
      let timer;
      const drop = () => {
        if (timer !== void 0) {
          clearTimeout(timer);
          timer = void 0;
        }
        return this.pending.delete(id);
      };
      this.pending.set(id, {
        resolve: (res) => {
          if (!drop()) return;
          try {
            opts?.onResponse?.(res);
            resolve4(res);
          } catch (error) {
            reject(error);
          }
        },
        reject: (error) => {
          drop();
          reject(error);
        }
      });
      timer = setTimeout(() => {
        timer = void 0;
        if (!this.pending.delete(id)) return;
        reject(Object.assign(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
      }, timeoutMs);
      timer.unref?.();
      void this.writeLine(line).catch((error) => {
        if (!drop()) return;
        reject(error);
      });
    });
  }
  writeLine(line) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolve4, reject) => {
      try {
        this.child.stdin.write(line, (error) => {
          if (error) {
            const code = error.code;
            this.fail(new Error(`pi process exited (stdin write failed: ${code ?? error.message})`));
            reject(this.terminalError ?? error);
            return;
          }
          resolve4();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
  /**
   * Latch the first terminal failure, reject everything pending, and make every
   * later request fail fast instead of writing to a dead child. Event handlers
   * are notified once so upper layers can surface the failure to the client.
   */
  fail(error) {
    const firstFailure = !this.terminalError;
    this.terminalError ??= error;
    this.startupEvents = null;
    this.startupEventBytes = 0;
    for (const [, pending] of this.pending) pending.reject(this.terminalError);
    this.pending.clear();
    if (firstFailure) {
      for (const handler of this.eventHandlers)
        handler({ type: "pi_acp_process_error", message: this.terminalError.message });
    }
  }
};

// src/acp/auth-required.ts
import { RequestError } from "@agentclientprotocol/sdk/unstable";
function maybeAuthRequiredError(err, capabilities) {
  const msg = String(err?.message ?? err ?? "");
  const s = msg.toLowerCase();
  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "authentication",
    "permission denied",
    "forbidden",
    "401",
    "403"
  ];
  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods({
        supportsTerminalAuth: capabilities?.auth?.terminal === true,
        supportsTerminalAuthMeta: capabilities?._meta?.["terminal-auth"] === true
      })
    },
    "Configure an API key or log in with an OAuth provider."
  );
}

// src/acp/slash-commands.ts
import { existsSync as existsSync2, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join as join3, resolve } from "path";
function parseFrontmatter(content) {
  const frontmatter = {};
  if (!content.startsWith("---")) return { frontmatter, content };
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, content };
  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 4).trim();
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim();
  }
  return { frontmatter, content: remaining };
}
function loadCommandsFromDir(dir, source, subdir = "") {
  const commands = [];
  if (!existsSync2(dir)) return commands;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join3(dir, entry.name);
      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
        commands.push(...loadCommandsFromDir(fullPath, source, newSubdir));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const rawContent = readFileSync(fullPath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        const name = entry.name.slice(0, -3);
        const sourceStr = source === "user" ? subdir ? `(user:${subdir})` : "(user)" : subdir ? `(project:${subdir})` : "(project)";
        let description = frontmatter.description || "";
        if (!description) {
          const firstLine = content.split("\n").find((l) => l.trim());
          if (firstLine) {
            description = firstLine.slice(0, 60);
            if (firstLine.length > 60) description += "...";
          }
        }
        description = description ? `${description} ${sourceStr}` : sourceStr;
        commands.push({
          name,
          description,
          content,
          source: sourceStr
        });
      } catch {
      }
    }
  } catch {
  }
  return commands;
}
function loadSlashCommands(cwd) {
  const commands = [];
  const userDir = join3(homedir(), ".pi", "agent", "prompts");
  const projectDir = resolve(cwd, ".pi", "prompts");
  commands.push(...loadCommandsFromDir(userDir, "user"));
  commands.push(...loadCommandsFromDir(projectDir, "project"));
  return commands;
}
function toAvailableCommands(fileCommands) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of fileCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (pi commands don't specify this)
    });
  }
  return out;
}
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
function substituteArgs(content, args) {
  let result = content;
  result = result.replace(/\$@/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1;
    return args[idx] ?? "";
  });
  return result;
}
function expandSlashCommand(text2, fileCommands) {
  if (!text2.startsWith("/")) return text2;
  const spaceIndex = text2.indexOf(" ");
  const commandName = spaceIndex === -1 ? text2.slice(1) : text2.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text2.slice(spaceIndex + 1);
  const cmd = fileCommands.find((c) => c.name === commandName);
  if (!cmd) return text2;
  const args = parseCommandArgs(argsString);
  return substituteArgs(cmd.content, args);
}

// src/acp/translate/bash.ts
function isBashTool(toolName) {
  return toolName.toLowerCase() === "bash";
}
function bashCommand(value) {
  const record = value;
  const command = record?.command ?? record?.cmd ?? record?.args?.command ?? record?.args?.cmd ?? record?.input?.command ?? record?.input?.cmd ?? record?.rawInput?.command ?? record?.rawInput?.cmd ?? record?.toolInput?.command ?? record?.toolInput?.cmd ?? record?.details?.command ?? record?.details?.cmd;
  return typeof command === "string" && command.trim() ? command : void 0;
}
function bashResultText(result) {
  const record = result;
  const content = record?.content;
  if (Array.isArray(content)) {
    const texts = content.map((block) => {
      if (typeof block !== "object" || block === null) return "";
      return "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? block.text : "";
    }).filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const details = record?.details;
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof record?.stdout === "string" ? record.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof record?.output === "string" ? record.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof record?.stderr === "string" ? record.stderr : void 0);
  return [stdout, stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
}
function bashExitCode(result, isError) {
  const record = result;
  const details = record?.details;
  const exitCode = details?.exitCode ?? record?.exitCode ?? details?.code ?? record?.code;
  return typeof exitCode === "number" ? exitCode : isError ? 1 : 0;
}
function bashOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}
function bashTerminalContent(toolCallId) {
  return [{ type: "terminal", terminalId: toolCallId }];
}
function bashTerminalInfoMeta(toolCallId, cwd) {
  return { terminal_info: { terminal_id: toolCallId, cwd } };
}
function bashTerminalOutputMeta(toolCallId, data) {
  return { terminal_output: { terminal_id: toolCallId, data } };
}
function bashTerminalExitMeta(toolCallId, exitCode) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } };
}

// src/acp/translate/pi-tools.ts
import { z as z2 } from "zod";
var zAnnotations = z2.object({
  audience: z2.array(z2.enum(["user", "assistant"])).nullable().optional(),
  lastModified: z2.string().nullable().optional(),
  priority: z2.number().min(0).max(1).nullable().optional()
}).passthrough().nullable().optional();
var zMeta = z2.record(z2.unknown()).nullable().optional();
var zResourceContents = z2.union([
  z2.object({ uri: z2.string(), text: z2.string(), mimeType: z2.string().nullable().optional() }).passthrough(),
  z2.object({ uri: z2.string(), blob: z2.string(), mimeType: z2.string().nullable().optional() }).passthrough()
]);
var zContentBlock = z2.discriminatedUnion("type", [
  z2.object({ type: z2.literal("text"), text: z2.string(), annotations: zAnnotations, _meta: zMeta }).passthrough(),
  z2.object({
    type: z2.literal("image"),
    data: z2.string(),
    mimeType: z2.string(),
    annotations: zAnnotations,
    _meta: zMeta
  }).passthrough(),
  z2.object({
    type: z2.literal("audio"),
    data: z2.string(),
    mimeType: z2.string(),
    annotations: zAnnotations,
    _meta: zMeta
  }).passthrough(),
  z2.object({
    type: z2.literal("resource_link"),
    uri: z2.string(),
    name: z2.string(),
    title: z2.string().nullable().optional(),
    description: z2.string().nullable().optional(),
    mimeType: z2.string().nullable().optional(),
    annotations: zAnnotations,
    _meta: zMeta
  }).passthrough(),
  z2.object({ type: z2.literal("resource"), resource: zResourceContents, annotations: zAnnotations, _meta: zMeta }).passthrough()
]);
var outputSchema = z2.object({
  stdout: z2.unknown().optional(),
  stderr: z2.unknown().optional(),
  output: z2.unknown().optional(),
  exitCode: z2.unknown().optional(),
  code: z2.unknown().optional()
});
var detailsSchema = outputSchema.extend({ diff: z2.unknown().optional() });
var resultSchema = outputSchema.extend({
  content: z2.unknown().optional(),
  details: z2.unknown().optional(),
  text: z2.unknown().optional()
});
var zToolCallContent = z2.discriminatedUnion("type", [
  z2.object({ type: z2.literal("content"), content: zContentBlock, _meta: zMeta }).passthrough(),
  z2.object({
    type: z2.literal("diff"),
    path: z2.string(),
    oldText: z2.string().nullable().optional(),
    newText: z2.string(),
    _meta: zMeta
  }).passthrough(),
  z2.object({ type: z2.literal("terminal"), terminalId: z2.string(), _meta: zMeta }).passthrough()
]);
var omittedContent = "[Unsupported or malformed tool content omitted.]";
function textContent(text2) {
  return text2 ? [{ type: "content", content: { type: "text", text: text2 } }] : [];
}
function toolResultToContent(result, opts) {
  if (!result) return [];
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success) return textContent(boundedFallback(result));
  const value = parsed.data;
  const details = detailsSchema.safeParse(value.details);
  const diff = details.success ? details.data.diff : void 0;
  if (typeof diff === "string" && diff.trim()) return textContent(diff);
  const output2 = details.success ? details.data : {};
  const string = (value2) => typeof value2 === "string" ? value2 : void 0;
  const stdout = string(output2.stdout) ?? string(value.stdout) ?? string(output2.output) ?? string(value.output);
  const stderr = string(output2.stderr) ?? string(value.stderr);
  const fallback = stdout?.trim() || stderr?.trim() ? toolResultToText({ ...value, details: output2, content: void 0 }) : typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : "";
  if (Array.isArray(value.content)) {
    let hasValidBlock = false;
    const content = value.content.flatMap((block) => {
      const parsedBlock = zContentBlock.safeParse(block);
      if (!parsedBlock.success) return textContent(omittedContent);
      hasValidBlock = true;
      const content2 = parsedBlock.data;
      if (opts?.binaryResourcesAsLinks && content2.type === "resource" && "blob" in content2.resource && !content2.resource.mimeType?.toLowerCase().startsWith("image/")) {
        const { uri, mimeType } = content2.resource;
        return [
          {
            type: "content",
            content: {
              type: "resource_link",
              uri,
              name: uri,
              ...mimeType === void 0 ? {} : { mimeType },
              ...content2.annotations === void 0 ? {} : { annotations: content2.annotations },
              ...content2._meta === void 0 ? {} : { _meta: content2._meta }
            }
          }
        ];
      }
      return [{ type: "content", content: content2 }];
    });
    return hasValidBlock || !fallback ? content : textContent(boundedText(fallback));
  }
  if (fallback) return textContent(boundedText(fallback));
  if (value.content !== void 0 && value.content !== null) return textContent(omittedContent);
  return textContent(boundedFallback(result));
}
function boundedFallback(result) {
  return boundedText(toolResultToText(result));
}
function boundedText(text2) {
  const limit = 16e3;
  return text2.length > limit ? `${text2.slice(0, limit)}
[Tool result truncated.]` : text2;
}
function toolResultToText(result) {
  if (!result) return "";
  const details = result?.details;
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return diff;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof result?.stdout === "string" ? result.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof result?.output === "string" ? result.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof result?.stderr === "string" ? result.stderr : void 0);
  const exitCode = (typeof details?.exitCode === "number" ? details.exitCode : void 0) ?? (typeof result?.exitCode === "number" ? result.exitCode : void 0) ?? (typeof details?.code === "number" ? details.code : void 0) ?? (typeof result?.code === "number" ? result.code : void 0);
  if (typeof stdout === "string" && stdout.trim() || typeof stderr === "string" && stderr.trim()) {
    const parts = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:
${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// src/acp/extension-ui.ts
import { CreateElicitationResponse } from "@agentclientprotocol/sdk/unstable";
var CONFIRM_OPTIONS = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" }
];
var SECRET_DISCLOSURE = "Do not enter passwords, tokens, or other secrets.";
var CREDENTIAL_TEXT = /\b(?:passwords?|passphrases?|secrets?|credentials?|api[\s_-]*keys?|(?:(?:api|access|refresh|auth(?:entication)?|bearer|session)[\s_-]*)?tokens?|(?:private|ssh)[\s_-]*keys?)\b/i;
var SECRET_FLAGS = ["sensitive", "password", "secret", "isSensitive", "isPassword", "isSecret"];
async function handleExtensionUiRequest(event, host) {
  const method = text(event, "method");
  if (method === "notify") {
    const level = text(event, "notifyType");
    try {
      const message = text(event, "message") || "Pi notification";
      const severity = level === "warning" || level === "error" ? level : "info";
      await host.emit(
        host.clientCapabilities?.session?.notices != null ? {
          sessionUpdate: "notice",
          severity,
          title: message
        } : {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: message },
          _meta: { piAcp: { notify: { level: severity } } }
        }
      );
    } catch {
    }
    return;
  }
  if (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor") return;
  const id = text(event, "id");
  if (!id) return;
  let replied = false;
  const reply = async (response) => {
    if (replied) return;
    replied = true;
    try {
      await host.sendResponse(host.signal?.aborted || host.conn.signal.aborted ? { id, cancelled: true } : response);
    } catch {
    }
  };
  const cancel = () => reply({ id, cancelled: true });
  try {
    if (method === "confirm") {
      const result2 = await waitForDialog(
        event,
        host,
        () => host.conn.requestPermission({
          sessionId: host.sessionId,
          toolCall: permissionToolCall(id, method, event),
          options: CONFIRM_OPTIONS
        })
      );
      if (result2.state === "expired") return;
      if (result2.state !== "answered" || result2.value.outcome.outcome !== "selected") return await cancel();
      const optionId = result2.value.outcome.optionId;
      if (optionId !== "yes" && optionId !== "no") return await cancel();
      return await reply({ id, confirmed: optionId === "yes" });
    }
    const title = text(event, "title") ?? `Pi ${method}`;
    let options;
    if (method === "select") {
      const raw = event.options;
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((option) => typeof option === "string")) {
        return await cancel();
      }
      options = raw;
      if (!host.clientCapabilities?.elicitation?.form) {
        const result2 = await waitForDialog(
          event,
          host,
          () => host.conn.requestPermission({
            sessionId: host.sessionId,
            toolCall: permissionToolCall(id, method, event),
            // Compatibility buttons only: option labels do not define authorization policy.
            options: raw.map((name, index2) => ({ optionId: `choice-${index2}`, name, kind: "allow_once" }))
          })
        );
        if (result2.state === "expired") return;
        if (result2.state !== "answered" || result2.value.outcome.outcome !== "selected") return await cancel();
        const index = choiceIndex(result2.value.outcome.optionId);
        const value2 = index === null ? void 0 : options[index];
        return await reply(value2 === void 0 ? { id, cancelled: true } : { id, value: value2 });
      }
    } else {
      if (!isPlainTextRequest(event)) {
        await unsupported(host, method, "Sensitive or custom-schema text requests are not supported.");
        return await cancel();
      }
      if (!host.clientCapabilities?.elicitation?.form) {
        await unsupported(host, method, "This client does not support text forms.");
        return await cancel();
      }
    }
    const field = {
      type: "string",
      title,
      ...options ? { enum: [...new Set(options)] } : {},
      ...method === "input" && typeof event.placeholder === "string" ? { description: event.placeholder } : {},
      ...method === "editor" && typeof event.prefill === "string" ? { default: event.prefill } : {}
    };
    const result = await waitForDialog(
      event,
      host,
      () => host.conn.createElicitation({
        sessionId: host.sessionId,
        mode: "form",
        message: options ? title : `${title}

${SECRET_DISCLOSURE}`,
        requestedSchema: { type: "object", properties: { value: field }, required: ["value"] }
      })
    );
    if (result.state === "expired") return;
    if (result.state !== "answered" || !CreateElicitationResponse.isAccept(result.value)) return await cancel();
    const value = result.value.content?.value;
    if (typeof value !== "string" || options && !options.includes(value)) return await cancel();
    await reply({ id, value });
  } catch {
    await cancel();
  }
}
function text(event, key) {
  return typeof event[key] === "string" ? event[key] : void 0;
}
function permissionToolCall(id, method, event) {
  const rawInput = { method };
  for (const key of ["title", "message", "options"]) {
    if (Object.hasOwn(event, key)) rawInput[key] = event[key];
  }
  const message = text(event, "message");
  return {
    toolCallId: `pi-ui-${id}`,
    title: text(event, "title") ?? `Pi ${method}`,
    kind: "other",
    status: "pending",
    rawInput,
    ...message ? { content: [{ type: "content", content: { type: "text", text: message } }] } : {}
  };
}
function choiceIndex(optionId) {
  const match = /^choice-(0|[1-9]\d*)$/.exec(optionId);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) ? index : null;
}
function isPlainTextRequest(event) {
  if (SECRET_FLAGS.some((key) => event[key] !== void 0 && event[key] !== null && event[key] !== false)) return false;
  if (event.inputType !== void 0 && event.inputType !== "text" && event.inputType !== "textarea") return false;
  if (event.type !== void 0 && event.type !== "extension_ui_request") return false;
  if (["schema", "requestedSchema", "properties", "format"].some((key) => Object.hasOwn(event, key))) return false;
  for (const key of ["title", "message", "placeholder", "prefill"]) {
    if (event[key] !== void 0 && typeof event[key] !== "string") return false;
  }
  return !["title", "message", "placeholder"].some((key) => CREDENTIAL_TEXT.test(text(event, key) ?? ""));
}
async function unsupported(host, method, reason) {
  await host.emit({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `Pi ${method} UI request cancelled. ${reason}` }
  });
}
function waitForDialog(event, host, request) {
  const signals = [...new Set([host.signal, host.conn.signal].filter((signal) => !!signal))];
  if (signals.some((signal) => signal.aborted)) return Promise.resolve({ state: "cancelled" });
  const timeout = event.timeout;
  const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : void 0;
  const deadline = timeoutMs === void 0 ? void 0 : performance.now() + timeoutMs;
  return new Promise((resolve4) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", aborted);
      resolve4(result);
    };
    const aborted = () => finish({ state: "cancelled" });
    const expire = () => {
      const remaining = (deadline ?? 0) - performance.now();
      if (remaining <= 0) finish({ state: "expired" });
      else timer = setTimeout(expire, Math.min(remaining, 2147483647));
    };
    for (const signal of signals) signal.addEventListener("abort", aborted, { once: true });
    if (timeoutMs !== void 0) timer = setTimeout(expire, Math.min(timeoutMs, 2147483647));
    try {
      request().then(
        (value) => {
          if (deadline !== void 0 && performance.now() >= deadline) finish({ state: "expired" });
          else if (signals.some((signal) => signal.aborted)) finish({ state: "cancelled" });
          else finish({ state: "answered", value });
        },
        () => finish({ state: "cancelled" })
      );
    } catch {
      finish({ state: "cancelled" });
    }
  });
}

// src/acp/translate/message-id.ts
import { randomUUID as randomUUID2 } from "crypto";
function messageKey(message) {
  if (typeof message !== "object" || message === null) return void 0;
  const record = message;
  if (record.role !== "assistant" && record.role !== "user") return void 0;
  if (typeof record.timestamp !== "number" || !Number.isFinite(record.timestamp)) return void 0;
  return `${record.role}:${record.timestamp}`;
}
var MessageIds = class {
  occurrences = /* @__PURE__ */ new Map();
  next(message) {
    const key = messageKey(message);
    if (!key) return `pi-acp:${randomUUID2()}`;
    const occurrence = (this.occurrences.get(key) ?? 0) + 1;
    this.occurrences.set(key, occurrence);
    return `pi-acp:${key}:${occurrence}`;
  }
  seed(messages) {
    this.occurrences.clear();
    for (const message of messages) {
      if (messageKey(message)) this.next(message);
    }
  }
};

// src/acp/session.ts
function toUsageUpdate(stats) {
  const used = stats?.contextUsage?.tokens;
  const size = stats?.contextUsage?.contextWindow;
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  return { sessionUpdate: "usage_update", used, size };
}
function emptySummary() {
  return {
    aborted: false,
    retries: 0,
    compactions: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  };
}
function addMessageUsage(summary, usage) {
  if (typeof usage !== "object" || usage === null) return;
  const u = usage;
  const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  summary.usage.input += num(u.input);
  summary.usage.output += num(u.output);
  summary.usage.cacheRead += num(u.cacheRead);
  summary.usage.cacheWrite += num(u.cacheWrite);
  const cost = u.cost;
  summary.usage.cost += num(typeof cost === "object" && cost !== null ? cost.total : cost);
}
function contextTokens(stats) {
  const tokens = stats?.contextUsage?.tokens;
  return typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null;
}
function deriveTurnUsage(pre, post) {
  const before = contextTokens(pre);
  const after = contextTokens(post);
  if (before === null || after === null || after < before) return null;
  return { totalTokens: after, inputTokens: before, outputTokens: after - before };
}
function findUniqueLineNumber(text2, needle) {
  if (!needle) return void 0;
  const first = text2.indexOf(needle);
  if (first < 0) return void 0;
  const second = text2.indexOf(needle, first + needle.length);
  if (second >= 0) return void 0;
  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text2.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function getToolPath(args) {
  const record = args;
  if (typeof record?.path === "string") return record.path;
  if (typeof record?.file_path === "string") return record.file_path;
  return void 0;
}
function getParsedEdits(args) {
  const record = args;
  const parsed = [];
  if (typeof record?.oldText === "string" && typeof record?.newText === "string") {
    parsed.push({ oldText: record.oldText, newText: record.newText });
  }
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit;
      if (typeof item?.oldText === "string" && typeof item?.newText === "string") {
        parsed.push({ oldText: item.oldText, newText: item.newText });
      }
    }
  }
  return parsed;
}
function getEditOldTexts(args) {
  const record = args;
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);
  if (typeof record?.oldText === "string" && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText);
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = edit?.oldText;
      if (typeof oldText === "string" && !oldTexts.includes(oldText)) oldTexts.push(oldText);
    }
  }
  return oldTexts;
}
function toToolCallLocations(args, cwd, line) {
  const path = getToolPath(args);
  if (!path) return void 0;
  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
}
var KEEPALIVE_DEFAULT_INTERVAL_MS = 75e3;
function keepaliveIntervalMs() {
  const raw = Number(process.env.PI_ACP_KEEPALIVE_MS);
  if (!Number.isFinite(raw) || raw < 0) return KEEPALIVE_DEFAULT_INTERVAL_MS;
  return raw;
}
var SessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll() {
    for (const [id] of this.sessions) this.close(id);
  }
  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session?.isDisposed()) {
      this.close(sessionId);
      return void 0;
    }
    return session;
  }
  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.dispose();
    } catch {
    }
    this.sessions.delete(sessionId);
  }
  async create(params) {
    const mcpInjection = params.mcpServers.length ? prepareMcpInjection(params.mcpServers) : null;
    let proc;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand,
        ...mcpInjection ? { mcpInjection } : {},
        ...params.launch?.args.length ? { launchArgs: params.launch.args } : {},
        ...params.launch?.systemPrompt ? { systemPrompt: params.launch.systemPrompt } : {}
      });
    } catch (e) {
      mcpInjection?.cleanup();
      if (e instanceof PiRpcSpawnError) {
        throw RequestError2.internalError({ code: e.code }, e.message);
      }
      throw e;
    }
    let state = null;
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: true,
      mcpInjection,
      clientCapabilities: params.clientCapabilities,
      headless: params.launch?.headless === true
    });
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId) {
    const s = this.maybeGet(sessionId);
    if (!s) throw RequestError2.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }
  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId, params) {
    const existing = this.maybeGet(sessionId);
    if (existing) return existing;
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? [],
      autoTitle: false,
      mcpInjection: params.mcpInjection,
      clientCapabilities: params.clientCapabilities,
      headless: params.launch?.headless === true
    });
    this.sessions.set(sessionId, session);
    return session;
  }
};
var PiAcpSession = class {
  sessionId;
  cwd;
  mcpServers;
  mcpInjection;
  clientCapabilities;
  /** `_meta.piAcp.headless`: no banner or queue chatter; notices go out as `_meta`. */
  headless;
  startupInfo = null;
  startupInfoSent = false;
  initialTitlePending;
  lastPublishedTitle;
  titleUpdateQueue = Promise.resolve();
  proc;
  conn;
  fileCommands;
  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  cancelRequested = false;
  steering = new Steering((text2) => this.proc.steer(text2));
  steeringReplay = [];
  async steer(text2) {
    if (!this.pendingTurn || this.cancelRequested) return { outcome: "promptRequired" };
    await this.steering.inject(text2);
    return { outcome: "injected" };
  }
  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
  turnQueue = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  currentToolCalls = /* @__PURE__ */ new Map();
  terminalToolCalls = /* @__PURE__ */ new Set();
  interactions = new AbortController();
  messageIds = new MessageIds();
  activeMessageId;
  activeMessageKey;
  activeCompactionId;
  compactionVersion = 0;
  manualCompaction = false;
  compactionCancelled = false;
  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  inAgentLoop = false;
  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  fileSnapshots = /* @__PURE__ */ new Map();
  fileMutationToolCallIds = /* @__PURE__ */ new Set();
  bashToolCallIds = /* @__PURE__ */ new Set();
  bashOutputSnapshots = /* @__PURE__ */ new Map();
  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  lastEmit = Promise.resolve();
  disposed = false;
  disposalReason;
  /** Why the pi process stopped, from its terminal error. */
  failure;
  unsubscribe;
  keepaliveTimer = null;
  lastUpdateSentAt = Date.now();
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.mcpInjection = opts.mcpInjection ?? null;
    this.clientCapabilities = opts.clientCapabilities ?? {};
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    this.initialTitlePending = opts.autoTitle ?? false;
    this.headless = opts.headless === true;
    this.unsubscribe = this.proc.onEvent((ev) => {
      if (!this.disposed) this.handlePiEvent(ev);
    });
  }
  isTurnActive() {
    return !this.disposed && (this.isExecutionBusy() || this.turnQueue.length > 0);
  }
  isExecutionBusy() {
    return this.pendingTurn !== null || this.inAgentLoop || this.activeCompactionId !== void 0 || this.manualCompaction;
  }
  isDisposed() {
    return this.disposed;
  }
  seedMessageIds(messages) {
    this.messageIds.seed(messages);
  }
  messageIdForReplay(message) {
    return this.messageIds.next(message);
  }
  async compact(customInstructions, signal) {
    if (signal?.aborted) return { cancelled: true };
    if (this.disposed) throw RequestError2.invalidParams("Session is closed");
    if (this.isTurnActive()) throw RequestError2.invalidParams("Cannot compact while a prompt is active");
    const abort = () => {
      void this.proc.abort().catch(() => {
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.manualCompaction = true;
    this.cancelRequested = false;
    const version = this.compactionVersion;
    this.handlePiEvent({ type: "compaction_start", reason: "manual" });
    this.ensureKeepalive();
    try {
      const result = await this.proc.compact(customInstructions);
      if (this.compactionVersion === version)
        this.handlePiEvent({ type: "compaction_end", reason: "manual", result, aborted: signal?.aborted === true });
      await this.flushEmits();
      return signal?.aborted || this.cancelRequested || this.disposalReason === "cancelled" || this.compactionCancelled ? { cancelled: true } : { cancelled: false, result };
    } catch (error) {
      if (this.compactionVersion === version) {
        this.handlePiEvent({
          type: "compaction_end",
          reason: "manual",
          aborted: signal?.aborted === true || this.cancelRequested || this.disposalReason === "cancelled",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      }
      await this.flushEmits();
      if (signal?.aborted || this.cancelRequested || this.disposalReason === "cancelled" || this.compactionCancelled)
        return { cancelled: true };
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.manualCompaction = false;
      this.startNextTurn();
    }
  }
  dispose(reason = "cancelled") {
    if (this.disposed) return;
    if (this.activeCompactionId && this.clientCapabilities.session?.compaction != null) {
      this.emit({
        sessionUpdate: "compaction_update",
        compactionId: this.activeCompactionId,
        status: reason === "cancelled" ? "cancelled" : "failed"
      });
      this.activeCompactionId = void 0;
    }
    this.finishOutstandingTools(reason === "cancelled" ? "Session closed." : "Pi process stopped.");
    this.disposed = true;
    this.disposalReason = reason;
    this.stopKeepalive();
    this.interactions.abort();
    this.unsubscribe?.();
    const turn = this.pendingTurn;
    this.pendingTurn = null;
    const queued = this.turnQueue.splice(0);
    if (reason === "error") {
      const why = turn?.errorMessage ?? this.failure;
      for (const item of [turn?.queued, ...queued]) if (item?.usageOut) item.usageOut.error = why;
    }
    void this.flushEmits().then(() => {
      turn?.resolve(reason);
      for (const item of queued) item.resolve(reason);
    });
    this.proc.dispose();
  }
  setStartupInfo(text2) {
    if (this.headless) return;
    this.startupInfo = text2;
    this.startupInfoSent = false;
  }
  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending() {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo }
    });
  }
  async prompt(message, images = [], title, signal, usageOut) {
    if (this.disposed || signal?.aborted) return "cancelled";
    const expandedMessage = expandSlashCommand(message, this.fileCommands);
    let queued;
    const abort = () => {
      if (this.pendingTurn?.queued === queued) {
        this.cancelRequested = true;
        this.interactions.abort();
        this.finishOutstandingTools("Cancelled.");
        void this.proc.abort().catch(() => {
        });
      } else {
        const index = this.turnQueue.indexOf(queued);
        if (index < 0) return;
        this.turnQueue.splice(index, 1);
        queued.resolve("cancelled");
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: Boolean(this.pendingTurn) } }
        });
      }
    };
    const turnPromise = new Promise((resolve4, reject) => {
      queued = { message: expandedMessage, images, title, resolve: resolve4, reject, usageOut };
      signal?.addEventListener("abort", abort, { once: true });
      if (this.isExecutionBusy()) {
        this.turnQueue.push(queued);
        this.ensureKeepalive();
        if (!this.headless)
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Queued message (position ${this.turnQueue.length}).`
            }
          });
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        });
        return;
      }
      this.startTurn(queued);
    });
    try {
      return await turnPromise;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  async cancel() {
    this.cancelRequested = true;
    this.steering.clear();
    this.steeringReplay = [];
    this.interactions.abort();
    this.finishOutstandingTools("Cancelled.");
    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const t of queued) t.resolve("cancelled");
      if (!this.headless)
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Cleared queued prompts." }
        });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      });
    }
    try {
      await this.steering.drain();
      if (typeof this.proc.clearQueue === "function") await this.proc.clearQueue();
    } finally {
      await this.proc.abort();
    }
  }
  wasCancelRequested() {
    return this.cancelRequested;
  }
  async setSessionName(name) {
    return this.enqueueTitleUpdate(async () => {
      await this.proc.setSessionName(name);
      this.publishTitle(name);
    });
  }
  enqueueTitleUpdate(update) {
    const result = this.titleUpdateQueue.then(update);
    this.titleUpdateQueue = result.catch(() => {
    });
    return result;
  }
  publishTitle(title, updatedAt = (/* @__PURE__ */ new Date()).toISOString()) {
    if (this.lastPublishedTitle === title) return this.lastEmit;
    this.lastPublishedTitle = title;
    this.emit({
      sessionUpdate: "session_info_update",
      title,
      ...updatedAt ? { updatedAt } : {}
    });
    return this.lastEmit;
  }
  async maybeAutoTitle(title) {
    if (!this.initialTitlePending || !title) return;
    this.initialTitlePending = false;
    try {
      await this.enqueueTitleUpdate(async () => {
        const state = await this.proc.getState();
        const currentTitle = typeof state?.sessionName === "string" ? state.sessionName.trim() : "";
        if (currentTitle) {
          this.publishTitle(currentTitle);
          return;
        }
        if (this.lastPublishedTitle) return;
        await this.proc.setSessionName(title);
        this.publishTitle(title);
      });
    } catch {
    }
  }
  emit(update) {
    if (this.disposed) return;
    this.lastUpdateSentAt = Date.now();
    this.lastEmit = this.lastEmit.then(
      () => this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    ).catch(() => {
    });
  }
  async flushEmits() {
    await this.lastEmit;
  }
  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage() {
    let stats = null;
    try {
      if (typeof this.proc.getSessionStats === "function") {
        stats = await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS);
        const update = toUsageUpdate(stats);
        if (update) this.emit(update);
      }
    } catch {
    }
    await this.flushEmits();
    return stats;
  }
  async settleTurn() {
    try {
      await this.settleSteering();
    } catch (err) {
      const turn = this.pendingTurn;
      if (!turn) return;
      this.steering.clear();
      this.steeringReplay = [];
      turn.completing = false;
      turn.outcome = "error";
      turn.errorMessage = String(err);
      await this.completeTurn(turn);
    }
  }
  async settleSteering() {
    this.inAgentLoop = false;
    const turn = this.pendingTurn;
    if (turn) {
      if (!this.cancelRequested && typeof this.proc.clearQueue === "function") {
        const replay = await this.steering.leftovers(() => this.proc.clearQueue());
        if (this.pendingTurn !== turn) return;
        this.steeringReplay.push(...replay);
        const next = this.steeringReplay.shift();
        if (next !== void 0 && !this.cancelRequested) {
          this.steering.start();
          void this.proc.prompt(next).then((disposition) => {
            if (disposition === "handled") void this.settleTurn();
          }).catch((err) => {
            turn.outcome = "error";
            turn.errorMessage = String(err);
            void this.completeTurn(turn);
          });
          return;
        }
      }
      turn.settled = true;
      if (turn.acknowledged) await this.completeTurn(turn);
    } else {
      await this.publishContextUsage();
      this.startNextTurn();
    }
  }
  async completeTurn(turn) {
    if (this.pendingTurn !== turn || turn.completing || !turn.acknowledged) return;
    turn.completing = true;
    const cancelled = this.cancelRequested || turn.outcome === "cancelled" || turn.summary.aborted;
    this.finishOutstandingTools(this.cancelRequested ? "Cancelled." : "Turn ended before the tool completed.");
    const postStats = await this.publishContextUsage();
    if (this.pendingTurn !== turn) return;
    if (!this.cancelRequested && this.steering.hasPending) {
      turn.completing = false;
      await this.settleTurn();
      return;
    }
    this.pendingTurn = null;
    if (turn.queued.usageOut) {
      const stopReason = cancelled ? "cancelled" : turn.outcome ?? "end_turn";
      turn.queued.usageOut.summary = { ...turn.summary, stopReason };
    }
    if (cancelled) turn.resolve("cancelled");
    else if (turn.outcome === "error") {
      const error = new Error(turn.errorMessage || "Pi provider failed");
      turn.reject(
        maybeAuthRequiredError(error, this.clientCapabilities) ?? RequestError2.internalError({ reason: "pi_error" }, error.message)
      );
    } else {
      const preStats = await Promise.race([
        turn.preStats,
        new Promise((resolve4) => {
          const timer = setTimeout(resolve4, SESSION_STATS_TIMEOUT_MS, null);
          timer.unref?.();
        })
      ]);
      const usage = deriveTurnUsage(preStats, postStats);
      if (usage && turn.queued.usageOut) turn.queued.usageOut.usage = usage;
      turn.resolve(turn.outcome ?? "end_turn");
    }
    this.startNextTurn();
  }
  startNextTurn() {
    if (this.disposed) return;
    if (this.isExecutionBusy()) return;
    const next = this.turnQueue.shift();
    if (next) {
      if (!this.headless)
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        });
      this.startTurn(next);
    } else {
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: false } }
      });
    }
  }
  emitBashToolCall(params) {
    this.bashToolCallIds.add(params.toolCallId);
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      name: params.toolName,
      kind: "execute",
      status: params.status,
      locations: params.locations,
      ...params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {},
      ...params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {}
    });
  }
  richToolContent(result) {
    return toolResultToContent(result);
  }
  emitBashOutputUpdate(params) {
    const text2 = bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text2);
    this.bashOutputSnapshots.set(params.toolCallId, text2);
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: params.status,
      ...params.status !== "in_progress" ? { rawOutput: params.result } : {},
      _meta: {
        ...delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {},
        ...params.status === "completed" || params.status === "failed" ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError))) : {}
      }
    });
  }
  cleanupToolCall(toolCallId) {
    this.terminalToolCalls.add(toolCallId);
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }
  startTurn(t) {
    this.steering.clear();
    this.steeringReplay = [];
    this.steering.start();
    this.cancelRequested = false;
    this.inAgentLoop = false;
    this.activeMessageId = void 0;
    this.activeMessageKey = void 0;
    if (this.interactions.signal.aborted) this.interactions = new AbortController();
    this.ensureKeepalive();
    const turn = {
      queued: t,
      acknowledged: false,
      settled: false,
      title: t.title,
      resolve: t.resolve,
      reject: t.reject,
      preStats: Promise.resolve(null),
      summary: emptySummary()
    };
    this.pendingTurn = turn;
    turn.preStats = typeof this.proc.getSessionStats === "function" ? this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS).catch(() => null) : Promise.resolve(null);
    void this.maybeAutoTitle(t.title);
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
    const acceptDisposition = (disposition) => {
      if (this.pendingTurn !== turn || turn.acknowledged) return;
      turn.acknowledged = true;
      if (disposition === "started" || disposition === "queued") turn.settled = false;
      if (disposition === "handled" || turn.settled) void this.completeTurn(turn);
    };
    this.proc.prompt(t.message, t.images, void 0, acceptDisposition).then(acceptDisposition).catch(async (err) => {
      if (this.pendingTurn !== turn) return;
      this.finishOutstandingTools(this.cancelRequested ? "Cancelled." : "Pi prompt failed.");
      await this.flushEmits();
      if (this.pendingTurn !== turn) return;
      const authErr = maybeAuthRequiredError(err, this.clientCapabilities);
      this.steering.clear();
      this.steeringReplay = [];
      this.pendingTurn = null;
      if (turn.queued.usageOut) turn.queued.usageOut.error = err instanceof Error ? err.message : String(err);
      if (this.cancelRequested) turn.resolve("cancelled");
      else if (authErr) turn.reject(authErr);
      else turn.resolve(this.cancelRequested ? "cancelled" : "error");
      for (const queued of this.turnQueue.splice(0)) queued.resolve("error");
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
      });
      void err;
    });
  }
  ensureKeepalive() {
    if (this.keepaliveTimer || this.disposed) return;
    const interval = keepaliveIntervalMs();
    if (interval <= 0) return;
    this.keepaliveTimer = setInterval(
      () => {
        if (!this.isTurnActive()) {
          this.stopKeepalive();
          return;
        }
        if (Date.now() - this.lastUpdateSentAt >= interval) {
          this.emit({
            sessionUpdate: "session_info_update",
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true, keepalive: true } }
          });
        }
      },
      Math.max(250, Math.round(interval / 3))
    );
    this.keepaliveTimer.unref?.();
  }
  stopKeepalive() {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
  finishOutstandingTools(message) {
    for (const toolCallId of this.currentToolCalls.keys()) {
      this.emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: message } }],
        ...this.bashToolCallIds.has(toolCallId) ? { _meta: bashTerminalExitMeta(toolCallId, 1) } : {}
      });
      this.cleanupToolCall(toolCallId);
    }
  }
  emitNotice(title, severity = "info") {
    if (this.clientCapabilities.session?.notices != null) {
      this.emit({ sessionUpdate: "notice", title, severity });
    } else if (this.headless) {
      this.emit({ sessionUpdate: "session_info_update", _meta: { piAcp: { notice: { title, severity } } } });
    } else {
      this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: title } });
    }
  }
  handlePiEvent(ev) {
    const type = String(ev.type ?? "");
    const toolCallId = typeof ev.toolCallId === "string" ? ev.toolCallId : void 0;
    if (type.startsWith("tool_execution_") && toolCallId && this.terminalToolCalls.has(toolCallId)) return;
    switch (type) {
      case "message_start": {
        const key = messageKey(ev.message);
        const messageId = this.messageIds.next(ev.message);
        if (key?.startsWith("assistant:")) {
          this.activeMessageKey = key;
          this.activeMessageId = messageId;
        }
        break;
      }
      case "message_end": {
        const message = typeof ev.message === "object" && ev.message !== null ? ev.message : void 0;
        if (message?.role === "assistant" && this.pendingTurn) {
          addMessageUsage(this.pendingTurn.summary, message.usage);
          if (message.stopReason === "error" && typeof message.errorMessage === "string")
            this.pendingTurn.summary.errorMessage = message.errorMessage;
          this.pendingTurn.outcome = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "cancelled" : message.stopReason === "length" ? "max_tokens" : "end_turn";
          this.pendingTurn.errorMessage = message.stopReason === "error" && typeof message.errorMessage === "string" ? message.errorMessage : void 0;
        }
        if (messageKey(ev.message)?.startsWith("assistant:")) {
          this.activeMessageId = void 0;
          this.activeMessageKey = void 0;
        }
        break;
      }
      case "pi_acp_process_error": {
        this.failure = typeof ev.message === "string" ? ev.message : void 0;
        this.emitNotice(this.failure ?? "Pi process stopped.", "error");
        this.finishOutstandingTools("Pi process stopped.");
        this.dispose("error");
        break;
      }
      case "session_info_changed": {
        const name = ev.name;
        if (typeof name === "string" || name === void 0) this.publishTitle(name ?? null);
        break;
      }
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        const key = messageKey(ev.message);
        if (!this.activeMessageId || key && key !== this.activeMessageKey) {
          this.activeMessageId = this.messageIds.next(ev.message);
          this.activeMessageKey = key;
        }
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            messageId: this.activeMessageId,
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            messageId: `${this.activeMessageId}:thought`,
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
          const toolCall = (
            // pi sometimes includes the tool call directly on the event
            ame?.toolCall ?? // ...and always includes it in the partial assistant message at contentIndex
            ame?.partial?.content?.[ame?.contentIndex ?? 0]
          );
          const toolCallId2 = String(toolCall?.id ?? "");
          const toolName = String(toolCall?.name ?? "tool");
          if (toolCallId2) {
            if (this.terminalToolCalls.has(toolCallId2)) break;
            const rawInput = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : (() => {
              const s = String(toolCall?.partialArgs ?? "");
              if (!s) return void 0;
              try {
                return JSON.parse(s);
              } catch {
                return { partialArgs: s };
              }
            })();
            const locations = toToolCallLocations(rawInput, this.cwd);
            const existingStatus = this.currentToolCalls.get(toolCallId2);
            const status = existingStatus ?? "pending";
            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId2, "pending");
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                toolCallId: toolCallId2,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              });
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId2, "pending");
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId: toolCallId2,
                title: toolName,
                name: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              });
            } else {
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId: toolCallId2,
                status,
                locations,
                rawInput
              });
            }
          }
          break;
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId2 = String(ev.toolCallId ?? crypto.randomUUID());
        const toolName = String(ev.toolName ?? "tool");
        const args = ev.args;
        let line;
        if (isBashTool(toolName)) {
          const locations2 = toToolCallLocations(args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId2);
          this.currentToolCalls.set(toolCallId2, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId: toolCallId2,
            toolName,
            args,
            status: "in_progress",
            locations: locations2,
            includeTerminal: !existingStatus
          });
          break;
        }
        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId2);
          const p = getToolPath(args);
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              snapshotOldText = readFileSync2(abs, "utf8");
              this.fileSnapshots.set(toolCallId2, { path: p, oldText: snapshotOldText });
              if (toolName === "edit") {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (typeof line === "number") break;
                }
              }
            } catch {
              snapshotOldText = null;
              this.fileSnapshots.set(toolCallId2, { path: p, oldText: null });
            }
          }
        }
        const locations = toToolCallLocations(args, this.cwd, line);
        if (!this.currentToolCalls.has(toolCallId2)) {
          this.currentToolCalls.set(toolCallId2, "in_progress");
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId: toolCallId2,
            title: toolName,
            name: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args
          });
        } else {
          this.currentToolCalls.set(toolCallId2, "in_progress");
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId: toolCallId2,
            status: "in_progress",
            locations,
            rawInput: args
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId2 = String(ev.toolCallId ?? "");
        if (!toolCallId2) break;
        const partial = ev.partialResult;
        if (this.bashToolCallIds.has(toolCallId2)) {
          this.emitBashOutputUpdate({ toolCallId: toolCallId2, status: "in_progress", result: partial });
          break;
        }
        const content = this.fileMutationToolCallIds.has(toolCallId2) ? [] : this.richToolContent(partial);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: toolCallId2,
          status: "in_progress",
          content: content.length ? content : void 0,
          ...this.fileMutationToolCallIds.has(toolCallId2) ? {} : { rawOutput: partial }
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId2 = String(ev.toolCallId ?? "");
        if (!toolCallId2) break;
        const result = ev.result;
        const isError = Boolean(ev.isError);
        if (this.bashToolCallIds.has(toolCallId2)) {
          this.emitBashOutputUpdate({
            toolCallId: toolCallId2,
            status: isError ? "failed" : "completed",
            result,
            isError
          });
          this.cleanupToolCall(toolCallId2);
          break;
        }
        const snapshot = this.fileSnapshots.get(toolCallId2);
        let content;
        let hasStructuredDiff = false;
        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync2(abs, "utf8");
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true;
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ];
            }
          } catch {
          }
        }
        if (!content && !hasStructuredDiff) {
          const resultContent = this.richToolContent(result);
          if (resultContent.length) content = resultContent;
        }
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId: toolCallId2,
          status: isError ? "failed" : "completed",
          content,
          ...hasStructuredDiff ? {} : { rawOutput: result }
        });
        this.cleanupToolCall(toolCallId2);
        break;
      }
      case "extension_ui_request": {
        void handleExtensionUiRequest(ev, {
          sessionId: this.sessionId,
          conn: this.conn,
          clientCapabilities: this.clientCapabilities,
          signal: this.interactions.signal,
          sendResponse: (response) => this.proc.sendExtensionUiResponse(response),
          emit: (update) => this.emit(update)
        }).catch(() => {
        });
        break;
      }
      case "auto_retry_start": {
        if (this.pendingTurn) this.pendingTurn.summary.retries++;
        this.emitNotice(formatAutoRetryMessage(ev));
        break;
      }
      case "auto_retry_end": {
        if (ev.success === false)
          this.emitNotice(
            `Retry failed: ${typeof ev.finalError === "string" ? ev.finalError : "unknown error"}`,
            "error"
          );
        else this.emitNotice("Retry finished, resuming.");
        break;
      }
      case "compaction_start":
      case "auto_compaction_start": {
        if (this.activeCompactionId) break;
        this.compactionCancelled = false;
        this.activeCompactionId = randomUUID3();
        if (this.clientCapabilities.session?.compaction != null) {
          this.emit({
            sessionUpdate: "compaction_update",
            compactionId: this.activeCompactionId,
            status: "in_progress"
          });
          break;
        }
        this.emitNotice(
          ev.reason === "manual" ? "Compacting context..." : "Context nearing limit, running automatic compaction..."
        );
        break;
      }
      case "compaction_end":
      case "auto_compaction_end": {
        if (this.pendingTurn && ev.aborted !== true) this.pendingTurn.summary.compactions++;
        this.compactionVersion++;
        this.compactionCancelled = ev.aborted === true;
        if (this.clientCapabilities.session?.compaction != null) {
          const result = typeof ev.result === "object" && ev.result !== null ? ev.result : void 0;
          const error = typeof ev.errorMessage === "string" && ev.errorMessage ? ev.errorMessage : void 0;
          const summary = typeof result?.summary === "string" ? result.summary : void 0;
          this.emit({
            sessionUpdate: "compaction_update",
            compactionId: this.activeCompactionId ?? randomUUID3(),
            status: ev.aborted === true ? "cancelled" : error ? "failed" : "completed",
            ...summary !== void 0 ? { summary: [{ type: "text", text: summary }] } : {},
            ...error && ev.aborted !== true ? { error } : {}
          });
          this.activeCompactionId = void 0;
          break;
        }
        this.activeCompactionId = void 0;
        if (ev.aborted === true) this.emitNotice("Compaction cancelled.");
        else if (typeof ev.errorMessage === "string" && ev.errorMessage)
          this.emitNotice(`Compaction failed: ${ev.errorMessage}`, "error");
        else this.emitNotice("Automatic compaction finished; context was summarized to continue the session.");
        break;
      }
      case "agent_start": {
        this.inAgentLoop = true;
        void this.steering.running().catch(() => {
        });
        break;
      }
      case "turn_end": {
        break;
      }
      case "agent_end": {
        this.steering.ended();
        this.inAgentLoop = false;
        break;
      }
      case "agent_settled": {
        if (this.pendingTurn && ev.aborted === true) this.pendingTurn.summary.aborted = true;
        void this.settleTurn();
        break;
      }
      default:
        break;
    }
  }
};
function formatAutoRetryMessage(ev) {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }
  let delaySeconds = Math.round(delayMs / 1e3);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;
  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
function toToolKind(toolName) {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    case "grep":
    case "find":
    case "ls":
    case "rg":
      return "search";
    case "trash":
    case "rm":
      return "delete";
    case "mv":
    case "move":
    case "rename":
      return "move";
    case "fetch":
    case "web_fetch":
      return "fetch";
    case "todo":
      return "think";
    default:
      return "other";
  }
}

// src/acp/pi-sessions.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync3, statSync, openSync as openSync2, readSync, closeSync as closeSync2, existsSync as existsSync3 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join4, resolve as resolve2, isAbsolute as isAbsolute2 } from "path";

// src/acp/translate/prompt.ts
function promptToSessionTitle(blocks) {
  const normalized = blocks.filter((block) => block.type === "text").map((block) => block.text).join(" ").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, 80).join("");
}
function promptToPiMessage(blocks) {
  let message = "";
  const images = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;
      case "resource_link":
        message += `
[Context] ${b.uri}`;
        break;
      case "image": {
        images.push({
          type: "image",
          mimeType: b.mimeType,
          data: b.data
        });
        break;
      }
      case "resource": {
        const r = b.resource;
        const uri = typeof r?.uri === "string" ? r.uri : "(unknown)";
        if (typeof r?.text === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "text/plain";
          message += `
[Embedded Context] ${uri} (${mime})
${r.text}`;
        } else if (typeof r?.blob === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "application/octet-stream";
          const bytes = Buffer.byteLength(r.blob, "base64");
          message += `
[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`;
        } else {
          message += `
[Embedded Context] ${uri}`;
        }
        break;
      }
      case "audio": {
        const bytes = Buffer.byteLength(b.data, "base64");
        message += `
[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`;
        break;
      }
      default:
        break;
    }
  }
  return { message, images };
}

// src/acp/pi-sessions.ts
var DEFAULT_TAIL_BYTES = 256 * 1024;
var DEFAULT_HEAD_BYTES = 64 * 1024;
function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join4(homedir2(), ".pi", "agent");
}
function readSessionDirFromSettings(agentDir) {
  const settingsPath = join4(agentDir, "settings.json");
  try {
    if (!existsSync3(settingsPath)) return null;
    const raw = readFileSync3(settingsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const sessionDir = data.sessionDir;
    if (typeof sessionDir !== "string" || !sessionDir.trim()) return null;
    return isAbsolute2(sessionDir) ? sessionDir : resolve2(agentDir, sessionDir);
  } catch {
    return null;
  }
}
function expandTilde(path) {
  return path === "~" || path.startsWith("~/") ? join4(homedir2(), path.slice(1)) : path;
}
function getConfiguredSessionDir(agentDir) {
  const fromEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
  return fromEnv ? resolve2(expandTilde(fromEnv)) : readSessionDirFromSettings(agentDir);
}
function getPiSessionsDir() {
  const agentDir = getPiAgentDir();
  return getConfiguredSessionDir(agentDir) ?? join4(agentDir, "sessions");
}
function getPiSessionDirForCwd(cwd) {
  const agentDir = getPiAgentDir();
  const configured = getConfiguredSessionDir(agentDir);
  if (configured) return configured;
  return join4(
    agentDir,
    "sessions",
    `--${resolve2(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
  );
}
function findPiSessionFile(dir, sessionId) {
  try {
    const name = readdirSync2(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
    return name ? join4(dir, name) : null;
  } catch {
    return null;
  }
}
function walkJsonlFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = typeof e.name === "string" ? e.name : String(e.name);
    const p = join4(dir, name);
    if (e.isDirectory()) walkJsonlFiles(p, out);
    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
}
function readFirstLine(path) {
  const fd = openSync2(path, "r");
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf-8");
    const idx = s.indexOf("\n");
    return idx === -1 ? s.trim() : s.slice(0, idx).trim();
  } catch {
    return null;
  } finally {
    try {
      closeSync2(fd);
    } catch {
    }
  }
}
function readTail(path, tailBytes = DEFAULT_TAIL_BYTES) {
  const st = statSync(path);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const fd = openSync2(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    try {
      closeSync2(fd);
    } catch {
    }
  }
}
function parseSessionHeader(firstLine) {
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type !== "session") return null;
    const sessionId = typeof obj?.id === "string" ? obj.id : null;
    const cwd = typeof obj?.cwd === "string" ? obj.cwd : null;
    if (!sessionId || !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}
function pickTitleFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "session_info" && typeof obj?.name === "string") {
        return obj.name.trim();
      }
    } catch {
    }
  }
  return null;
}
function scanSessionInfoNameFromFile(path) {
  const fd = openSync2(path, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let leftover = "";
    let offset = 0;
    let lastName = null;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      const chunk = leftover + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "session_info" && typeof obj?.name === "string") {
            lastName = obj.name.trim();
          }
        } catch {
        }
      }
    }
    const tailLine = leftover.trim();
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine);
        if (obj?.type === "session_info" && typeof obj?.name === "string") {
          lastName = obj.name.trim();
        }
      } catch {
      }
    }
    return lastName;
  } catch {
    return null;
  } finally {
    try {
      closeSync2(fd);
    } catch {
    }
  }
}
function pickUpdatedAtFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type !== "message") continue;
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  return null;
}
function pickFallbackTitleFromHead(path) {
  try {
    const raw = readFileSync3(path, { encoding: "utf8" });
    const lines = raw.split(/\r?\n/);
    for (const line0 of lines.slice(0, 2e3)) {
      const line = line0.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "message" && obj?.message?.role === "user") {
          const content = obj?.message?.content;
          if (typeof content === "string") {
            const title = promptToSessionTitle([{ type: "text", text: content }]);
            if (title) return title;
          }
          if (Array.isArray(content)) {
            const title = promptToSessionTitle(
              content.filter(
                (block) => typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string"
              )
            );
            if (title) return title;
          }
        }
      } catch {
      }
    }
  } catch {
  }
  return null;
}
function readPiSessionTitle(path, tail) {
  try {
    const name = pickTitleFromTail(tail ?? readTail(path)) ?? scanSessionInfoNameFromFile(path);
    return name || pickFallbackTitleFromHead(path);
  } catch {
    return null;
  }
}
function listPiSessions() {
  const sessionsDir = getPiSessionsDir();
  const files = [];
  walkJsonlFiles(sessionsDir, files);
  const items = [];
  for (const file of files) {
    const first = readFirstLine(file);
    if (!first) continue;
    const header = parseSessionHeader(first);
    if (!header) continue;
    let updatedAt = null;
    let title = null;
    try {
      const tail = readTail(file);
      title = readPiSessionTitle(file, tail);
      updatedAt = pickUpdatedAtFromTail(tail);
    } catch {
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    });
  }
  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });
  return items;
}

// src/acp/translate/pi-messages.ts
function normalizePiMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}
function normalizePiAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}
function normalizePiThoughtText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block !== "object" || block === null) return "";
    return block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : "";
  }).join("");
}

// src/acp/pi-settings.ts
import { existsSync as existsSync4, readFileSync as readFileSync4 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join5, resolve as resolve3 } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync4(path)) return {};
    const raw = readFileSync4(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedSettings(cwd) {
  const globalSettingsPath = join5(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve3(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve3(process.env.PI_CODING_AGENT_DIR) : join5(homedir3(), ".pi", "agent");
}
function getEnableSkillCommands(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") return direct;
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : void 0;
  if (typeof nested === "boolean") return nested;
  return true;
}
function getQuietStartup(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.quietStartup;
  if (typeof direct === "boolean") return direct;
  const legacy = merged.quietStart;
  if (typeof legacy === "boolean") return legacy;
  return false;
}

// src/acp/launch.ts
import { RequestError as RequestError3 } from "@agentclientprotocol/sdk/unstable";
function invalid(message) {
  return RequestError3.invalidParams({ reason: message }, message);
}
var ALLOWED = {
  "--model": true,
  "--thinking": true,
  "--tools": true,
  "-t": true,
  "--exclude-tools": true,
  "-xt": true,
  "--no-tools": false,
  "-nt": false,
  "-e": true,
  "--extension": true,
  "-ne": false,
  "--no-extensions": false,
  "--no-mcp": false,
  "--skill": true,
  "-ns": false,
  "--no-skills": false,
  "-np": false,
  "--no-prompt-templates": false,
  "-nc": false,
  "--no-context-files": false,
  "--approve": false,
  "-a": false
};
var ADAPTER_OWNED = /* @__PURE__ */ new Set([
  "--mode",
  "--session",
  "--session-id",
  "--session-dir",
  "--fork",
  "--no-session",
  "-p",
  "--print",
  "-c",
  "--continue",
  "-r",
  "--resume",
  "--system-prompt",
  "--append-system-prompt"
]);
var LAUNCH_FLAGS = Object.keys(ALLOWED);
function parseLaunchFlags(value) {
  if (value === void 0) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw invalid("_meta.piAcp.launch must be an array of strings");
  }
  const args = value;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (ADAPTER_OWNED.has(flag)) {
      throw invalid(`_meta.piAcp.launch: ${flag} is owned by pi-acp`);
    }
    const takesValue = ALLOWED[flag];
    if (takesValue === void 0) {
      throw invalid(`_meta.piAcp.launch: ${flag} is not an allowed pi flag`);
    }
    if (takesValue) {
      const next = args[i + 1];
      if (next === void 0 || next.length === 0) {
        throw invalid(`_meta.piAcp.launch: ${flag} needs a value`);
      }
      i++;
    }
  }
  return [...args];
}
function parseSystemPrompt(value) {
  if (value === void 0 || value === null) return void 0;
  if (typeof value === "string" && value.trim().length > 0) return { mode: "replace", text: value };
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [mode, text2] = entries[0];
      if ((mode === "append" || mode === "replace") && typeof text2 === "string" && text2.trim().length > 0) {
        return { mode, text: text2 };
      }
    }
  }
  throw invalid(
    "_meta.systemPrompt must be a nonempty string or an object with exactly one nonempty append or replace string"
  );
}
function parseLaunchOptions(meta) {
  const record = isRecord(meta) ? meta : {};
  const piAcp = isRecord(record.piAcp) ? record.piAcp : {};
  const systemPrompt = parseSystemPrompt(record.systemPrompt);
  return {
    args: parseLaunchFlags(piAcp.launch),
    ...systemPrompt ? { systemPrompt } : {},
    headless: piAcp.headless === true
  };
}
function launchCapabilities() {
  return {
    launch: { flags: LAUNCH_FLAGS },
    systemPrompt: { modes: ["append", "replace"] },
    headless: true
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/acp/pi-commands.ts
function describeFallback(c) {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";
  const parts = [];
  if (source) parts.push(source);
  if (location) parts.push(location);
  return parts.length ? `(${parts.join(":")})` : "(command)";
}
function toAvailableCommandsFromPiGetCommands(data, opts) {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? true;
  const root = data;
  const commandsRaw = Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : [];
  const out = [];
  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const source = typeof c?.source === "string" ? c.source : "";
    if (!includeExtensionCommands && source === "extension") continue;
    if (!enableSkillCommands && name.startsWith("skill:")) continue;
    const desc = typeof c?.description === "string" ? c.description.trim() : "";
    out.push({
      name,
      description: desc || describeFallback(c)
    });
  }
  return { commands: out, raw: commandsRaw };
}

// src/acp/agent.ts
import { isAbsolute as isAbsolute3 } from "path";
import { existsSync as existsSync5, readFileSync as readFileSync5, realpathSync, readdirSync as readdirSync3, statSync as statSync2, unlinkSync as unlinkSync2 } from "fs";
import { join as join6, dirname, basename } from "path";
import { spawnSync } from "child_process";
import { isDeepStrictEqual } from "util";
import { fileURLToPath as fileURLToPath2 } from "url";
var MODEL_CONFIG_ID = "model";
var THOUGHT_LEVEL_CONFIG_ID = "thought_level";
function builtinAvailableCommands() {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" }
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" }
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd"
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)"
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" }
    },
    {
      name: "steering",
      description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "follow-up",
      description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "changelog",
      description: "Show pi changelog"
    }
  ];
}
function mergeCommands(a, b) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of [...b, ...a]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
var pkg = readNearestPackageJson(import.meta.url);
function warnAdditionalDirectories(method, dirs) {
  if (Array.isArray(dirs) && dirs.length > 0) {
    process.stderr.write(`[pi-acp] ${method}: additionalDirectories is not supported by pi; ignoring ${dirs.length} path(s)
`);
  }
}
function respawnEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === void 0 || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
var PiAcpAgent = class {
  conn;
  sessions = new SessionManager();
  /** cwd per session id, kept for the adapter's lifetime: pi's session file is derived from id + cwd. */
  cwds = /* @__PURE__ */ new Map();
  clientCapabilities = {};
  restoringSessions = /* @__PURE__ */ new Map();
  /**
   * Launch options per session id, kept for the adapter's lifetime so a respawn after a
   * pi crash relaunches with the same flags and system prompt.
   */
  launches = /* @__PURE__ */ new Map();
  /**
   * Respawn guard for on-demand recovery (codex AppServerRecovery pattern): a stored
   * session whose pi process keeps dying must not be respawned without bound. Each
   * on-demand restore (a request for a session that has no live process; `session/load`
   * and `session/resume` restore by the client's own choice and do not count) acquires
   * a per-session slot; strikes are isolated per session so
   * one bad session cannot lock out others. Tunable via PI_ACP_RESPAWN_* env vars.
   */
  respawnAttempts = /* @__PURE__ */ new Map();
  // Env overrides are read per attempt (not at class-definition time) so operators
  // and tests can tune them after module load.
  get respawnWindowMs() {
    return respawnEnvInt("PI_ACP_RESPAWN_WINDOW_MS", 10 * 60 * 1e3);
  }
  get respawnMaxAttempts() {
    return respawnEnvInt("PI_ACP_RESPAWN_MAX_ATTEMPTS", 3);
  }
  /**
   * Records a restore attempt, refusing spawns beyond the per-session budget.
   * Synchronous by design: the common path must not add microtasks before the
   * spawn call. No sleep-based backoff: fast consecutive restores are legitimate
   * (client reloads, test flows), and the budget cap already bounds a crash loop.
   */
  tryAcquireRespawnSlot(sessionId) {
    const now = Date.now();
    const windowStart = now - this.respawnWindowMs;
    const attempts = (this.respawnAttempts.get(sessionId) ?? []).filter((ts) => ts >= windowStart);
    if (attempts.length >= this.respawnMaxAttempts) {
      const message = `pi respawn budget exhausted for session ${sessionId}: ${attempts.length} restore attempts within ${Math.round(this.respawnWindowMs / 1e3)}s; refusing another respawn until the window clears`;
      process.stderr.write(`[pi-acp] ${message}
`);
      throw RequestError4.internalError({ reason: "respawn_budget_exhausted" }, message);
    }
    attempts.push(now);
    this.respawnAttempts.set(sessionId, attempts);
  }
  dispose() {
    this.sessions.disposeAll();
  }
  // Remember recent session cwd and use it as the default filter.
  lastSessionCwd = null;
  constructor(conn, _config) {
    this.conn = conn;
    void _config;
  }
  cleanupFailedNewSession(sessionId, state) {
    this.sessions.close(sessionId);
    const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile : this.locateSessionFile(sessionId, this.cwds.get(sessionId));
    if (typeof sessionFile === "string" && sessionFile.trim()) {
      try {
        if (existsSync5(sessionFile)) unlinkSync2(sessionFile);
      } catch {
      }
    }
    this.cwds.delete(sessionId);
  }
  locateSessionFile(sessionId, cwd) {
    return cwd ? findPiSessionFile(getPiSessionDirForCwd(cwd), sessionId) : null;
  }
  /** The session's file, or an error naming the id and the directory searched. */
  requireSessionFile(sessionId, cwd) {
    const file = this.locateSessionFile(sessionId, cwd);
    if (file) return file;
    const dir = getPiSessionDirForCwd(cwd);
    throw RequestError4.invalidParams({ sessionId, dir }, `No pi session file for session ${sessionId} in ${dir}`);
  }
  async restoreSession(sessionId, opts) {
    if (opts?.launch) this.launches.set(sessionId, opts.launch);
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) return existing;
    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) return inFlight;
    const restorePromise = (async () => {
      const cwd = opts?.cwd ?? this.cwds.get(sessionId);
      if (!cwd) throw RequestError4.invalidParams(`Unknown sessionId: ${sessionId}`);
      const sessionFile = this.requireSessionFile(sessionId, cwd);
      if (!opts?.cwd) this.tryAcquireRespawnSlot(sessionId);
      const mcpInjection = opts?.mcpServers?.length ? prepareMcpInjection(opts.mcpServers) : null;
      let proc;
      try {
        const launch = this.launches.get(sessionId);
        proc = await PiRpcProcess.spawn({
          cwd,
          sessionPath: sessionFile,
          piCommand: process.env.PI_ACP_PI_COMMAND,
          ...mcpInjection ? { mcpInjection } : {},
          ...launch?.args.length ? { launchArgs: launch.args } : {},
          ...launch?.systemPrompt ? { systemPrompt: launch.systemPrompt } : {}
        });
      } catch (e) {
        mcpInjection?.cleanup();
        if (e?.name === "PiRpcSpawnError") {
          throw RequestError4.internalError({ code: e?.code }, String(e?.message ?? e));
        }
        throw e;
      }
      const fileCommands = loadSlashCommands(cwd);
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands,
        mcpInjection,
        clientCapabilities: this.clientCapabilities,
        ...this.launches.has(sessionId) ? { launch: this.launches.get(sessionId) } : {}
      });
      try {
        this.lastSessionCwd = cwd;
        this.cwds.set(sessionId, cwd);
        const title = readPiSessionTitle(sessionFile);
        if (title) await session.publishTitle(title, null);
        return session;
      } catch (err) {
        this.sessions.close(sessionId);
        throw err;
      }
    })();
    this.restoringSessions.set(sessionId, restorePromise);
    try {
      return await restorePromise;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }
  async initialize(params) {
    this.clientCapabilities = params.clientCapabilities ?? {};
    const supportedVersion = PROTOCOL_VERSION;
    const requested = params.protocolVersion;
    const response = {
      _meta: { steering: { supported: true } },
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0"
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuth: this.clientCapabilities.auth?.terminal === true,
        supportsTerminalAuthMeta: this.clientCapabilities._meta?.["terminal-auth"] === true
      }),
      agentCapabilities: {
        loadSession: true,
        // pi connects streamable-HTTP MCP entries natively; SSE entries are skipped
        // in mcp-descriptor.ts, so the capability claim stays honest.
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true"
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {},
          resume: {},
          close: {},
          // **UNSTABLE** Fork branches the stored pi session file into a new
          // session via pi's native `--fork`.
          fork: {}
        },
        _meta: {
          // Per-session launch options this adapter reads from request _meta (see acp/launch.ts).
          piAcp: launchCapabilities(),
          // UNSTABLE claude-agent-acp contract. Auth discovery can read either this
          // marker or the _auth/status_update push below; both need a complete
          // kind/label identity, since an empty marker can stall model discovery.
          authStatus: {
            kind: "api_key",
            label: "pi",
            detail: "provider credentials managed by pi"
          }
        }
      }
    };
    setTimeout(() => {
      void this.conn.extNotification?.("_auth/status_update", {
        authStatus: {
          kind: "api_key",
          label: "pi",
          detail: "provider credentials managed by pi"
        }
      })?.catch(() => {
      });
    }, 0);
    return response;
  }
  async newSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    warnAdditionalDirectories("session/new", params.additionalDirectories);
    const launch = parseLaunchOptions(params._meta);
    this.lastSessionCwd = params.cwd;
    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND,
      clientCapabilities: this.clientCapabilities,
      launch
    });
    this.launches.set(session.sessionId, launch);
    this.cwds.set(session.sessionId, params.cwd);
    let state = null;
    let availableModels = null;
    let stateErr = null;
    let availableModelsErr = null;
    await Promise.all([
      session.proc.getState().then((s) => {
        state = s;
      }).catch((err) => {
        stateErr = err;
        state = null;
      }),
      session.proc.getAvailableModels().then((m) => {
        availableModels = m;
      }).catch((err) => {
        availableModelsErr = err;
        availableModels = null;
      })
    ]);
    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr, this.clientCapabilities);
    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }
    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.internalError({}, String(availableModelsErr?.message ?? availableModelsErr));
    }
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0;
    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.authRequired(
        {
          authMethods: getAuthMethods({
            supportsTerminalAuth: this.clientCapabilities.auth?.terminal === true,
            supportsTerminalAuthMeta: this.clientCapabilities._meta?.["terminal-auth"] === true
          })
        },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    if (stateErr && maybeAuthRequiredError(stateErr, this.clientCapabilities)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError4.authRequired(
        {
          authMethods: getAuthMethods({
            supportsTerminalAuth: this.clientCapabilities.auth?.terminal === true,
            supportsTerminalAuthMeta: this.clientCapabilities._meta?.["terminal-auth"] === true
          })
        },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    let configuration;
    try {
      if (stateErr) throw stateErr;
      configuration = await getSessionConfiguration(session.proc, { state, availableModels });
    } catch (err) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw maybeAuthRequiredError(err, this.clientCapabilities) ?? RequestError4.internalError({}, String(err?.message ?? err));
    }
    const { configOptions, models, modes } = configuration;
    const quietStartup = launch.headless || getQuietStartup(params.cwd);
    const updateNotice = launch.headless ? null : buildUpdateNotice();
    let preludeText = quietStartup ? updateNotice ? updateNotice + "\n" : "" : buildStartupInfo({
      cwd: params.cwd,
      fileCommands,
      updateNotice
    });
    const mcpSection = launch.headless ? null : buildMcpStartupSection(session.mcpInjection);
    if (mcpSection) preludeText = preludeText ? `${preludeText}${mcpSection}` : mcpSection;
    if (preludeText) session.setStartupInfo(preludeText);
    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    };
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);
    setTimeout(() => {
      void (async () => {
        await session.publishContextUsage();
        try {
          const pi = await session.proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  /**
   * Some clients query providers during initialization before creating a session.
   * Pi owns provider configuration, so return an empty catalog rather than a missing-method error.
   */
  async unstable_listProviders(_params) {
    return { providers: [] };
  }
  async authenticate(_params) {
    return;
  }
  async prompt(params, signal) {
    if (signal?.aborted) return { stopReason: "cancelled" };
    try {
      const response = await this.runPrompt(params, signal);
      return signal?.aborted ? { stopReason: "cancelled" } : response;
    } catch (error) {
      if (signal?.aborted) {
        return { stopReason: "cancelled" };
      }
      throw error;
    }
  }
  async runPrompt(params, signal) {
    const session = await this.restoreSession(params.sessionId);
    if (signal?.aborted) return { stopReason: "cancelled" };
    const { message, images } = promptToPiMessage(params.prompt);
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || void 0;
        const compact = await session.compact(customInstructions, signal);
        if (compact.cancelled) return { stopReason: "cancelled" };
        const res = compact.result;
        if (this.clientCapabilities.session?.compaction != null) return { stopReason: "end_turn" };
        const r = res && typeof res === "object" ? res : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;
        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean);
        const text2 = headerLines.join("\n") + (summary ? `

${summary}` : "");
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text2 }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "session") {
        const stats = await session.proc.getSessionStats();
        const lines = [];
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (typeof stats?.totalMessages === "number") lines.push(`Messages: ${stats.totalMessages}`);
        if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);
        const t = stats?.tokens;
        if (t && typeof t === "object") {
          const parts = [];
          if (typeof t.input === "number") parts.push(`in ${t.input}`);
          if (typeof t.output === "number") parts.push(`out ${t.output}`);
          if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
          if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
          if (typeof t.total === "number") parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }
        const text2 = lines.length ? lines.join("\n") : `Session stats:
${JSON.stringify(stats, null, 2)}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text2 }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          await session.setSessionName(name);
        } catch (e) {
          const msg = String(e?.message ?? e);
          const hint = /set_session_name/i.test(msg) ? " This requires a newer pi version that supports `set_session_name` in RPC mode." : "";
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.steeringMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setSteeringMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.followUpMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setFollowUpMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "changelog") {
        const findChangelog = () => {
          try {
            const whichCmd = process.platform === "win32" ? "where" : "which";
            const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
            const piPath = String(which.stdout ?? "").split(/\r?\n/)[0]?.trim();
            if (piPath) {
              const resolved = realpathSync(piPath);
              const pkgRoot = dirname(dirname(resolved));
              const p = join6(pkgRoot, "CHANGELOG.md");
              if (existsSync5(p)) return p;
            }
          } catch {
          }
          try {
            const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
            const root = String(npmRoot.stdout ?? "").trim();
            if (root) {
              const p = join6(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
              if (existsSync5(p)) return p;
            }
          } catch {
          }
          return null;
        };
        const changelogPath = findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Changelog not found (couldn't locate pi installation)." }
            }
          });
          return { stopReason: "end_turn" };
        }
        let text2 = "";
        try {
          text2 = readFileSync5(changelogPath, "utf-8");
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        const maxChars = 2e4;
        if (text2.length > maxChars) text2 = text2.slice(0, maxChars) + "\n\n...(truncated)...";
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: text2 }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "export") {
        const state = await session.proc.getState();
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
        const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;
        if (!sessionFile || messageCount === 0 || !existsSync5(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          const raw = readFileSync5(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first."
                }
              }
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join6(session.cwd, `pi-session-${safeSessionId}.html`);
        let resultPath = "";
        try {
          const result2 = await session.proc.exportHtml(outputPath);
          resultPath = result2.path;
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const uri = `file://${resultPath}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: "
            }
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported"
            }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") enabled = false;
        if (enabled === null) {
          const state = await session.proc.getState();
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }
        await session.proc.setAutoCompaction(enabled);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
            }
          }
        });
        return { stopReason: "end_turn" };
      }
    }
    const usageOut = {};
    const result = await session.prompt(
      message,
      images,
      promptToSessionTitle(params.prompt) ?? void 0,
      signal,
      usageOut
    );
    if (result === "error" && !session.wasCancelRequested()) {
      const reason = usageOut.error ?? "Pi prompt failed";
      throw RequestError4.internalError({ reason }, reason);
    }
    const stopReason = result === "error" ? "cancelled" : result;
    return {
      stopReason,
      ...usageOut.usage ? { usage: usageOut.usage } : {},
      ...usageOut.summary ? { _meta: { piAcp: usageOut.summary } } : {}
    };
  }
  async steer(params) {
    const value = params;
    if (!value || typeof value.sessionId !== "string" || !Array.isArray(value.prompt) || !value.prompt.length || value.prompt.some(
      (block) => !block || block.type !== "text" || typeof block.text !== "string" || !block.text.trim()
    ) || value._meta?.steering?.idleBehavior !== void 0 && value._meta.steering.idleBehavior !== "promptRequired") {
      throw RequestError4.invalidParams("Steering requires non-empty text prompt and idleBehavior promptRequired");
    }
    const session = this.sessions.maybeGet(value.sessionId);
    if (!session) throw RequestError4.invalidParams("Unknown session");
    return session.steer(value.prompt.map((block) => block.text).join("\n"));
  }
  async cancel(params) {
    const session = this.sessions.maybeGet(params.sessionId);
    if (!session) return;
    await session.cancel();
  }
  async listSessions(params) {
    const all = listPiSessions();
    const effectiveCwd = params.cwd ?? this.lastSessionCwd;
    const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }));
    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return { sessions, nextCursor, _meta: {} };
  }
  async loadSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    warnAdditionalDirectories("session/load", params.additionalDirectories);
    const launch = parseLaunchOptions(params._meta);
    this.sessions.close(params.sessionId);
    this.lastSessionCwd = params.cwd;
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      launch
    });
    const proc = session.proc;
    let configuration;
    try {
      configuration = await getSessionConfiguration(proc);
    } catch (err) {
      this.sessions.close(session.sessionId);
      throw err;
    }
    const { configOptions, models, modes } = configuration;
    const fileCommands = loadSlashCommands(params.cwd);
    const data = await proc.getMessages();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    session.seedMessageIds([]);
    for (const m of messages) {
      const role = String(m?.role ?? "");
      if (role === "user") {
        const messageId = session.messageIdForReplay(m);
        const text2 = normalizePiMessageText(m?.content);
        if (text2) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              messageId,
              content: { type: "text", text: text2 }
            }
          });
        }
      }
      if (role === "assistant") {
        const messageId = session.messageIdForReplay(m);
        const thinking = normalizePiThoughtText(m?.content);
        if (thinking) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: `${messageId}:thought`,
              content: { type: "text", text: thinking }
            }
          });
        }
        const text2 = normalizePiAssistantText(m?.content);
        if (text2) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId,
              content: { type: "text", text: text2 }
            }
          });
        }
      }
      if (role === "toolResult") {
        const toolName = String(m?.toolName ?? "tool");
        const toolCallId = String(m?.toolCallId ?? crypto.randomUUID());
        const isError = Boolean(m?.isError);
        const isBash = isBashTool(toolName);
        if (isBash) {
          const text2 = bashResultText(m);
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: bashCommand(m) ?? toolName,
              name: toolName,
              kind: "execute",
              status: isError ? "failed" : "completed",
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: isError ? "failed" : "completed",
              rawOutput: m,
              _meta: {
                ...text2 ? bashTerminalOutputMeta(toolCallId, text2) : {},
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          });
          continue;
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            name: toolName,
            kind: toToolKind(toolName),
            status: isError ? "failed" : "completed",
            rawInput: null,
            rawOutput: m
          }
        });
        const content = session.richToolContent(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: content.length ? content : null,
            rawOutput: m
          }
        });
      }
    }
    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    };
    setTimeout(() => {
      void (async () => {
        await session.publishContextUsage();
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: true
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async forkSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    warnAdditionalDirectories("session/fork", params.additionalDirectories);
    const sourceFile = this.requireSessionFile(params.sessionId, this.cwds.get(params.sessionId) ?? params.cwd);
    const mcpInjection = params.mcpServers?.length ? prepareMcpInjection(params.mcpServers) : null;
    let proc;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        forkSessionPath: sourceFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        ...mcpInjection ? { mcpInjection } : {}
      });
    } catch (e) {
      mcpInjection?.cleanup();
      if (e?.name === "PiRpcSpawnError") {
        throw RequestError4.internalError({ code: e?.code }, String(e?.message ?? e));
      }
      throw e;
    }
    let state = null;
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
    const fileCommands = loadSlashCommands(params.cwd);
    this.sessions.getOrCreate(sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      conn: this.conn,
      proc,
      fileCommands,
      mcpInjection,
      clientCapabilities: this.clientCapabilities
    });
    try {
      this.lastSessionCwd = params.cwd;
      this.cwds.set(sessionId, params.cwd);
      const { configOptions, modes } = await getSessionConfiguration(proc);
      return { sessionId, modes, configOptions };
    } catch (err) {
      this.sessions.close(sessionId);
      throw err;
    }
  }
  async resumeSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError4.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    const launch = parseLaunchOptions(params._meta);
    const existing = this.sessions.maybeGet(params.sessionId);
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      launch
    });
    if (session.cwd !== params.cwd || !isDeepStrictEqual(session.mcpServers, params.mcpServers ?? [])) {
      throw RequestError4.invalidParams("Close the session before resuming with a different cwd or MCP servers");
    }
    try {
      const { configOptions, modes } = await getSessionConfiguration(session.proc);
      if (!existing) {
        const data = await session.proc.getMessages();
        const messages = data && typeof data === "object" && "messages" in data ? data.messages : void 0;
        session.seedMessageIds(Array.isArray(messages) ? messages : []);
      }
      this.lastSessionCwd = session.cwd;
      return { configOptions, modes };
    } catch (err) {
      if (!existing) this.sessions.close(session.sessionId);
      throw err;
    }
  }
  async closeSession(params) {
    await this.restoringSessions.get(params.sessionId)?.catch(() => {
    });
    this.sessions.close(params.sessionId);
    return {};
  }
  async deleteSession(params) {
    await this.closeSession(params);
    const sessionFile = this.locateSessionFile(params.sessionId, this.cwds.get(params.sessionId)) ?? listPiSessions().find((s) => s.sessionId === params.sessionId)?.sessionFile;
    if (sessionFile) {
      try {
        unlinkSync2(sessionFile);
      } catch (err) {
        if (err.code !== "ENOENT") {
          throw RequestError4.internalError({}, `Failed to delete session: ${String(err)}`);
        }
      }
    }
    this.cwds.delete(params.sessionId);
    return {};
  }
  async setSessionMode(params) {
    const session = await this.restoreSession(params.sessionId);
    const mode = params.modeId;
    if (typeof mode !== "string" || mode.length === 0) {
      throw RequestError4.invalidParams("Expected nonempty string modeId");
    }
    await session.proc.setThinkingLevel(mode);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return {};
  }
  async setSessionConfigOption(params) {
    const session = await this.restoreSession(params.sessionId);
    const configId = String(params.configId);
    let modelChanged = false;
    if (typeof params.value !== "string") {
      throw RequestError4.invalidParams(`Expected string value for config option: ${configId}`);
    }
    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
      modelChanged = true;
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (params.value.length === 0) {
        throw RequestError4.invalidParams("Expected nonempty thinking level");
      }
      await session.proc.setThinkingLevel(params.value);
    } else {
      throw RequestError4.invalidParams(`Unknown config option: ${configId}`);
    }
    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    if (modelChanged) await session.publishContextUsage();
    return { configOptions };
  }
};
async function getThinkingState(proc, pre) {
  const state = pre?.state ?? await proc.getState();
  const available = await proc.getAvailableThinkingLevels();
  const current = state && typeof state === "object" && "thinkingLevel" in state ? state.thinkingLevel : void 0;
  if (typeof current !== "string" || current.length === 0 || !available.includes(current)) {
    throw new Error("pi returned a thinking level absent from available levels");
  }
  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  };
}
async function getSessionConfiguration(proc, pre) {
  const state = pre?.state ?? await proc.getState();
  const [models, modes] = await Promise.all([getModelState(proc, { ...pre, state }), getThinkingState(proc, { state })]);
  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  };
}
function buildConfigOptions(state) {
  const configOptions = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ];
  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    });
  }
  return configOptions;
}
async function getModelState(proc, pre) {
  let availableModels = [];
  const data = pre?.availableModels ?? await (async () => {
    try {
      return await proc.getAvailableModels();
    } catch {
      return null;
    }
  })();
  const models = Array.isArray(data?.models) ? data.models : [];
  availableModels = models.map((m) => {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return null;
    const rawName = String(m?.name ?? "").trim();
    const modelId = `${provider}/${id}`;
    const name = rawName && rawName !== id ? `${provider}/${rawName}` : `${provider} ${id}`;
    return {
      modelId,
      name,
      description: null
    };
  }).filter(Boolean);
  let currentModelId = null;
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }
  if (!availableModels.length && !currentModelId) return null;
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";
  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default"
  };
}
async function emitConfigOptionsUpdate(conn, sessionId, proc) {
  const { configOptions, modes } = await getSessionConfiguration(proc);
  await conn.sessionUpdate({
    sessionId,
    update: { sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId }
  });
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions
    }
  });
  return configOptions;
}
async function setSessionModel(proc, requestedModelId) {
  let provider = null;
  let modelId = null;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const data = await proc.getAvailableModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    const found = models.find((m) => String(m?.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }
  if (!provider || !modelId) {
    throw RequestError4.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
}
function isSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}
function compareSemver(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function buildMcpStartupSection(plan) {
  if (!plan || !plan.serverNames.length && !plan.warnings.length) return "";
  const lines = ["## MCP", ""];
  if (plan.serverNames.length) {
    lines.push(`- Injected ${plan.serverNames.length} client server(s): ${plan.serverNames.join(", ")}`);
  }
  for (const warning of plan.warnings) lines.push(`- ${warning}`);
  lines.push("");
  return lines.join("\n");
}
function buildUpdateNotice() {
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (!installed || !isSemver(installed)) return null;
    const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
      encoding: "utf-8",
      timeout: 800
    });
    const latest = String(latestRes.stdout ?? "").trim().replace(/^v/i, "");
    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}
function buildStartupInfo(opts) {
  void opts.fileCommands;
  const md = [];
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
  }
  const addSection = (title, items) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;
    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };
  const contextItems = [];
  const contextPath = join6(opts.cwd, "AGENTS.md");
  if (existsSync5(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);
  const skillsItems = [];
  const pushSkillFromRoot = (root) => {
    try {
      for (const e of readdirSync3(root)) {
        const p = join6(root, e);
        try {
          const st = statSync2(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
        }
      }
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = readdirSync3(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name === "node_modules" || name === ".git") continue;
          const p = join6(dir, name);
          let st;
          try {
            st = statSync2(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
    }
  };
  const globalSkillsDir = join6(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);
  const legacyAgentsSkillsDir = join6(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);
  const projectSkillsDir = join6(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);
  addSection("Skills", skillsItems);
  const promptsItems = [];
  const promptsDir = join6(process.env.HOME ?? "", ".pi", "agent", "prompts");
  try {
    const prompts = readdirSync3(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
  }
  addSection("Prompts", promptsItems);
  const extItems = [];
  const extDir = join6(process.env.HOME ?? "", ".pi", "agent", "extensions");
  try {
    const exts = readdirSync3(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join6(extDir, f));
  } catch {
  }
  const settingsPaths = [join6(getAgentDir(), "settings.json"), join6(opts.cwd, ".pi", "settings.json")];
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync5(settingsPath, "utf-8"));
      const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
      for (const pkg2 of pkgs) {
        const s = String(pkg2);
        if (s.startsWith("npm:")) {
          extItems.push(`${s}
  - index.ts`);
        } else {
          extItems.push(s);
        }
      }
    } catch {
    }
  }
  addSection("Extensions", extItems);
  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }
  return md.join("\n").trim() + "\n";
}
function readNearestPackageJson(metaUrl) {
  try {
    let dir = dirname(fileURLToPath2(metaUrl));
    for (let i = 0; i < 6; i++) {
      const p = join6(dir, "package.json");
      if (existsSync5(p)) {
        const json = JSON.parse(readFileSync5(p, "utf-8"));
        return { name: json?.name, version: json?.version };
      }
      dir = dirname(dir);
    }
  } catch {
  }
  return { name: "pi-acp", version: "0.0.0" };
}

// src/acp/connection.ts
function connectPiAgent(stream2) {
  let implementation;
  const app = agentApp().onConnect(({ client, signal }) => {
    implementation = new PiAcpAgent({
      signal,
      sessionUpdate: (params) => client.notify("session/update", params),
      requestPermission: (params) => client.request("session/request_permission", params),
      createElicitation: (params) => client.request("elicitation/create", params),
      extNotification: (method, params) => client.notify(method, params)
    });
  }).onRequest("initialize", (ctx) => implementation.initialize(ctx.params)).onRequest("authenticate", (ctx) => implementation.authenticate(ctx.params)).onRequest("providers/list", (ctx) => implementation.unstable_listProviders(ctx.params)).onRequest("session/new", (ctx) => implementation.newSession(ctx.params)).onRequest("session/load", (ctx) => implementation.loadSession(ctx.params)).onRequest("session/resume", (ctx) => implementation.resumeSession(ctx.params)).onRequest("session/close", (ctx) => implementation.closeSession(ctx.params)).onRequest("session/list", (ctx) => implementation.listSessions(ctx.params)).onRequest("session/delete", (ctx) => implementation.deleteSession(ctx.params)).onRequest("session/fork", (ctx) => implementation.forkSession(ctx.params)).onRequest("session/set_mode", (ctx) => implementation.setSessionMode(ctx.params)).onRequest("session/set_config_option", (ctx) => implementation.setSessionConfigOption(ctx.params)).onRequest("session/prompt", (ctx) => implementation.prompt(ctx.params, ctx.signal)).onRequest("_session/steering", { parse: (params) => params }, (ctx) => implementation.steer(ctx.params)).onNotification("session/cancel", (ctx) => implementation.cancel(ctx.params));
  const connection = app.connect(stream2);
  return { agent: implementation, connection };
}

// src/index.ts
if (process.argv.includes("--terminal-login")) {
  const { spawnSync: spawnSync2 } = await import("child_process");
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND);
  const res = spawnSync2(cmd, [], {
    stdio: "inherit",
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  });
  if (res.error && res.error.code === "ENOENT") {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.
`
    );
    process.exit(1);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}
var input = new WritableStream({
  write(chunk) {
    return new Promise((resolve4) => {
      if (process.stdout.destroyed || !process.stdout.writable) return resolve4();
      try {
        process.stdout.write(chunk, (err) => {
          void err;
          resolve4();
        });
      } catch {
        resolve4();
      }
    });
  }
});
var output = new ReadableStream({
  start(controller) {
    process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  }
});
var stream = ndJsonStream(input, output);
var agent = null;
agent = connectPiAgent(stream).agent;
var shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    agent?.dispose();
  } catch {
  }
  try {
    process.exit(0);
  } catch {
  }
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("error", shutdown);
//# sourceMappingURL=index.js.map