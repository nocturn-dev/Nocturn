import { describe, expect, it } from "vitest";
import { buildStepRows, classifyTool } from "./steps";
import type { Message } from "../types";

const assistant = (toolCalls: Message["toolCalls"], workedMs?: number): Message => ({
  id: "a1",
  role: "assistant",
  content: "",
  toolCalls,
  workedMs,
});

const toolMsg = (id: string, toolCallId: string, content: string, status?: Message["status"]): Message => ({
  id,
  role: "tool",
  content,
  toolCallId,
  status,
});

describe("classifyTool", () => {
  it("maps tools into step kinds", () => {
    expect(classifyTool("fs_write")).toBe("edit");
    expect(classifyTool("vault_write")).toBe("edit");
    expect(classifyTool("shell_run")).toBe("terminal");
    expect(classifyTool("ask_user")).toBe("asked");
    expect(classifyTool("fs_read")).toBe("explore");
    expect(classifyTool("mcp__srv__tool")).toBe("explore");
  });
});

describe("buildStepRows", () => {
  it("builds an Edit row with live diff stats from the write result", () => {
    const result = JSON.stringify({
      ok: true,
      path: "src/App.tsx",
      created: false,
      before: "a\nb\nc",
      after: "a\nX\nc\nd",
    });
    const rows = buildStepRows(
      [assistant([{ id: "tc1", name: "fs_write", arguments: '{"path":"src/App.tsx"}' }])],
      [toolMsg("t1", "tc1", result)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("edit");
    expect(rows[0]!.label).toBe("App.tsx");
    expect(rows[0]!.detail).toBe("src");
    expect(rows[0]!.stats).toEqual({ added: 2, removed: 1 });
  });

  it("marks a shell step failed on non-zero exit and keeps the output", () => {
    const rows = buildStepRows(
      [assistant([{ id: "tc1", name: "shell_run", arguments: '{"command":"node -e \\"process.exit(3)\\""}' }])],
      [toolMsg("t1", "tc1", "boom\nexit code: 3")],
    );
    expect(rows[0]!.kind).toBe("terminal");
    expect(rows[0]!.failed).toBe("exit");
    expect(rows[0]!.exitCode).toBe(3);
    expect(rows[0]!.output).toContain("boom");
  });

  it("skips subagent_run and reports denied status", () => {
    const rows = buildStepRows(
      [
        assistant([
          { id: "tc1", name: "subagent_run", arguments: "{}" },
          { id: "tc2", name: "fs_read", arguments: '{"path":"src/x.ts"}' },
        ]),
      ],
      [toolMsg("t2", "tc2", "file body", "denied")],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe("fs_read");
    expect(rows[0]!.failed).toBe("denied");
  });

  it("attaches the owner message workedMs as step seconds", () => {
    const rows = buildStepRows(
      [assistant([{ id: "tc1", name: "fs_list", arguments: '{"path":"."}' }], 6500)],
      [toolMsg("t1", "tc1", "type\tsize\tname\nfile\t1\ta.txt")],
    );
    expect(rows[0]!.secondsMs).toBe(6500);
    expect(rows[0]!.detail).toBe("1");
  });
});
