import { describe, expect, it } from "vitest";
import { detectClaudeLoginRequired } from "../../../packages/adapters/claude-local/src/server/parse.js";

describe("Claude turn-limit authentication regression", () => {
  const loginPrompt = "Not logged in · Please run /login";

  it("still detects an actual login prompt", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: loginPrompt,
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it.each(["stdout", "stderr"] as const)(
    "ignores login-looking %s after max-turn exhaustion",
    (stream) => {
      expect(
        detectClaudeLoginRequired({
          parsed: {
            type: "result",
            subtype: "error_max_turns",
            is_error: true,
            errors: ["Reached maximum number of turns (20)"],
          },
          stdout: stream === "stdout" ? loginPrompt : "",
          stderr: stream === "stderr" ? loginPrompt : "",
        }),
      ).toEqual({ requiresLogin: false, loginUrl: null });
    },
  );
});
