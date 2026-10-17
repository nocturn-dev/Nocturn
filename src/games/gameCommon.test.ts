// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import { isGameInputTarget, readBest } from "./gameCommon";

describe("gameCommon", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("isGameInputTarget", () => {
    it("returns true for input, textarea, and select elements", () => {
      const input = document.createElement("input");
      const textarea = document.createElement("textarea");
      const select = document.createElement("select");

      expect(isGameInputTarget(input)).toBe(true);
      expect(isGameInputTarget(textarea)).toBe(true);
      expect(isGameInputTarget(select)).toBe(true);
    });

    it("returns true for contenteditable elements", () => {
      const div = document.createElement("div");
      div.contentEditable = "true";
      expect(isGameInputTarget(div)).toBe(true);
    });

    it("returns false for regular elements or null", () => {
      const div = document.createElement("div");
      const button = document.createElement("button");

      expect(isGameInputTarget(div)).toBe(false);
      expect(isGameInputTarget(button)).toBe(false);
      expect(isGameInputTarget(null)).toBe(false);
      expect(isGameInputTarget(window)).toBe(false);
    });
  });

  describe("readBest", () => {
    it("returns null when key does not exist or has invalid number", () => {
      expect(readBest("non_existent")).toBeNull();

      localStorage.setItem("invalid", "not-a-number");
      expect(readBest("invalid")).toBeNull();

      localStorage.setItem("negative", "-5");
      expect(readBest("negative")).toBeNull();
    });

    it("parses valid positive integer from localStorage", () => {
      localStorage.setItem("score", "42");
      expect(readBest("score")).toBe(42);
    });
  });
});
