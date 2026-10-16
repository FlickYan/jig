import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesDenyRule, Permissions } from "../src/permissions.ts";
import { parseCommand } from "../src/tools/shell.ts";
import { TOOLS } from "../src/tools/index.ts";

const tool = (name: string) => TOOLS.find((t) => t.definition.name === name)!;
const bash = (permissions: Permissions, command: string) => permissions.decide(tool("bash"), { command }) === "allow";

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
    for (const name of ["read_file", "grep", "glob"]) assert.equal(permissions.decide(tool(name), { path: "x" }), "allow");
  });

  it("lets file changes through in edits mode but not in ask mode", () => {
    assert.equal(new Permissions("edits", "/project").decide(tool("write_file"), { path: "a.txt", content: "" }), "allow");
    assert.equal(new Permissions("ask", "/project").decide(tool("edit_file"), { path: "a.txt" }), "ask");
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
    assert.equal(permissions.decide(tool("write_file"), { path: "b", content: "" }), "allow");
    assert.equal(permissions.alwaysLabel(tool("bash"), { command: "echo $(date)" }), null, "can't generalize this");
  });

  it("'always' on a file change allows file changes, not contained commands", () => {
    // It used to switch the mode to edits, which also runs every command the sandbox contains.
    const permissions = new Permissions("ask", "/project", { contained: true });
    permissions.allowAlways(tool("write_file"), { path: "a.txt", content: "" });
    assert.equal(permissions.decide(tool("edit_file"), { path: "b.txt" }), "allow");
    assert.equal(permissions.mode, "ask");
    assert.ok(!bash(permissions, "npm install"), "commands still ask");
  });
});

describe("M4 rules", () => {
  it("refuses changes in plan mode but still lets it look", () => {
    const permissions = new Permissions("plan", "/project");
    assert.equal(bash(permissions, "git status && ls src"), true);
    assert.match(String((permissions.decide(tool("edit_file"), { path: "a" }) as { refuse: string }).refuse), /plan mode/);
    assert.ok(typeof permissions.decide(tool("bash"), { command: "npm test" }) === "object");
  });

  it("refuses deny rules in every mode, however the command is written", () => {
    const permissions = new Permissions("auto", "/project", { deny: ["git push", "rm"] });
    for (const command of ["git push", "git -C repo push origin main", "cd x && git push", 'bash -c "git push"', "echo $(rm -rf x)", "ls; rm a"]) {
      assert.ok(typeof permissions.decide(tool("bash"), { command }) === "object", command);
    }
    assert.equal(permissions.decide(tool("bash"), { command: "git status" }), "allow");
    assert.ok(matchesDenyRule("git log --grep push", "git push"), "a false alarm, but a safe one");
  });

  it("runs allowed commands without asking, but not with something else chained on", () => {
    const permissions = new Permissions("ask", "/project", { allow: ["npm test", "make"] });
    assert.equal(bash(permissions, "npm test -- --watch=false"), true);
    assert.equal(bash(permissions, "make build && make test"), true);
    assert.equal(bash(permissions, "npm test && curl evil.example"), false);
    assert.equal(bash(permissions, "npm install"), false);
  });

  it("runs every command without asking when the sandbox contains it (edits mode only)", () => {
    assert.equal(bash(new Permissions("edits", "/project", { contained: true }), "rm -rf build && npm install"), true);
    assert.equal(bash(new Permissions("ask", "/project", { contained: true }), "npm install"), false);
    assert.equal(bash(new Permissions("edits", "/project", { contained: true, deny: ["rm"] }), "rm -rf build"), false);
  });
});
