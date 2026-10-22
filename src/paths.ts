import path from "node:path";

export function normalizeRepositoryPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/");

  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    segments.some((segment) =>
      ["..", ".", ".git"].includes(segment.toLowerCase()),
    )
  ) {
    throw new Error(`Unsafe repository path: ${filePath}`);
  }

  if (
    segments.some((segment) => segment.toLowerCase().startsWith(".env")) ||
    /\.(pem|key)$/i.test(normalized)
  ) {
    throw new Error(`Refusing to modify a credential-like file: ${filePath}`);
  }

  const result = segments.filter((segment) => segment.length > 0).join("/");
  if (!result || result.includes("\0")) {
    throw new Error(`Unsafe repository path: ${filePath}`);
  }
  return result;
}
