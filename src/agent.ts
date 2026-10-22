import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { z } from "zod";
import { GitHubRepository } from "./github.js";
import { normalizeRepositoryPath } from "./paths.js";
import type {
  FileChange,
  Repository,
  RepositoryFile,
  TestResult,
} from "./types.js";
import { runRepositoryTests } from "./workspace.js";

const MAX_ATTEMPTS = 2;
const MAX_CHANGED_FILES = 12;
const MAX_CHANGE_BYTES = 200_000;

const State = Annotation.Root({
  task: Annotation<string>(),
  repository: Annotation<Repository>(),
  branch: Annotation<string>(),
  push: Annotation<boolean>(),
  github: Annotation<GitHubRepository>(),
  files: Annotation<RepositoryFile[]>({
    default: () => [],
    reducer: (_, value) => value,
  }),
  plan: Annotation<string>({
    default: () => "",
    reducer: (_, value) => value,
  }),
  selectedPaths: Annotation<string[]>({
    default: () => [],
    reducer: (_, value) => value,
  }),
  contents: Annotation<Record<string, string>>({
    default: () => ({}),
    reducer: (_, value) => value,
  }),
  changes: Annotation<FileChange[]>({
    default: () => [],
    reducer: (_, value) => value,
  }),
  summary: Annotation<string>({
    default: () => "",
    reducer: (_, value) => value,
  }),
  testResult: Annotation<TestResult | null>({
    default: () => null,
    reducer: (_, value) => value,
  }),
  attempt: Annotation<number>({
    default: () => 0,
    reducer: (_, value) => value,
  }),
  commitUrl: Annotation<string>({
    default: () => "",
    reducer: (_, value) => value,
  }),
});

const PlanSchema = z.object({
  plan: z.string(),
  filesToRead: z.array(z.string()).max(12),
});

const ChangeSchema = z.object({
  summary: z.string(),
  changes: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    )
    .min(1)
    .max(MAX_CHANGED_FILES),
});

function createModel() {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required. Create a key in Google AI Studio.");
  }
  return new ChatGoogleGenerativeAI({
    apiKey,
    model: "gemini-3.6-flash",
    temperature: 0,
  });
}

export function createCodingAgent() {
  const model = createModel();

  const graph = new StateGraph(State)
    .addNode("inspect", async (state) => {
      const files = await state.github.listFiles(state.branch);
      return { files };
    })
    .addNode("createPlan", async (state) => {
      const planModel = model.withStructuredOutput(PlanSchema);
      const result = await planModel.invoke([
        [
          "system",
          "You are a careful senior TypeScript coding agent. Inspect repository metadata and select only the most relevant existing, non-sensitive source/test files to read. Never select environment files, secrets, or files over the supplied size limit. Return a concise implementation plan and up to 12 exact file paths.",
        ],
        [
          "human",
          `Task: ${state.task}\nRepository: ${state.repository.owner}/${state.repository.name}\nFile tree (path, bytes):\n${JSON.stringify(state.files)}`,
        ],
      ]);
      const knownPaths = new Set(state.files.map((file) => file.path));
      const selectedPaths = result.filesToRead.filter(
        (filePath) => knownPaths.has(filePath),
      );
      return {
        plan: result.plan,
        selectedPaths,
      };
    })
    .addNode("read", async (state) => {
      const pairs = await Promise.all(
        state.selectedPaths.map(async (path) => [
          path,
          await state.github.readFile(path, state.branch),
        ] as const),
      );
      return { contents: Object.fromEntries(pairs) };
    })
    .addNode("implement", async (state) => {
      const changeModel = model.withStructuredOutput(ChangeSchema);
      const result = await changeModel.invoke([
        [
          "system",
          "Implement the user's task with minimal, complete changes. Return full file contents for every changed or newly created file. Do not modify credentials, environment files, lockfiles, generated artifacts, or GitHub Actions workflows. Do not put secrets in output. Changes are tested locally before any optional GitHub commit.",
        ],
        [
          "human",
          [
            `Task: ${state.task}`,
            `Plan: ${state.plan}`,
            `Attempt: ${state.attempt + 1} of ${MAX_ATTEMPTS}`,
            `Repository files and contents: ${JSON.stringify(state.contents)}`,
            `Previous proposed changes: ${JSON.stringify(state.changes)}`,
            state.testResult
              ? `Previous test failure; fix it:\n${state.testResult.command}\n${state.testResult.output}`
              : "",
          ].join("\n\n"),
        ],
      ]);

      if (result.changes.length > MAX_CHANGED_FILES) {
        throw new Error(`The model proposed more than ${MAX_CHANGED_FILES} files.`);
      }

      const changes = result.changes.map((change) => {
        const path = normalizeRepositoryPath(change.path);
        if (path.toLowerCase().startsWith(".github/workflows/")) {
          throw new Error("Agent changes to GitHub Actions workflows are not allowed.");
        }
        if (Buffer.byteLength(change.content, "utf8") > MAX_CHANGE_BYTES) {
          throw new Error(`Proposed file is too large: ${path}`);
        }
        return { path, content: change.content };
      });

      return {
        summary: result.summary,
        changes,
        attempt: state.attempt + 1,
      };
    })
    .addNode("test", async (state) => {
      const testResult = await runRepositoryTests(
        state.github,
        state.branch,
        state.changes,
      );
      return { testResult };
    })
    .addNode("publishChanges", async (state) => {
      const result = state.testResult;
      if (!result || result.exitCode !== 0) {
        throw new Error("Refusing to commit changes because tests did not pass.");
      }
      const commitUrl = await state.github.commitChanges(
        state.branch,
        state.changes,
        `Agent: ${state.summary.slice(0, 60)}`,
      );
      return { commitUrl };
    })
    .addNode("finish", async () => ({}))
    .addEdge(START, "inspect")
    .addEdge("inspect", "createPlan")
    .addEdge("createPlan", "read")
    .addEdge("read", "implement")
    .addEdge("implement", "test")
    .addConditionalEdges("test", (state) => {
      if (state.testResult?.exitCode === 0) {
        return state.push ? "publishChanges" : "finish";
      }
      return state.attempt < MAX_ATTEMPTS ? "implement" : "finish";
    })
    .addEdge("publishChanges", "finish")
    .addEdge("finish", END)
    .compile();

  return graph;
}

export async function runCodingTask(options: {
  task: string;
  repository: Repository;
  branch: string;
  push: boolean;
  github: GitHubRepository;
}) {
  const agent = createCodingAgent();
  return agent.invoke(options);
}
