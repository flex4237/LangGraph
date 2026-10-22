import { Octokit } from "@octokit/rest";
import type { FileChange, Repository, RepositoryFile } from "./types.js";
import { normalizeRepositoryPath } from "./paths.js";

const MAX_FILE_BYTES = 200_000;

export class GitHubRepository {
  private readonly octokit: Octokit;

  constructor(
    private readonly repository: Repository,
    private readonly token?: string,
  ) {
    this.octokit = new Octokit(this.token ? { auth: this.token } : {});
  }

  private get repoParams() {
    return { owner: this.repository.owner, repo: this.repository.name };
  }

  async listFiles(ref: string): Promise<RepositoryFile[]> {
    const { data: branch } = await this.octokit.repos.getBranch({
      ...this.repoParams,
      branch: ref,
    });
    const { data: commit } = await this.octokit.git.getCommit({
      ...this.repoParams,
      commit_sha: branch.commit.sha,
    });
    const { data: tree } = await this.octokit.git.getTree({
      ...this.repoParams,
      tree_sha: commit.tree.sha,
      recursive: "true",
    });

    if (tree.truncated) {
      throw new Error("Repository tree is too large to inspect safely.");
    }

    return tree.tree
      .filter(
        (entry): entry is typeof entry & { path: string; size: number } =>
          entry.type === "blob" &&
          typeof entry.path === "string" &&
          typeof entry.size === "number" &&
          entry.size <= MAX_FILE_BYTES &&
          this.isSafeReadablePath(entry.path),
      )
      .map(({ path, size }) => ({ path, size }));
  }

  async readFile(path: string, ref: string): Promise<string> {
    const safePath = normalizeRepositoryPath(path);
    const { data } = await this.octokit.repos.getContent({
      ...this.repoParams,
      path: safePath,
      ref,
    });

    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      throw new Error(`Expected a file at ${safePath}.`);
    }

    if (data.size > MAX_FILE_BYTES) {
      throw new Error(`File is too large to include in the model context: ${safePath}`);
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async downloadArchive(ref: string): Promise<Buffer> {
    const response = await fetch(
      `https://api.github.com/repos/${this.repository.owner}/${this.repository.name}/zipball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(120_000),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub archive download failed (${response.status}).`);
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > 100_000_000) {
      throw new Error("Repository archive exceeds the 100 MB safety limit.");
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async commitChanges(
    ref: string,
    changes: FileChange[],
    message: string,
  ): Promise<string> {
    if (!this.token) {
      throw new Error("GITHUB_TOKEN with contents:write permission is required to push.");
    }

    const { data: branch } = await this.octokit.git.getRef({
      ...this.repoParams,
      ref: `heads/${ref}`,
    });
    const parentSha = branch.object.sha;
    const { data: parent } = await this.octokit.git.getCommit({
      ...this.repoParams,
      commit_sha: parentSha,
    });

    const blobs = await Promise.all(
      changes.map(async (change) => {
        const path = normalizeRepositoryPath(change.path);
        const { data: blob } = await this.octokit.git.createBlob({
          ...this.repoParams,
          content: change.content,
          encoding: "utf-8",
        });
        return { path, sha: blob.sha, mode: "100644" as const, type: "blob" as const };
      }),
    );

    const { data: tree } = await this.octokit.git.createTree({
      ...this.repoParams,
      base_tree: parent.tree.sha,
      tree: blobs,
    });
    const { data: commit } = await this.octokit.git.createCommit({
      ...this.repoParams,
      message,
      tree: tree.sha,
      parents: [parentSha],
    });

    await this.octokit.git.updateRef({
      ...this.repoParams,
      ref: `heads/${ref}`,
      sha: commit.sha,
      force: false,
    });

    return commit.html_url;
  }

  async createRepository(
    description: string,
  ): Promise<{ url: string; branch: string }> {
    if (!this.token) {
      throw new Error("GITHUB_TOKEN with repo creation permission is required.");
    }

    const { data: user } = await this.octokit.users.getAuthenticated();
    if (user.login.toLowerCase() !== this.repository.owner.toLowerCase()) {
      throw new Error(
        `Creating repositories is currently supported for the authenticated user (${user.login}) only.`,
      );
    }

    const { data: repository } = await this.octokit.repos.createForAuthenticatedUser({
      name: this.repository.name,
      description: description.slice(0, 350),
      private: true,
      auto_init: true,
    });

    return {
      url: repository.html_url,
      branch: repository.default_branch,
    };
  }

  private isSafeReadablePath(path: string): boolean {
    try {
      normalizeRepositoryPath(path);
      return !path.toLowerCase().startsWith(".github/workflows/");
    } catch {
      return false;
    }
  }
}
