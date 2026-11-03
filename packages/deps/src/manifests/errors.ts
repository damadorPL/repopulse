/** Thrown when a manifest cannot be parsed. The worker records `message` as a manifest warning. */
export class ManifestParseError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ManifestParseError";
  }
}

export function isManifestParseError(error: unknown): error is ManifestParseError {
  return error instanceof ManifestParseError;
}
