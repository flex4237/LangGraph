export interface Repository {
  owner: string;
  name: string;
}

export interface RepositoryFile {
  path: string;
  size: number;
}

export interface FileChange {
  path: string;
  content: string;
}

export interface TestResult {
  command: string;
  exitCode: number;
  output: string;
}
