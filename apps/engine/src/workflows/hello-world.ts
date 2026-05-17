import { workflow } from "@duraflow/sdk";

export const helloWorld = workflow("hello-world", async ({ step, input }) => {
  const greeting = await step.run("greet", async () => {
    return `Hello, ${(input as any).name || "World"}!`; // any: workflow input is user-provided, shape unknown
  });
  return { message: greeting };
});
