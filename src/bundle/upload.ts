export type BundleFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface UploadBundleOptions {
  readonly endpoint: string;
  readonly zipBytes: Uint8Array;
  readonly fetch: BundleFetch;
  readonly filename?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface DownloadBundleOptions {
  readonly endpoint: string;
  readonly fileKey: string;
  readonly fetch: BundleFetch;
  readonly headers?: Readonly<Record<string, string>>;
}

export class BundleUploadError extends Error {
  readonly code = "BUNDLE_UPLOAD_FAILED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BundleUploadError";
  }
}

/**
 * Uploads one bundle and returns the newly issued attachment fileKey.
 *
 * kintone upload fileKey values are single-use for attachment. Every attach or
 * re-attach must call this helper again; callers must never cache or reuse a
 * previously consumed fileKey (D-12).
 */
export async function uploadBundle(
  options: UploadBundleOptions,
): Promise<string> {
  const body = new FormData();
  body.append(
    "file",
    new Blob([Buffer.from(options.zipBytes)], { type: "application/zip" }),
    options.filename ?? "execution-bundle.zip",
  );
  let response: Response;
  try {
    response = await options.fetch(options.endpoint, {
      method: "POST",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      body,
    });
  } catch (error) {
    throw new BundleUploadError("bundle upload request failed", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new BundleUploadError(
      `bundle upload returned HTTP ${response.status}`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new BundleUploadError("bundle upload returned invalid JSON", {
      cause: error,
    });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    !("fileKey" in value) ||
    typeof value.fileKey !== "string" ||
    value.fileKey === ""
  ) {
    throw new BundleUploadError("bundle upload response has no fileKey");
  }
  return value.fileKey;
}

export async function downloadBundle(
  options: DownloadBundleOptions,
): Promise<Buffer> {
  const url = new URL(options.endpoint);
  url.searchParams.set("fileKey", options.fileKey);
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "GET",
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    });
  } catch (error) {
    throw new BundleUploadError("bundle download request failed", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new BundleUploadError(
      `bundle download returned HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}
