# jig

A minimal coding agent for the terminal, written from scratch in TypeScript on the Claude API. There is no
agent framework: it is one streaming tool-use loop, four tools, and the guardrails that make it reasonable
to run on a real machine.

(A jig is the workshop fixture that holds a piece of work and guides the tool cutting it, which is what an
agent harness does for a model.)

## Quick start

You need Node 22.18 or newer (it runs the TypeScript directly, so there is no build step) and an
API key: DeepSeek for the default model (`deepseek-flash`), or Anthropic for Claude models.

```bash
npm install
export DEEPSEEK_API_KEY=sk-...    # or ANTHROPIC_API_KEY, and pass --model claude-opus-5-5

npm start -- -C ~/code/some-project "the login test is failing, fix it"   # run one task
npm start -- -C ~/code/some-project                                       # interactive session

npm link    # optional: puts `jig` on your PATH, then run `jig` inside any project
```

```
Usage: jig [options] [task]

  -m, --model <id>      deepseek-flash (default), deepseek-v4-pro, or a Claude model like claude-opus-5-5
  -e, --effort <level>  low | medium | high | xhigh | max (default: the model's own; DeepSeek takes low | high | max)
  -y, --yes             run every tool call without asking first
  -C, --cwd <dir>       project directory (default: the current directory)
      --max-steps <n>   most model calls per task (default: 50)
```

Before each file change or command, jig asks `Allow? [y]es / [n]o / [a]lways`. After each task it prints
the steps taken, the tokens sent and received, and how many of the input tokens came from the prompt cache.

## How it works

```
 task ──▶ messages ──▶ Claude (streamed) ──▶ reply has tool calls? ── no ──▶ done
             ▲                                    │ yes
             │                                    ▼
             │              for each call: check input ▶ ask approval ▶ run ▶ truncate output
             │                                    │
             └──── all tool results, in one message ◀┘
```

| File | What it does |
| --- | --- |
| [`src/agent.ts`](src/agent.ts) | The loop: call the model, run the tools it asks for, send back the results, until it answers without a tool call |
| [`src/model.ts`](src/model.ts) | The only file that talks to the API: request settings, streaming, checking streamed tool input |
| [`src/tools/`](src/tools) | `read_file`, `write_file`, `edit_file`, `bash` |
| [`src/prompt.ts`](src/prompt.ts) | System prompt: how to work, plus facts about the environment |
| [`src/cli.ts`](src/cli.ts) | Arguments, interactive session, approval prompt, Ctrl+C |
| [`src/ui.ts`](src/ui.ts) | Terminal output: streamed text, tool calls, result previews |

**When does the loop stop?** When a reply has no tool calls (the model's signal that it is done). Also on
`--max-steps` model calls, on Ctrl+C, and when a safety classifier declines the request.

## Design decisions

- **Exact-string edits.** `edit_file` replaces `old_string` only if it occurs exactly once, counting
  overlapping matches. Line numbers go stale after the first edit, and whole-file rewrites are slow, cost
  output tokens and can silently drop code. The replacement is spliced in by index: `String.replace` would
  expand `$&` and `$1` inside the new code.
- **Errors are written for the model.** A failed tool call returns an `is_error` result that says how to
  fix it: "occurs 3 times, include more surrounding lines", "use offset=2001 to continue".
- **Streamed tool input is checked twice.** Tool input streams as it is generated
  (`eager_input_streaming`), so the API no longer validates it. The SDK's lenient parser can turn
  `"say "hi" now"` into `"say "`, which would silently write a truncated file. jig re-parses the raw JSON
  strictly and checks it against the tool's schema, and sends anything broken back to the model as
  `INVALID_JSON` instead of running it.
- **The history only grows.** The loop never edits earlier messages, and the system prompt and tool list
  stay fixed for the whole session. This keeps the prompt cache hitting (each call pays full price only
  for what is new) and keeps the model's earlier thinking blocks valid (the API can reject them once the
  history before them has changed).
- **Every tool call gets a result.** Even calls that never ran (declined, interrupted, cut off at
  `max_tokens`, invalid input) get an error result, so the next request is always valid.
- **Commands run in their own process group.** A timeout or Ctrl+C kills the whole group, so a test
  runner's worker processes die too. Commands get no stdin, so an interactive prompt gets end-of-file
  instead of hanging the agent.
- **Guardrails.** `read_file` runs freely; writes, edits and commands ask first unless you pass `--yes`.
  The file tools refuse paths outside the project. `bash` is not confined, which is what the sandbox in
  milestone 4 is for.
- **Two providers, one format.** The default model, `deepseek-flash`, goes through DeepSeek's
  Anthropic-compatible API, so the same SDK and message format serve both. DeepSeek does not support
  `is_error` on tool results, so for DeepSeek failures are marked with `Error:` in the text instead.
  Claude models (`--model claude-opus-5-5`) get the Claude-only settings: adaptive thinking with
  short progress notes shown dimmed, prompt-cache breakpoints, and a server-side fallback model if a
  safety classifier declines a request (`fallbacks: "default"`).

## Tests

```bash
npm test            # the tools, and the loop driven by a scripted fake model: no API calls
npm run typecheck
```

## Roadmap

- [x] **1. Core loop:** streaming, `read_file` / `write_file` / `edit_file` / `bash`, step limit, approval prompt
- [ ] **2. Reliability:** `grep` and `glob` tools; reject edits to files that changed since they were last read; CRLF handling; save full command output to a file when it is truncated
- [ ] **3. Context:** load `AGENTS.md`; count tokens and compact near the limit (summarize the whole conversation into one message, or use server-side compaction: keeping the last few turns verbatim after a summary invalidates their thinking blocks); save sessions as JSONL and `--resume` them; track the cache hit rate
- [ ] **4. Safety:** permission modes (ask / auto-edit / read-only plan), allow and deny rules for commands, run commands in Docker, git snapshot before edits plus `/undo`
- [ ] **5. Extensions:** `SKILL.md` loader with progressive disclosure, MCP client over stdio, subagent tool, a pre-tool hook
- [ ] **6. Evaluation:** a fixed subset of Terminal-Bench 2.0 via Harbor; success rate, cost and turns per task; ablations (edit format, effort level, compaction, subagents) against mini-swe-agent on the same model
