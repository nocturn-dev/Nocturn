import { describe, expect, it } from "vitest";
import { parsePlanTasks } from "./planUpdate";

describe("parsePlanTasks", () => {
  it("валидные задачи проходят, title триммится", () => {
    expect(
      parsePlanTasks([
        { title: "  Прочитать файл  ", status: "in_progress" },
        { title: "Написать код", status: "done" },
      ]),
    ).toEqual([
      { title: "Прочитать файл", status: "in_progress" },
      { title: "Написать код", status: "done" },
    ]);
  });
  it("мусорные элементы выкидываются молча", () => {
    expect(
      parsePlanTasks([
        { title: "", status: "pending" },
        { title: "   ", status: "pending" },
        { title: "ok", status: "cancelled" },
        { title: "ok", status: 42 },
        null,
        42,
        "string",
        { title: 42, status: "done" },
      ]),
    ).toEqual([]);
  });
  it("не-массив (в т.ч. undefined/null) → пустой список", () => {
    expect(parsePlanTasks(undefined)).toEqual([]);
    expect(parsePlanTasks(null)).toEqual([]);
    expect(parsePlanTasks({ title: "x", status: "pending" })).toEqual([]);
    expect(parsePlanTasks("[]")).toEqual([]);
  });
  it("частично валидный массив сохраняет валидное", () => {
    expect(
      parsePlanTasks([
        { title: "ок", status: "pending", extra: 1 },
        { title: "битый", status: "nope" },
      ]),
    ).toEqual([{ title: "ок", status: "pending" }]);
  });
});
