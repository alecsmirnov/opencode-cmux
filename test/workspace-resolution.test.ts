import { test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"

const sessionID = "ses_resolution_test_000000000000"

const workA = "11111111-1111-1111-1111-111111111111"
const workB = "22222222-2222-2222-2222-222222222222"

// Two workspaces share the session's directory; only B runs an OpenCode TUI.
const workspaces = {
  workspaces: [
    { id: workA, current_directory: "/proj" },
    { id: workB, current_directory: "/proj" },
  ],
}
const panelsA = { surfaces: [{ title: "/proj — zsh" }] }
const panelsB = { surfaces: [{ title: "OC | Fix the bug" }] }

beforeAll(() => {
  process.env.CMUX_WORKSPACE_ID = workA
  process.env.CMUX_SURFACE_ID = "surface:test"
  process.env.TMUX_PANE = ""
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "opencode-cmux-resolution-"))
})

// A recording shell that answers the workspace/panel queries with canned JSON.
function fakeShell(workspacesJSON: string, panels: Record<string, string>) {
  const calls: string[][] = []
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const argv: string[] = []
    strings.forEach((part, i) => {
      argv.push(...part.split(/\s+/).filter(Boolean))
      if (i < values.length) {
        const value = values[i]
        if (Array.isArray(value)) argv.push(...value.map(String))
        else argv.push(String(value))
      }
    })
    const command = argv.slice(1)
    calls.push(command)
    let stdout = ""
    if (command[0] === "list-workspaces") stdout = workspacesJSON
    if (command[0] === "list-panels") stdout = panels[command[2] ?? ""] ?? ""
    const out: any = {
      exitCode: 0,
      stdout,
      quiet: () => out,
      nothrow: () => out,
      text: async () => stdout,
      then: (onFulfilled: any, onRejected: any) =>
        Promise.resolve({ exitCode: 0, stdout }).then(onFulfilled, onRejected),
    }
    return out
  }
  return { $, calls }
}

function setup(resolution: "cwd" | "env") {
  const configDir = mkdtempSync(join(tmpdir(), "opencode-cmux-resolution-"))
  process.env.XDG_CONFIG_HOME = configDir
  require("node:fs").mkdirSync(join(configDir, "opencode"))
  require("node:fs").writeFileSync(
    join(configDir, "opencode", "opencode-cmux.json"),
    JSON.stringify({ resolution }),
  )
}

async function run(resolution: "cwd" | "env", events: { type: string; properties: any }[]) {
  setup(resolution)
  const { $, calls } = fakeShell(JSON.stringify(workspaces), {
    [workA]: JSON.stringify(panelsA),
    [workB]: JSON.stringify(panelsB),
  })
  const client = {
    session: {
      get: async () => ({
        data: {
          id: sessionID,
          title: "Titolo di prova",
          location: { directory: "/proj/session-dir" },
        },
      }),
    },
  }
  const hooks = await (plugin as any).server({ client, $ })
  for (const event of events) await hooks.event({ event })
  return calls
}

const idle = { type: "session.status", properties: { sessionID, status: { type: "idle" } } }
const busy = { type: "session.status", properties: { sessionID, status: { type: "busy" } } }
const permission = {
  type: "permission.asked",
  properties: { id: "perm1", sessionID, permission: "bash", patterns: ["ls"] },
}
const permissionReply = {
  type: "permission.replied",
  properties: { id: "perm1", sessionID },
}

test("cwd resolution targets the workspace running the OpenCode TUI", async () => {
  const calls = await run("cwd", [idle])
  const notification = calls
    .filter((c) => c[1] === "notification.create")
    .map((c) => JSON.parse(c[2]!))[0]
  expect(notification.workspace_id).toBe(workB)
  // A resolved workspace's pane lives in another tab: do not pin the surface.
  expect(notification.surface_id).toBeUndefined()
  const status = calls.find((c) => c[0] === "set-status")!
  expect(status).toContain("--workspace")
  expect(status[status.indexOf("--workspace") + 1]).toBe(workB)
})

test("env resolution keeps the environment workspace and pins the surface", async () => {
  const calls = await run("env", [idle])
  const notification = calls
    .filter((c) => c[1] === "notification.create")
    .map((c) => JSON.parse(c[2]!))[0]
  expect(notification.workspace_id).toBe(workA)
  expect(notification.surface_id).toBe("surface:test")
  const status = calls.find((c) => c[0] === "set-status")!
  expect(status).not.toContain("--workspace")
})

test("cwd resolution reuses the resolved workspace for the reply path", async () => {
  const calls = await run("cwd", [busy, permission, permissionReply, idle])
  const notification = calls
    .filter((c) => c[1] === "notification.create")
    .map((c) => JSON.parse(c[2]!))[0]
  // permission.asked fires "Needs your permission" addressed to workB.
  expect(notification.workspace_id).toBe(workB)
  const idleStatus = calls.filter((c) => c[0] === "set-status").at(-1)!
  expect(idleStatus).toContain("--workspace")
  expect(idleStatus[idleStatus.indexOf("--workspace") + 1]).toBe(workB)
})

test("sessions outside every workspace are skipped instead of ringing the wrong tab", async () => {
  const { $, calls } = fakeShell(JSON.stringify(workspaces), {
    [workA]: JSON.stringify(panelsA),
    [workB]: JSON.stringify(panelsB),
  })
  setup("cwd")
  const client = {
    session: {
      get: async () => ({
        data: {
          id: sessionID,
          title: "Titolo di prova",
          // Matches no open workspace (e.g. a temp directory).
          location: { directory: "/var/tmp/not-a-workspace" },
        },
      }),
    },
  }
  const hooks = await (plugin as any).server({ client, $ })
  await hooks.event({ event: idle })
  expect(calls.filter((c) => c[1] === "notification.create")).toEqual([])
  expect(calls.filter((c) => c[0] === "set-status")).toEqual([])
})
