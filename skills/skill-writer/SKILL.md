---
name: skill-writer
description: Writes a new Agent Skill, or improves an existing one, and submits it for the user's approval with propose_skill. Use when asked to write or improve a skill, as /skills new, /learn, jig skills new and jig skills learn do.
---

# Writing a skill

A skill is a folder with a `SKILL.md` that teaches an agent one kind of task: when to use it (the
description) and how (the instructions), with scripts and reference files beside it if it needs them.
The model sees only the name and description until a task matches, then loads the instructions.

## 1. Decide whether it is a skill

- **A skill:** a repeatable procedure with steps, checks or tools a capable engineer new to this setup
  wouldn't know: a team's release process, how to run this service's tests locally, the quirks of a file
  format, the order in which a migration must happen.
- **Not a skill:** a single fact or preference ("we use pnpm", "the user wants short answers"), which
  belongs in AGENTS.md; a one-off task; general knowledge the model already has. Say so instead of
  writing one.

## 2. Find out what it must cover

- **What triggers it:** the words a request would use, the files or tools involved.
- **The steps,** in order, and how to tell that each one worked.
- **The pitfalls:** what went wrong, or what had to be found out, the last time this was done. These are
  the most valuable lines in a skill.
- **What it needs:** programs, packages, network access, credentials (never write secrets into a skill).

Look at the project as far as the skill depends on it. When you can ask the user, ask about anything you
would otherwise have to guess; don't invent steps.

## 3. Write it

**name:** 1-64 characters of lowercase letters, digits and single hyphens, describing the task
(`writing-release-notes`, `pdf-forms`, `local-test-setup`). It is also the folder's name.

**description** (at most 1024 characters): what the skill does and when to use it, in the third person,
with the words a matching request would contain. It is all the model sees when it decides whether to load
the skill, so a vague description ("Helps with releases") means the skill is never used.

> Good: "Writes release notes for this repository from the merged pull requests since the last tag, in the
> format of CHANGELOG.md. Use when preparing a release or when asked for release notes or a changelog."

**instructions** (the body of SKILL.md):

- Open with the goal in one sentence, then numbered steps. Put commands in code blocks, exactly as they
  are to be run, and say how to check the result of each step that can fail.
- Be concrete: paths, formats, flags, an example of the input and of the output.
- Keep it short: under 500 lines, and far less where you can. Long reference material goes in
  `references/<topic>.md`, with a line in the instructions saying when to read it.
- Work that should come out the same every time (parsing, generating boilerplate, validating) goes in
  `scripts/`. Say how to run each script, from the skill's folder, and what it prints.
- No dates or version numbers that will go stale, and no secrets.

**evals:** two or three test tasks, each a realistic request with:

- `prompt`: the request, as a user would type it;
- `expected_output`: what a good result looks like;
- `expectations`: statements a grader can check from the files the agent left and its final message;
- `check`, where possible: a shell command, run in the project after the task, that exits with 0 if the
  result is right (`python3 -m pytest -q tests/test_report.py`, `grep -q '^## 1.4.0' CHANGELOG.md`);
- `files`, if the task needs input files: paths inside the skill folder, which are copied into the
  project the task starts from, keeping their layout below the folder they share
  (`evals/files/basic/src/app.py` becomes `src/app.py`); a folder listed on its own becomes the project.
  Put the files themselves in `files` of propose_skill.

`jig skills test <name>` runs each eval with the skill and without it, so the user can see whether the
skill helps.

## 4. Submit it

Call `propose_skill` with the name, description, instructions, any files (scripts, references, eval input
files) and the evals. Don't write the skill's files yourself: the user reads the proposal and decides
whether to keep it, and where. If they decline, ask what to change.

## Improving an existing skill

Load it with the skill tool first. Keep its name, change only what the new experience shows, keep it
consistent with its evals (add an eval for the case that went wrong), and submit the whole skill again
with `propose_skill`.
