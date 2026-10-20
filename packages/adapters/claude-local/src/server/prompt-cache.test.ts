import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("prepareClaudePromptBundle plugin dir", () => {
  let tempRoot: string;
  let previousPaperclipHome: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claude-prompt-cache-"));
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = path.join(tempRoot, "home");
  });

  afterEach(async () => {
    if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousPaperclipHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function makeSkill(name: string, body: string) {
    const source = path.join(tempRoot, "library", name);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), `---\nname: ${name}\n---\n${body}\n`);
    return source;
  }

  it("writes a plugin manifest and links only the bundle's skills", async () => {
    const grillingSource = await makeSkill("grilling", "grill body");
    const bundle = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills: [
        { key: "acme/grilling", runtimeName: "grilling--abc123", source: grillingSource },
      ],
      instructionsContents: "instructions",
      onLog: async () => {},
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(bundle.pluginDir, ".claude-plugin", "plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("paperclip-run-bundle");

    const pluginSkills = await fs.readdir(path.join(bundle.pluginDir, "skills"));
    expect(pluginSkills).toEqual(["grilling--abc123"]);
    expect(pluginSkills).toHaveLength(1);

    const skillText = await fs.readFile(
      path.join(bundle.pluginDir, "skills", "grilling--abc123", "SKILL.md"),
      "utf8",
    );
    expect(skillText).toContain("grill body");
  });

  it("replaces a stale plugin link on re-run", async () => {
    const source = await makeSkill("grilling", "grill body");
    const stale = path.join(tempRoot, "stale");
    await fs.mkdir(stale, { recursive: true });
    const skills = [{ key: "acme/grilling", runtimeName: "grilling--abc123", source }];

    const first = await prepareClaudePromptBundle({
      companyId: "company-1",
      skills,
      instructionsContents: null,
      onLog: async () => {},
    });
    await fs.rm(path.join(first.pluginDir, "skills", "grilling--abc123"));
    await fs.symlink(stale, path.join(first.pluginDir, "skills", "grilling--abc123"));

    await prepareClaudePromptBundle({
      companyId: "company-1",
      skills,
      instructionsContents: null,
      onLog: async () => {},
    });

    const skillText = await fs.readFile(
      path.join(first.pluginDir, "skills", "grilling--abc123", "SKILL.md"),
      "utf8",
    );
    expect(skillText).toContain("grill body");
  });
});
