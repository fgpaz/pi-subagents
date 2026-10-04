import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runExtension(botRole?: string): { registrations: string[]; timers: number[]; watchers: string[]; resultReads: string[] } {
  const env = { ...process.env };
  delete env.PI_SUBAGENT_CHILD;
  delete env.PI_SUBAGENTS_HERDR_BRIDGE;
  if (botRole === undefined) delete env.BOT_ROLE;
  else env.BOT_ROLE = botRole;
  const script = String.raw`
    import fs from "node:fs";
    import fsPromises from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    const timers = [];
    const watchers = [];
    const resultReads = [];
    const registrations = [];
    const recordPath = (kind, value) => {
      const target = String(value ?? "");
      if (target.includes("async-subagent-results")) resultReads.push(kind + ":" + target);
    };
    for (const [owner, methods] of [
      [fs, ["readdir", "readdirSync", "readFile", "readFileSync", "watch", "watchFile"]],
      [fs.promises, ["readdir", "readFile"]],
      [fsPromises, ["readdir", "readFile"]],
    ]) {
      for (const name of methods) {
        const original = owner[name];
        if (typeof original !== "function") continue;
        owner[name] = function (...args) {
          if (name === "watch" || name === "watchFile") {
            watchers.push(name + ":" + String(args[0] ?? ""));
            return { close() {} };
          }
          recordPath(name, args[0]);
          return original.apply(this, args);
        };
      }
    }
    syncBuiltinESMExports();
    const originalTimeout = globalThis.setTimeout;
    const originalInterval = globalThis.setInterval;
    globalThis.setTimeout = (callback, delay, ...args) => {
      timers.push(Number(delay));
      const handle = originalTimeout(callback, delay, ...args);
      handle?.unref?.();
      return handle;
    };
    globalThis.setInterval = (callback, delay, ...args) => {
      timers.push(Number(delay));
      const handle = originalInterval(callback, delay, ...args);
      handle?.unref?.();
      return handle;
    };
    const record = (name) => (...args) => {
      const value = args[0];
      registrations.push(name + ":" + (typeof value === "object" ? value?.name ?? "" : value ?? ""));
      return () => {};
    };
    const pi = new Proxy({
      events: { on: record("events.on"), emit() {} },
      on: record("on"),
      registerTool: record("registerTool"),
      registerCommand: record("registerCommand"),
      registerShortcut: record("registerShortcut"),
      registerFlag: record("registerFlag"),
      registerMessageRenderer: record("registerMessageRenderer"),
      registerProvider: record("registerProvider"),
      registerMcpServer: record("registerMcpServer"),
      sendMessage() {},
      getSessionName() { return undefined; },
    }, { get(target, property) { return property in target ? target[property] : () => undefined; } });
    const { default: register } = await import("./index.ts");
    register(pi);
    process.stdout.write(JSON.stringify({ registrations, timers, watchers, resultReads }));
  `;
  return JSON.parse(execFileSync(process.execPath, [
    "--experimental-strip-types",
    "--import",
    "./test/support/register-loader.mjs",
    "--input-type=module",
    "--eval",
    script,
  ], { cwd: projectRoot, env, encoding: "utf8" }));
}

describe("executor bot disables the pi-subagents package entry", () => {
  it("registers nothing and starts no watcher/runner or async result reads for executor bots", () => {
    const executor = runExtension("ejecutor");
    assert.deepEqual(executor.registrations, []);
    assert.deepEqual(executor.timers, []);
    assert.deepEqual(executor.watchers, []);
    assert.deepEqual(executor.resultReads, []);
  });

  it("keeps the regular extension registration when BOT_ROLE is absent", () => {
    const ordinary = runExtension();
    assert.ok(ordinary.registrations.includes("registerTool:subagent"));
  });
});
