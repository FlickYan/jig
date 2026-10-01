import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Permissions } from "../src/permissions.ts";
import { parseCommand } from "../src/tools/shell.ts";
import { TOOLS } from "../src/tools/index.ts";

const tool = (name: string) => TOOLS.find((t) => t.definition.name === name)!;
const bash = (permissions: Permissions, command: string) => permissions.allows(tool("bash"), { command });

describe("parseCommand", () => {
  it("splits pipelines and command lists into words", () => {
    assert.deepEqual(parseCommand("grep -rn 'foo' src | head -20"), [["grep", "-rn", "foo", "src"], ["head", "-20"]]);
    assert.deepEqual(parseCommand("git status && git diff; ls"), [["git", "status"], ["git", "diff"], ["ls"]]);
  });

  it("gives up on syntax it does not follow", () => {
    for (const command of ["echo hi > out.txt", "cat $(which x)", "cat `ls`", "sleep 5 &", "cat $HOME/x", "ls;", "a\nb"]) {
      assert.equal(parseCommand(command), null, command);
    }
  });
});

describe("Permissions", () => {
  it("never asks for read tools, in any mode", () => {
    const permissions = new Permissions("ask", "/project");
    for (const name of ["read_file", "grep", "glob"]) assert.ok(permissions.allows(tool(name), { path: "x" }));
  });

  it("lets file changes through in edits mode but not in ask mode", () => {
    assert.ok(new Permissions("edits", "/project").allows(tool("write_file"), { path: "a.txt", content: "" }));
    assert.ok(!new Permissions("ask", "/project").allows(tool("edit_file"), { path: "a.txt" }));
  });

  it("allows commands that only read inside the project", () => {
    const permissions = new Permissions("edits", "/project");
    for (const command of ["ls -la src", "cat README.md | head -5", "grep -rn TODO .", "git diff HEAD", "find . -name '*.py'"]) {
      assert.ok(bash(permissions, command), command);
    }
  });

  it("asks for everything else", () => {
    const permissions = new Permissions("edits", "/project");
    const risky = [
      "rm -rf build", // not a reader
      "cat /etc/passwd", // outside the project
      "cat ~/.ssh/id_rsa",
      "ls ../other-project",
      "find . -delete", // a reader with an option that writes
      "git push",
      "git diff --output=/tmp/x",
      "ls && rm -rf /", // one bad part is enough
      "echo hi > file.txt", // syntax we don't follow
    ];
    for (const command of risky) assert.ok(!bash(permissions, command), command);
    assert.ok(bash(new Permissions("auto", "/project"), "rm -rf build"), "auto mode never asks");
  });

  it("remembers 'always' answers", () => {
    const permissions = new Permissions("ask", "/project");
    assert.equal(permissions.alwaysLabel(tool("bash"), { command: "python3 dice.py | head" }), "`python3` commands in this project");
    permissions.allowAlways(tool("bash"), { command: "python3 dice.py" });
    assert.ok(bash(permissions, "python3 -m unittest"));
    assert.ok(!bash(permissions, "python3 /tmp/evil.py"), "still not outside the project");
    assert.ok(!bash(permissions, "python3 x.py && rm -rf src"), "only for the approved program");

    assert.equal(permissions.alwaysLabel(tool("edit_file"), { path: "a" }), "file changes");
    permissions.allowAlways(tool("edit_file"), { path: "a" });
    assert.equal(permissions.mode, "edits");
    assert.equal(permissions.alwaysLabel(tool("bash"), { command: "echo $(date)" }), null, "can't generalize this");
  });
});
