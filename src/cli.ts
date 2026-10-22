import type { Repository } from "./types.js";

export interface Options {
  repository: Repository;
  branch: string;
  task: string;
  push: boolean;
}

export function parseArguments(
  args: string[],
  hasGitHubToken = Boolean(process.env.GITHUB_TOKEN),
): Options {
  const values = new Map<string, string>();
  let push = true;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--push") {
      push = true;
      continue;
    }
    if (argument === "--no-push") {
      push = false;
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
      'Usage: npm run agent -- --repo owner/name --task "..." [--branch main] [--no-push]',
    );
  }
  const parts = repoValue.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("Repository must use owner/name format.");
  }

  if (push && !hasGitHubToken) {
    throw new Error("GITHUB_TOKEN with contents:write permission is required to push.");
  }

  return {
    repository: { owner: parts[0]!, name: parts[1]! },
    branch: values.get("--branch") ?? "main",
    task,
    push,
  };
}
