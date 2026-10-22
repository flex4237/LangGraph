import "dotenv/config";
import { runCodingTask } from "./agent.js";
import { GitHubRepository } from "./github.js";
import type { Repository } from "./types.js";

interface Options {
  repository: Repository;
  branch: string;
  task: string;
  push: boolean;
}

function parseArguments(args: string[]): Options {
  const values = new Map<string, string>();
  let push = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--push") {
      push = true;
      continue;
    }
    if (!["--repo", "--branch", "--task"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Expected a value after ${argument}.`);
    }
    values.set(argument, value);
    index += 1;
  }

  const repoValue = values.get("--repo");
  const task = values.get("--task");
  if (!repoValue || !task) {
    throw new Error(
      'Usage: npm run agent -- --repo owner/name --task "..." [--branch main] [--push]',
    );
  }
  const parts = repoValue.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("Repository must use owner/name format.");
  }

  const token = process.env.GITHUB_TOKEN;
  if (push && !token) {
    throw new Error("GITHUB_TOKEN with contents:write permission is required for --push.");
  }

  return {
    repository: { owner: parts[0]!, name: parts[1]! },
    branch: values.get("--branch") ?? "main",
    task,
    push,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const github = new GitHubRepository(options.repository, process.env.GITHUB_TOKEN);
  const result = await runCodingTask({ ...options, github });

  console.log(`Plan:\n${result.plan}`);
  console.log(`\nChanges: ${result.changes.map((change) => change.path).join(", ")}`);
  console.log(`Summary: ${result.summary}`);

  if (result.testResult) {
    console.log(`\nTests: ${result.testResult.command} (exit ${result.testResult.exitCode})`);
    console.log(result.testResult.output);
  }

  if (result.commitUrl) {
    console.log(`\nCommit: ${result.commitUrl}`);
  } else if (options.push && result.testResult?.exitCode !== 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
