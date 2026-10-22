# LangGraph GitHub Coding Agent

A TypeScript CLI agent that uses LangGraph and Gemini Flash to inspect a GitHub
repository, propose code changes, run its tests locally, and commit tested
changes directly to a branch through the GitHub API. It does not clone
repositories.

## Requirements

- Node.js 20+
- A GitHub token with repository write access to push changes or create
  repositories (public repositories can be read without a token when using
  `--no-push`).
- A Google AI Studio API key for the Gemini Flash free tier. Create one at
  [Google AI Studio](https://aistudio.google.com/apikey).
- The repository's test runtime (for example, the .NET SDK for `dotnet test`).

Create a `.env` file from `.env.example`, or set `GOOGLE_API_KEY` and, when
pushing, `GITHUB_TOKEN` in your environment. Never commit credentials.
Repository file contents and task text are sent to Google's Gemini API. Review
Google AI Studio's data-use terms before sending private or sensitive code.

## Run

```sh
npm install
npm run build
npm test
npm run agent -- --repo flex4237/Validot --branch main --task "Add a focused unit test for [describe the behavior]"
```

By default, the agent commits its changes to the requested branch after tests
pass. Use `--no-push` for a dry run that only reports the proposed changes:

```sh
npm run agent -- --repo owner/repository --branch main --task "..." --no-push
```

To generate a complete project and create a new **private** GitHub repository
after its tests pass:

```sh
npm run agent -- --create-repo flex4237/accounting-app --task "Build an app for a local company to manage customers, invoices, and payments using a simple local SQLite database. Include setup instructions and tests."
```

New-repository mode currently creates repositories for the authenticated GitHub
user (not organizations). `GITHUB_TOKEN` must have permission to create
repositories and write their contents. The project is generated and tested in
a temporary directory before the repository is created, so failed tests do not
create an empty GitHub repository. Generated projects may use a .NET solution,
Node.js with `node --test`, or Python with pytest.

The agent downloads a temporary GitHub source archive for testing (not a git
clone), overlays its proposed changes, and removes the temporary workspace
afterward. The current test runner supports .NET solutions/projects, npm
projects with a `test` script, and Python projects using pytest. Commands are
selected from repository manifests; the model cannot choose arbitrary shell
commands. A failed test run prevents a push.

Each valid agent run writes a Markdown report under `reports/` in the local
agent project. Reports include the task, plan, changed paths, test output, and
commit link or error. They are local-only and are not committed to the target
repository.

Protect important branches with GitHub branch protection and use a
least-privilege token.
