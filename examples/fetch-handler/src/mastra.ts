import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const assistant = new Agent({
  id: 'assistant',
  name: 'assistant',
  instructions: 'You are a terse assistant.',
  // Generating text needs a provider key. Nothing in this example calls the model, so none is set.
  model: 'openai/gpt-4o',
});

const greet = createStep({
  id: 'greet',
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ greeting: z.string() }),
  execute: async ({ inputData }) => ({ greeting: `Hello, ${inputData.name}!` }),
});

/** Runs without any API key, so a request can prove Mastra really executed something. */
const greetWorkflow = createWorkflow({
  id: 'greet',
  inputSchema: z.object({ name: z.string().min(1) }),
  outputSchema: z.object({ greeting: z.string() }),
})
  .then(greet)
  .commit();

export function createMastra(): Mastra {
  return new Mastra({
    // Workflow runs are stored, so something has to hold them. In memory is enough for an example.
    storage: new InMemoryStore(),
    agents: { assistant },
    workflows: { greet: greetWorkflow },
  });
}
