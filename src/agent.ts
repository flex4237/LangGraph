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
import { runNewProjectTests, runRepositoryTests } from "./workspace.js";

const MAX_ATTEMPTS = 2;
const MAX_CHANGED_FILES = 12;
const MAX_CHANGE_BYTES = 200_000;
const MAX_PROJECT_FILES = 30;
const MAX_PROJECT_BYTES = 1_000_000;

const State = Annotation.Root({
  task: Annotation<string>(),
  repository: Annotation<Repository>(),
  branch: Annotation<string>(),
  push: Annotation<boolean>(),
  createRepository: Annotation<boolean>(),
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
  repositoryUrl: Annotation<string>({
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

const ProjectSchema = z.object({
  summary: z.string(),
  files: z
    .array(
      z.object({
        path: z.string(),
        content: z.string(),
      }),
    )
    .min(2)
    .max(MAX_PROJECT_FILES),
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
    .addNode("scaffold", async (state) => {
      const projectModel = model.withStructuredOutput(ProjectSchema);
      const result = await projectModel.invoke([
        [
          "system",
          [
            "Create a complete, small, runnable software project from scratch for the user's requirements.",
            "Choose a simple, maintainable stack appropriate to the task. For a local business application, prefer a local SQLite database and avoid external cloud services unless requested.",
            "Return full contents for every required source, configuration, documentation, and test file. Include a README with setup/run instructions and at least one automated test.",
            "Supported test projects have a .sln file, an npm package.json with a safe `test` script of `node --test` (no pretest/posttest scripts), or a pyproject.toml using pytest.",
            `Return at most ${MAX_PROJECT_FILES} files. Do not include dependencies' lockfiles, generated build outputs, secrets, environment files, .npmrc, .git paths, or GitHub Actions workflows.`,
            "The project will be written to a temporary local directory and its tests will run before any GitHub repository is created.",
          ].join(" "),
        ],
        [
          "human",
          [
            `Project requirements: ${state.task}`,
            `Attempt: ${state.attempt + 1} of ${MAX_ATTEMPTS}`,
            state.changes.length
              ? `Previous generated files:\n${JSON.stringify(state.changes)}`
              : "",
            state.testResult
              ? `The previous test run failed. Fix the project and tests:\n${state.testResult.command}\n${state.testResult.output}`
              : "",
          ].filter(Boolean).join("\n\n"),
        ],
      ]);

      if (result.files.length > MAX_PROJECT_FILES) {
        throw new Error(`The generated project exceeds ${MAX_PROJECT_FILES} files.`);
      }

      const seenPaths = new Set<string>();
      let totalBytes = 0;
      const changes = result.files.map((file) => {
        const path = normalizeRepositoryPath(file.path);
        if (path.toLowerCase().startsWith(".github/workflows/")) {
          throw new Error("Generated GitHub Actions workflows are not allowed.");
        }
        if (path.toLowerCase() === ".npmrc") {
          throw new Error("Generated npm configuration files are not allowed.");
        }
        if (/(\.lock|lock\.json)$/i.test(path)) {
          throw new Error(`Generated dependency lockfiles are not allowed: ${path}`);
        }
        if (seenPaths.has(path)) {
          throw new Error(`The generated project contains a duplicate path: ${path}`);
        }
        seenPaths.add(path);
        const size = Buffer.byteLength(file.content, "utf8");
        if (size > MAX_CHANGE_BYTES) {
          throw new Error(`Generated file is too large: ${path}`);
        }
        totalBytes += size;
        if (totalBytes > MAX_PROJECT_BYTES) {
          throw new Error("The generated project exceeds the 1 MB size limit.");
        }
        return { path, content: file.content };
      });

      return {
        summary: result.summary,
        changes,
        attempt: state.attempt + 1,
      };
    })
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
      const testResult = state.createRepository
        ? await runNewProjectTests(state.changes)
        : await runRepositoryTests(state.github, state.branch, state.changes);
      return { testResult };
    })
    .addNode("createRemoteRepository", async (state) => {
      const created = await state.github.createRepository(state.summary);
      return {
        branch: created.branch,
        repositoryUrl: created.url,
      };
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
    .addConditionalEdges(START, (state) =>
      state.createRepository ? "scaffold" : "inspect",
    )
    .addEdge("scaffold", "test")
    .addEdge("inspect", "createPlan")
    .addEdge("createPlan", "read")
    .addEdge("read", "implement")
    .addEdge("implement", "test")
    .addConditionalEdges("test", (state) => {
      if (state.testResult?.exitCode === 0) {
        if (state.createRepository && state.push) {
          return "createRemoteRepository";
        }
        return state.push ? "publishChanges" : "finish";
      }
      if (state.attempt < MAX_ATTEMPTS) {
        return state.createRepository ? "scaffold" : "implement";
      }
      return "finish";
    })
    .addEdge("createRemoteRepository", "publishChanges")
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
  createRepository: boolean;
  github: GitHubRepository;
}) {
  const agent = createCodingAgent();
  return agent.invoke(options);
}
