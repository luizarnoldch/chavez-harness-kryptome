import { describe, expect, test } from "bun:test";
import { createSkillsMcpServer, allowedSkillsMcpTools } from "./skills-mcp";
import { mergeSkillLayers } from "./skills-merge";

describe("skills-mcp", () => {
  test("createSkillsMcpServer does not throw with empty bundle", () => {
    const server = createSkillsMcpServer(
      mergeSkillLayers({ user: [], project: [], local: [] }),
    );
    expect(server).toBeTruthy();
  });

  test("createSkillsMcpServer with one skill", () => {
    const server = createSkillsMcpServer(
      mergeSkillLayers({
        user: [],
        project: [
          {
            layer: "project",
            name: "pdf",
            description: "d",
            body: "b",
            enabled: true,
            chars: 1,
            truncated: false,
          },
        ],
        local: [],
      }),
    );
    expect(server).toBeTruthy();
    expect(allowedSkillsMcpTools()[0]).toContain("chavez-skills");
  });
});
