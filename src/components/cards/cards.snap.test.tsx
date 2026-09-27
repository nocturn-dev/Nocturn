// @vitest-environment jsdom
// Снапшот-щит карточек чата: ломались и от регрессий вёрстки, и от
// нечаянных смен классов. Правки UI, меняющие снапшот, обновляются
// осознанно: vitest -u, а дифф ревьюится глазами.
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { LangProvider } from "../../locales";
import type { Message, ToolCallInfo } from "../../types";
import { ToolStepCard } from "./ToolStepCard";
import { UserCard } from "./UserCard";
import { AssistantCard } from "./AssistantCard";

const wrap = (ui: React.ReactElement) => render(<LangProvider>{ui}</LangProvider>);

describe("chat cards snapshots", () => {
  it("ToolStepCard: shell_run с выводом", () => {
    const call: ToolCallInfo = { id: "tc1", name: "shell_run", arguments: '{"cmd":"ls"}' };
    const { container } = wrap(
      <ToolStepCard mid="m1" call={call} content={"file1\nfile2"} />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("ToolStepCard: denied", () => {
    const call: ToolCallInfo = { id: "tc2", name: "fs_write", arguments: "{}" };
    const { container } = wrap(
      <ToolStepCard mid="m2" call={call} content="denied" status="denied" />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("UserCard: текст + вложение", () => {
    const { container } = wrap(
      <UserCard
        mid="u1"
        content="Смотри скриншот"
        attachments={[{ name: "shot.png", dataUrl: "data:image/png;base64,x" }]}
        onReuseAttachment={() => {}}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("AssistantCard: markdown + usage, вне стрима", () => {
    const msg: Message = {
      id: "a1",
      role: "assistant",
      content: "Ответ с **жирным** и `кодом`.",
      model: "glm-5.3-flash",
      usage: { prompt: 120, completion: 45, total: 165 },
    };
    const { container } = wrap(
      <AssistantCard
        mid="a1"
        message={msg}
        model="glm-5.3-flash"
        isStreaming={false}
        smooth={false}
        highlightLive={true}
        printSpeed={1}
        showReasoning={false}
        caret={false}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("AssistantCard: с thinking-блоком", () => {
    const msg: Message = {
      id: "a2",
      role: "assistant",
      content: "Готово.",
      thought: "Пользователь просит короткий ответ.",
      model: "claude-sonnet",
    };
    const { container } = wrap(
      <AssistantCard
        mid="a2"
        message={msg}
        model="claude-sonnet"
        isStreaming={false}
        smooth={false}
        highlightLive={true}
        printSpeed={1}
        showReasoning={true}
        caret={false}
      />,
    );
    expect(container.firstChild).toMatchSnapshot();
  });
});
