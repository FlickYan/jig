import type Anthropic from "@anthropic-ai/sdk";
import { addUsage, runAgent, type AgentOptions, type Usage } from "../agent.ts";
import { Conversation } from "../conversation.ts";
import type { Tool } from "./index.ts";

export interface SubagentSetup extends Omit<AgentOptions, "ui"> {
  /** The terminal lines for one subagent, labelled with its task. */
  ui(label: string): AgentOptions["ui"];
}

/**
 * Starts a subagent: a fresh agent loop with its own conversation, so the files and output it goes
 * through stay out of the main conversation, and only its final answer comes back. Subagents get the
 * read-only tools, which also lets several of them run at the same time (see runAgent).
 */
export function subagentTool(setup: SubagentSetup): Tool {
  return {
    definition: {
      name: "subagent",
      description:
        "Hand a self-contained research task to a subagent: it investigates with read-only tools in a context of its " +
        "own and returns only its findings. Use it for broad searches or questions that would mean reading many files " +
        "(where is X handled, how does Y work, which files would a change touch), to keep your own context small. " +
        "Several subagent calls in one reply run at the same time. A subagent can't change files and doesn't see " +
        "this conversation, so give it everything it needs in the prompt.",
      input_schema: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short label for the task, 3 to 5 words" },
          prompt: { type: "string", description: "The task, with all the context the subagent needs, and what to report back" },
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    kind: "read",
    describe: ({ description }) => String(description),

    async run(input, { signal, usage }) {
      const { description, prompt } = input as { description: string; prompt: string };
      const conversation = new Conversation(undefined, [{ role: "user", content: prompt }]);
      const result = await runAgent(conversation, { ...setup, ui: setup.ui(description) }, signal);
      if (usage) addUsage(usage, asApiUsage(result.usage)); // the task's cost includes its subagents'
      let answer = result.text.trim();
      if (result.stop === "max_steps") {
        // Out of steps in the middle of its research: get what it found so far, rather than nothing.
        const { message } = await setup.callModel(withRequest(conversation.messages, OUT_OF_STEPS), signal, { summarize: true });
        if (usage) addUsage(usage, message.usage);
        answer = message.content.map((block) => (block.type === "text" ? block.text : "")).join("").trim();
      }
      answer ||= "(The subagent gave no answer.)";
      return result.stop === "end_turn" ? answer : `${answer}\n\n(The subagent stopped early: ${result.stop}.)`;
    },
  };
}

const OUT_OF_STEPS = "You have run out of steps. Don't call any more tools: reply now with what you found so far, and what you didn't get to.";

/** The messages with a request added to the last user turn (it holds tool results, and turns must alternate). */
function withRequest(messages: Anthropic.Beta.BetaMessageParam[], request: string): Anthropic.Beta.BetaMessageParam[] {
  const last = messages.at(-1)!;
  const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
  return [...messages.slice(0, -1), { role: "user", content: [...content, { type: "text", text: request }] }];
}

function asApiUsage(usage: Usage): Anthropic.Beta.BetaUsage {
  return {
    input_tokens: usage.input,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
    output_tokens: usage.output,
  } as Anthropic.Beta.BetaUsage;
}
