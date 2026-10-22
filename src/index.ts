import "dotenv/config";
import { runCodingTask } from "./agent.js";
import { parseArguments } from "./cli.js";
import { GitHubRepository } from "./github.js";
import { writeRunReport } from "./report.js";

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const github = new GitHubRepository(options.repository, process.env.GITHUB_TOKEN);
  let result: Awaited<ReturnType<typeof runCodingTask>> | undefined;
  let failure: unknown;

  try {
    result = await runCodingTask({ ...options, github });
  } catch (error) {
    failure = error;
  }

  const reportPath = await writeRunReport({
    ...options,
    plan: result?.plan,
    summary: result?.summary,
    changes: result?.changes,
    testResult: result?.testResult,
    commitUrl: result?.commitUrl,
    error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined,
  });
  console.log(`Run report: ${reportPath}`);

  if (failure) {
    throw failure;
  }
  if (!result) {
    throw new Error("The agent completed without returning a result.");
  }

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
