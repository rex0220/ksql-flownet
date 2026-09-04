import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

export type InputPathErrorCode =
  "INPUT_PATH_REJECTED" | "INPUT_FILE_MISSING" | "INPUT_FILE_MUTATED";

export class InputPathError extends Error {
  constructor(
    readonly code: InputPathErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InputPathError";
  }
}

export class OutputPathError extends Error {
  readonly code = "OUTPUT_PATH_REJECTED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutputPathError";
  }
}

export interface InputBaseline {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ResolveNodeInputsInput {
  readonly ioRoot: string;
  readonly patterns: Readonly<Record<string, string>>;
  readonly businessKey: string;
  readonly profile: string;
}

export interface ResolvedOutput {
  readonly name: string;
  readonly path: string;
}

export interface ResolveNodeOutputsInput {
  readonly ioRoot: string;
  readonly patterns: Readonly<Record<string, string>>;
  readonly businessKey: string;
  readonly profile: string;
  readonly runId: string;
  readonly nodeId: string;
}

export async function resolveNodeOutputs(
  input: ResolveNodeOutputsInput,
): Promise<readonly ResolvedOutput[]> {
  const substitutedPatterns = Object.keys(input.patterns)
    .sort(compareText)
    .map((name) => {
      const pattern = substituteOutputPattern(input.patterns[name]!, {
        business_key: input.businessKey,
        profile: input.profile,
        run_id: input.runId,
        node_id: input.nodeId,
      });
      assertRelativeOutputPattern(pattern);
      return { name, pattern };
    });
  const ioRoot = resolve(input.ioRoot);
  await requireOutputDirectory(ioRoot, "IO root");
  const canonicalRoot = await outputRealpath(ioRoot, "IO root");
  const outputRoot = resolve(ioRoot, "out");
  assertOutputContained(ioRoot, outputRoot);
  await ensureOutputDirectories(ioRoot, outputRoot);

  const outputs: ResolvedOutput[] = [];
  for (const { name, pattern } of substitutedPatterns) {
    const candidate = resolve(outputRoot, pattern);
    assertOutputContained(outputRoot, candidate);
    const parent = dirname(candidate);
    await ensureOutputDirectories(ioRoot, parent);
    const canonicalParent = await outputRealpath(parent, "output parent");
    assertOutputContained(canonicalRoot, canonicalParent, true);
    await inspectOutputTarget(candidate, canonicalRoot);
    outputs.push({ name, path: candidate });
  }
  return outputs;
}

export async function resolveNodeInputs(
  input: ResolveNodeInputsInput,
): Promise<readonly InputBaseline[]> {
  const inputRoot = resolve(input.ioRoot, "in");
  const canonicalRoot = await requiredRealpath(inputRoot);
  await requireDirectory(inputRoot, "input root");
  const baselines: InputBaseline[] = [];
  for (const name of Object.keys(input.patterns).sort(compareText)) {
    const pattern = input.patterns[name]!;
    const substituted = substitutePattern(pattern, {
      business_key: input.businessKey,
      profile: input.profile,
    });
    assertRelativePattern(substituted);
    const candidate = resolve(inputRoot, substituted);
    assertContained(inputRoot, candidate);
    await inspectComponents(inputRoot, candidate);
    const canonicalCandidate = await requiredRealpath(candidate);
    assertContained(canonicalRoot, canonicalCandidate);

    let handle;
    try {
      handle = await open(
        candidate,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      throw fromFsError(error, `cannot open input '${name}'`);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new InputPathError(
          "INPUT_PATH_REJECTED",
          `input '${name}' is not a regular file`,
        );
      }
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        hash.update(buffer);
      }
      baselines.push({
        name,
        path: candidate,
        sha256: hash.digest("hex"),
        bytes,
      });
    } finally {
      await handle.close();
    }
  }
  return baselines;
}

export function percentEncodePathSegment(value: string): string {
  return [...Buffer.from(value, "utf8")]
    .map((byte) =>
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x2d ||
      byte === 0x5f ||
      byte === 0x7e
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");
}

function substitutePattern(
  pattern: string,
  values: Readonly<Record<"business_key" | "profile", string>>,
): string {
  return pattern.replace(
    /\{(business_key|profile)\}/gu,
    (_match, key: keyof typeof values) => percentEncodePathSegment(values[key]),
  );
}

function substituteOutputPattern(
  pattern: string,
  values: Readonly<
    Record<"business_key" | "profile" | "run_id" | "node_id", string>
  >,
): string {
  return pattern.replace(
    /\{(business_key|profile|run_id|node_id)\}/gu,
    (_match, key: keyof typeof values) => percentEncodePathSegment(values[key]),
  );
}

function assertRelativeOutputPattern(pattern: string): void {
  if (
    pattern.length === 0 ||
    pattern.includes("\0") ||
    isAbsolute(pattern) ||
    win32.isAbsolute(pattern) ||
    /^[A-Za-z]:/u.test(pattern) ||
    pattern.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    throw new OutputPathError(
      "output pattern does not resolve to an allowed relative path",
    );
  }
}

async function ensureOutputDirectories(
  root: string,
  targetDirectory: string,
): Promise<void> {
  assertOutputContained(root, targetDirectory, true);
  const rel = relative(root, targetDirectory);
  const parts = rel === "" ? [] : rel.split(sep);
  let current = root;
  await requireOutputDirectory(current, "IO root");
  for (const part of parts) {
    current = resolve(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST") {
        throw new OutputPathError("output directory could not be created", {
          cause: error,
        });
      }
    }
    await requireOutputDirectory(current, "output path component");
  }
}

async function inspectOutputTarget(
  candidate: string,
  canonicalRoot: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return;
    throw new OutputPathError("output target could not be inspected", {
      cause: error,
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new OutputPathError(
      "output target is not a regular file or is a symbolic link or junction",
    );
  }
  const canonicalCandidate = await outputRealpath(candidate, "output target");
  assertOutputContained(canonicalRoot, canonicalCandidate);
}

async function requireOutputDirectory(
  path: string,
  label: string,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    throw new OutputPathError(`${label} is unavailable`, { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new OutputPathError(
      `${label} is not a regular directory or is a symbolic link or junction`,
    );
  }
}

async function outputRealpath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw new OutputPathError(`${label} could not be resolved`, {
      cause: error,
    });
  }
}

function assertOutputContained(
  root: string,
  candidate: string,
  allowRoot = false,
): void {
  const rel = relative(root, candidate);
  if (
    (!allowRoot && rel === "") ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new OutputPathError(
      "output path is outside the configured output root",
    );
  }
}

function fsErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
}

function assertRelativePattern(pattern: string): void {
  if (
    pattern.length === 0 ||
    pattern.includes("\0") ||
    isAbsolute(pattern) ||
    win32.isAbsolute(pattern) ||
    /^[A-Za-z]:/u.test(pattern) ||
    pattern.split(/[\\/]/u).some((part) => part === "." || part === "..")
  ) {
    throw new InputPathError(
      "INPUT_PATH_REJECTED",
      "input pattern does not resolve to an allowed relative path",
    );
  }
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new InputPathError(
      "INPUT_PATH_REJECTED",
      "input path is outside the configured input root",
    );
  }
}

async function inspectComponents(
  root: string,
  candidate: string,
): Promise<void> {
  const rel = relative(root, candidate);
  const parts = rel.split(sep);
  let current = root;
  await requireDirectory(current, "input root");
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      throw fromFsError(error, "input path component is unavailable");
    }
    if (stat.isSymbolicLink()) {
      throw new InputPathError(
        "INPUT_PATH_REJECTED",
        "input path contains a symbolic link or junction",
      );
    }
    const final = index === parts.length - 1;
    if ((!final && !stat.isDirectory()) || (final && !stat.isFile())) {
      throw new InputPathError(
        "INPUT_PATH_REJECTED",
        final
          ? "input path is not a regular file"
          : "input path contains a non-directory component",
      );
    }
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    throw fromFsError(error, `${label} is unavailable`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new InputPathError(
      "INPUT_PATH_REJECTED",
      `${label} is not a regular directory`,
    );
  }
}

async function requiredRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw fromFsError(error, "input path does not exist");
  }
}

function fromFsError(error: unknown, message: string): InputPathError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return new InputPathError(
    code === "ENOENT" || code === "ENOTDIR"
      ? "INPUT_FILE_MISSING"
      : "INPUT_PATH_REJECTED",
    message,
    { cause: error },
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
