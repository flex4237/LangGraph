import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import type { FileChange, TestResult } from "./types.js";
import { normalizeRepositoryPath } from "./paths.js";
import { GitHubRepository } from "./github.js";

const MAX_TEST_MS = 10 * 60 * 1000;
const MAX_OUTPUT_CHARS = 16_000;

export async function runRepositoryTests(
  github: GitHubRepository,
  branch: string,
  changes: FileChange[],
): Promise<TestResult> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "langgraph-agent-"),
  );

  try {
    const archive = await github.downloadArchive(branch);
    const extractedDirectory = path.join(temporaryDirectory, "source");
    await extractArchive(archive, extractedDirectory);
    const root = await findRepositoryRoot(extractedDirectory);

    await writeChanges(root, changes);
    return await executeProjectTests(root, false);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runNewProjectTests(
  changes: FileChange[],
): Promise<TestResult> {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "langgraph-new-project-"),
  );

  try {
    await writeChanges(temporaryDirectory, changes);
    return await executeProjectTests(temporaryDirectory, true);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function writeChanges(root: string, changes: FileChange[]): Promise<void> {
  for (const change of changes) {
    const safePath = normalizeRepositoryPath(change.path);
    const destination = path.resolve(root, safePath);
    if (!destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Change path escapes the temporary workspace: ${change.path}`);
    }
    const directory = path.dirname(destination);
    await mkdir(directory, { recursive: true });
    await writeFile(destination, change.content, "utf8");
  }
}

async function extractArchive(archive: Buffer, destination: string): Promise<void> {
  const entries = unzipSync(archive);
  const names = Object.keys(entries);
  const roots = new Set(names.map((name) => name.split("/")[0]));
  if (roots.size !== 1 || names.length > 50_000) {
    throw new Error("Repository archive has an unexpected structure or too many files.");
  }

  let expandedBytes = 0;
  for (const name of names) {
    if (name.endsWith("/")) continue;
    const relativePath = name.split("/").slice(1).join("/");
    const safePath = normalizeRepositoryPath(relativePath);
    const contents = entries[name]!;
    expandedBytes += contents.byteLength;
    if (expandedBytes > 500_000_000) {
      throw new Error("Repository archive expands beyond the 500 MB safety limit.");
    }

    const filePath = path.resolve(destination, safePath);
    if (!filePath.startsWith(`${destination}${path.sep}`)) {
      throw new Error(`Archive path escapes the temporary workspace: ${name}`);
    }
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents);
  }
}

async function findRepositoryRoot(extractedDirectory: string): Promise<string> {
  return extractedDirectory;
}

async function executeProjectTests(
  root: string,
  generatedProject: boolean,
): Promise<TestResult> {
  const entries = await readdir(root, { withFileTypes: true });
  const solution = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"),
  );
  if (solution) {
    return executeTest("dotnet", ["test", solution.name], root);
  }

  const packageJson = entries.find(
    (entry) => entry.isFile() && entry.name === "package.json",
  );
  if (packageJson) {
    const manifest = JSON.parse(
      await readFile(path.join(root, packageJson.name), "utf8"),
    ) as { scripts?: Record<string, string> };
    if (manifest.scripts?.test) {
      if (generatedProject) {
        const scripts = manifest.scripts;
        if (
          scripts.pretest ||
          scripts.posttest ||
          !/^node(?:\.exe)?\s+--test(?:\s+[\w./*-]+)?$/.test(scripts.test)
        ) {
          throw new Error(
            "Generated npm projects must use `node --test` and must not define pretest or posttest scripts.",
          );
        }
        if (!(await hasNodeTestFiles(root))) {
          throw new Error("Generated Node.js projects must include at least one test file.");
        }
      }
      const lockfileExists = entries.some(
        (entry) =>
          entry.isFile() &&
          ["package-lock.json", "npm-shrinkwrap.json"].includes(entry.name),
      );
      const installResult = lockfileExists
        ? await executeTest("npm", ["ci", "--ignore-scripts"], root)
        : await executeTest("npm", ["install", "--ignore-scripts"], root);
      if (installResult.exitCode !== 0) {
        return installResult;
      }
      if (generatedProject) {
        return executeTest(
          process.execPath,
          manifest.scripts.test.split(/\s+/).slice(1),
          root,
        );
      }
      return executeTest("npm", ["test"], root);
    }
  }

  if (entries.some((entry) => entry.isFile() && entry.name === "pyproject.toml")) {
    return executeTest("python", ["-m", "pytest"], root);
  }

  throw new Error(
    "No supported test entry point found (solution, npm test script, or pyproject.toml).",
  );
}

async function hasNodeTestFiles(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && /\.(test|spec)\.(js|mjs|cjs)$/i.test(entry.name)) {
      return true;
    }
    if (
      entry.isDirectory() &&
      entry.name !== "node_modules" &&
      (await hasNodeTestFiles(path.join(directory, entry.name)))
    ) {
      return true;
    }
  }
  return false;
}

function executeTest(
  command: string,
  args: string[],
  cwd: string,
): Promise<TestResult> {
  return new Promise((resolve, reject) => {
    const npmExecPath = process.env.npm_execpath;
    const useWindowsNpmFallback =
      command === "npm" && process.platform === "win32" && !npmExecPath;
    const spawnCommand =
      command === "npm" && process.platform === "win32" && npmExecPath
        ? process.execPath
        : useWindowsNpmFallback
          ? process.env.ComSpec ?? "cmd.exe"
          : command;
    const spawnArgs =
      spawnCommand === process.execPath && command === "npm" && npmExecPath
        ? [npmExecPath, ...args]
        : useWindowsNpmFallback
          ? ["/d", "/s", "/c", `npm.cmd ${args.join(" ")}`]
          : args;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      DOTNET_NOLOGO: "1",
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      shell: false,
      windowsHide: true,
      env,
    });

    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Test command timed out after ${MAX_TEST_MS / 1000} seconds.`));
    }, MAX_TEST_MS);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        command: [command, ...args].join(" "),
        exitCode: exitCode ?? 1,
        output,
      });
    });
  });
}
