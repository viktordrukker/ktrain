import React from "react";
import { render } from "@testing-library/react";
import { describe, it, expect, beforeAll } from "vitest";
import { TaskText } from "./textFit";

beforeAll(() => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  // @ts-expect-error override for testing
  HTMLElement.prototype.getBoundingClientRect = function () {
    const element = this as HTMLElement;
    if (element.classList.contains("task-fit")) {
      return {
        width: 500,
        height: 300,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 500,
        bottom: 300,
        toJSON: () => ({})
      } as DOMRect;
    }
    if (element.classList.contains("measure")) {
      const fontSize = Number(String(element.style.fontSize || "0").replace("px", "")) || 0;
      const textLength = (element.textContent || "").trim().length || 1;
      const width = fontSize * textLength * 0.6;
      const height = fontSize * 1.1;
      return {
        width,
        height,
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        toJSON: () => ({})
      } as DOMRect;
    }
    return original.call(this);
  };
});

describe("TaskText", () => {
  it("uses same fit for identical preview/game containers", async () => {
    const config = {
      scale: 1,
      min: 80,
      max: 300,
      lineHeight: 1.05,
      letterSpacing: 0.05,
      allowWrap: false
    };

    const { container } = render(
      <div>
        <TaskText text="ELEPHANT" config={config} className="preview-item" />
        <TaskText text="ELEPHANT" config={config} className="task-current-fit" />
      </div>
    );

    await new Promise((r) => setTimeout(r, 0));

    const nodes = container.querySelectorAll(".task-fit");
    const sizeA = nodes[0]?.getAttribute("data-font-size");
    const sizeB = nodes[1]?.getAttribute("data-font-size");
    expect(sizeA).toBeTruthy();
    expect(sizeA).toEqual(sizeB);
  });
});
