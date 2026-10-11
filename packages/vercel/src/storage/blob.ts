/**
 * Vercel Blob Storage Implementation - RUNTIME ENTRY
 *
 * Uses the official @vercel/blob SDK. Do NOT import this at config time;
 * use { vercelBlob } from "@emdash-cms/vercel" instead.
 *
 * Credentials come from the environment at runtime, never from the
 * serialized descriptor: the variable named by `tokenEnvVar`, or the SDK's
 * own resolution (Vercel OIDC token with a store ID, then
 * BLOB_READ_WRITE_TOKEN).
 */

import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import type {
	ByteRange,
	DownloadOptions,
	DownloadResult,
	ListOptions,
	ListResult,
	SignedUploadOptions,
	SignedUploadUrl,
	Storage,
	UploadResult,
} from "emdash";
import { EmDashStorageError } from "emdash";

const TRAILING_SLASH_PATTERN = /\/$/;
const CONTENT_RANGE_PATTERN = /^bytes (\d+)-(\d+)\/(\d+)$/;
const MAX_AGE_PATTERN = /^max-age=(\d+)$/;

/** Vercel Blob's shortest allowed CDN cache lifetime, in seconds */
export const MIN_CACHE_MAX_AGE = 60;

export type VercelBlobAccess = "public" | "private";

export interface ResolvedVercelBlobConfig {
	access: VercelBlobAccess;
	publicUrl?: string;
	/** Read/write token. When absent, @vercel/blob resolves credentials itself. */
	token?: string;
	storeId?: string;
}

function invalid(message: string): never {
	throw new EmDashStorageError(message, "INVALID_BLOB_CONFIG");
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function envValue(name: string): string | undefined {
	if (typeof process === "undefined" || !process.env) return undefined;
	return optionalString(process.env[name]?.trim());
}

/**
 * Validate the serialized descriptor config and resolve the token from the
 * environment.
 */
export function resolveBlobConfig(config: Record<string, unknown>): ResolvedVercelBlobConfig {
	const { access } = config;
	if (access !== "public" && access !== "private") {
		invalid(
			`vercelBlob({ access }) must be "public" or "private" and match the Blob store, got ${JSON.stringify(access)}`,
		);
	}

	const publicUrl = optionalString(config.publicUrl);
	if (publicUrl !== undefined) {
		if (access === "private") {
			invalid(
				"vercelBlob({ publicUrl }) needs a public store. A private store serves media through EmDash.",
			);
		}
		let protocol: string;
		try {
			protocol = new URL(publicUrl).protocol;
		} catch {
			invalid(`vercelBlob({ publicUrl }) is not a valid URL: ${publicUrl}`);
		}
		if (protocol !== "https:" && protocol !== "http:") {
			invalid(`vercelBlob({ publicUrl }) must be an http or https URL: ${publicUrl}`);
		}
	}

	const tokenEnvVar = optionalString(config.tokenEnvVar);
	const token = tokenEnvVar === undefined ? undefined : envValue(tokenEnvVar);
	if (tokenEnvVar !== undefined && token === undefined) {
		throw new EmDashStorageError(
			`missing required Blob config: set ${tokenEnvVar}, or remove tokenEnvVar to use the default Vercel Blob credentials`,
			"MISSING_BLOB_CONFIG",
		);
	}

	return { access, publicUrl, token, storeId: optionalString(config.storeId) };
}

/**
 * Map a Cache-Control header to Vercel Blob's `cacheControlMaxAge`.
 *
 * Blob only stores a max-age, with a floor of 60 seconds, so `no-cache`,
 * `no-store` and shorter max-ages become 60 seconds. Returns undefined, which
 * keeps the Blob default, when the header has no max-age.
 */
export function cacheMaxAge(cacheControl: string | undefined): number | undefined {
	if (!cacheControl) return undefined;
	const directives = cacheControl
		.toLowerCase()
		.split(",")
		.map((directive) => directive.trim());
	if (directives.includes("no-store") || directives.includes("no-cache")) {
		return MIN_CACHE_MAX_AGE;
	}
	for (const directive of directives) {
		const match = directive.match(MAX_AGE_PATTERN);
		if (match) return Math.max(MIN_CACHE_MAX_AGE, Number(match[1]));
	}
	return undefined;
}

/**
 * Reject keys that Blob would store under a different pathname than EmDash
 * asked for, or that could address another object.
 */
function assertValidKey(key: string): void {
	if (
		key === "" ||
		key.startsWith("/") ||
		key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new EmDashStorageError(`Invalid file path: ${key}`, "INVALID_PATH");
	}
}

function encodeKey(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

function formatRangeHeader(range: ByteRange): string {
	if ("suffix" in range) return `bytes=-${range.suffix}`;
	const end = range.length === undefined ? "" : range.offset + range.length - 1;
	return `bytes=${range.offset}-${end}`;
}

function parseContentRange(
	header: string | null,
): { offset: number; length: number; size: number } | undefined {
	const match = header?.match(CONTENT_RANGE_PATTERN);
	if (!match) return undefined;
	const offset = Number(match[1]);
	return { offset, length: Number(match[2]) - offset + 1, size: Number(match[3]) };
}

/** @vercel/blob returns undici's Headers, which only matches the DOM type structurally. */
function lastModifiedFrom(headers: { get(name: string): string | null }): Date | undefined {
	const value = headers.get("last-modified");
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

function isNotFound(error: unknown): boolean {
	// BlobNotFoundError keeps the default `name`, so a second copy of
	// @vercel/blob in the bundle is only recognisable by its constructor.
	return (
		error instanceof BlobNotFoundError ||
		(error instanceof Error && error.constructor.name === "BlobNotFoundError")
	);
}

async function toBuffer(body: Buffer | Uint8Array | ReadableStream<Uint8Array>): Promise<Buffer> {
	if (body instanceof ReadableStream) {
		const chunks: Uint8Array[] = [];
		const reader = body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	}
	return Buffer.isBuffer(body) ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
}

/**
 * Vercel Blob storage implementation
 */
export class VercelBlobStorage implements Storage {
	private access: VercelBlobAccess;
	private publicUrl?: string;
	private auth: { token?: string; storeId?: string };

	constructor(config: ResolvedVercelBlobConfig) {
		this.access = config.access;
		this.publicUrl = config.publicUrl;
		this.auth = {
			...(config.token !== undefined && { token: config.token }),
			...(config.storeId !== undefined && { storeId: config.storeId }),
		};
	}

	async upload(options: {
		key: string;
		body: Buffer | Uint8Array | ReadableStream<Uint8Array>;
		contentType: string;
		cacheControl?: string;
	}): Promise<UploadResult> {
		assertValidKey(options.key);
		try {
			const body = await toBuffer(options.body);
			const cacheControlMaxAge = cacheMaxAge(options.cacheControl);
			await put(options.key, body, {
				...this.auth,
				access: this.access,
				addRandomSuffix: false,
				// EmDash replaces media in place under the same key.
				allowOverwrite: true,
				contentType: options.contentType,
				...(cacheControlMaxAge !== undefined && { cacheControlMaxAge }),
			});

			return {
				key: options.key,
				url: this.getPublicUrl(options.key),
				size: body.byteLength,
			};
		} catch (error) {
			throw new EmDashStorageError(`Failed to upload file: ${options.key}`, "UPLOAD_FAILED", error);
		}
	}

	async download(key: string, options: DownloadOptions = {}): Promise<DownloadResult> {
		assertValidKey(key);
		const { range } = options;
		try {
			const ranged = range ? await this.getRange(key, range) : undefined;
			const result = ranged === undefined ? await this.getObject(key) : ranged;

			if (!result || result.statusCode !== 200 || !result.stream) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			}

			const contentType = result.blob.contentType || "application/octet-stream";
			const lastModified = lastModifiedFrom(result.headers);
			const contentRange = range && ranged ? result.headers.get("content-range") : null;
			const served = parseContentRange(contentRange);

			if (contentRange !== null && !served) {
				// A partial body we can't place in the file; read the whole file instead.
				await result.stream.cancel();
				return await this.download(key);
			}

			if (served) {
				return {
					body: result.stream,
					contentType,
					size: served.size,
					lastModified,
					range: { offset: served.offset, length: served.length },
				};
			}

			// Without Content-Length (a chunked response) the SDK reports size 0.
			const size =
				result.headers.get("content-length") === null
					? (await head(key, this.auth)).size
					: result.blob.size;

			return { body: result.stream, contentType, size, lastModified };
		} catch (error) {
			if (error instanceof EmDashStorageError) throw error;
			if (isNotFound(error)) {
				throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND", error);
			}
			throw new EmDashStorageError(`Failed to download file: ${key}`, "DOWNLOAD_FAILED", error);
		}
	}

	private getObject(key: string, headers: Record<string, string> = {}) {
		// get() builds the store URL from the pathname without encoding it.
		return get(encodeKey(key), {
			...this.auth,
			access: this.access,
			// Read the origin on private stores, so an overwrite is visible at once.
			// Public stores always read through the CDN.
			...(this.access === "private" && { useCache: false }),
			// An uncompressed body keeps Content-Length equal to the bytes streamed.
			headers: { "Accept-Encoding": "identity", ...headers },
		});
	}

	/**
	 * Resolves to undefined when the ranged read fails, including a range that
	 * starts past the end of the file (416), so the caller reads the whole file.
	 */
	private async getRange(key: string, range: ByteRange) {
		try {
			return await this.getObject(key, { Range: formatRangeHeader(range) });
		} catch {
			return undefined;
		}
	}

	async delete(key: string): Promise<void> {
		assertValidKey(key);
		try {
			await del(key, this.auth);
		} catch (error) {
			// Deleting a missing file succeeds, as on S3.
			if (isNotFound(error)) return;
			throw new EmDashStorageError(`Failed to delete file: ${key}`, "DELETE_FAILED", error);
		}
	}

	async exists(key: string): Promise<boolean> {
		assertValidKey(key);
		try {
			await head(key, this.auth);
			return true;
		} catch (error) {
			if (isNotFound(error)) return false;
			throw new EmDashStorageError(`Failed to check file existence: ${key}`, "HEAD_FAILED", error);
		}
	}

	async list(options: ListOptions = {}): Promise<ListResult> {
		try {
			const response = await list({
				...this.auth,
				prefix: options.prefix,
				limit: options.limit,
				cursor: options.cursor,
			});

			return {
				files: response.blobs.map((item) => ({
					key: item.pathname,
					size: item.size,
					lastModified: new Date(item.uploadedAt),
					etag: item.etag,
				})),
				nextCursor: response.hasMore ? response.cursor : undefined,
			};
		} catch (error) {
			throw new EmDashStorageError("Failed to list files", "LIST_FAILED", error);
		}
	}

	async getSignedUploadUrl(_options: SignedUploadOptions): Promise<SignedUploadUrl> {
		// The admin falls back to uploading through the server.
		throw new EmDashStorageError(
			"The Vercel Blob adapter does not create signed upload URLs. " +
				"Files are uploaded through the server.",
			"NOT_SUPPORTED",
		);
	}

	getPublicUrl(key: string): string {
		if (this.publicUrl) {
			return `${this.publicUrl.replace(TRAILING_SLASH_PATTERN, "")}/${encodeKey(key)}`;
		}
		// No public URL configured; defer to the /_emdash/api/media/file route.
		return `/_emdash/api/media/file/${key}`;
	}
}

/**
 * Create Vercel Blob storage adapter
 * This is the factory function called at runtime.
 */
export function createStorage(config: Record<string, unknown>): Storage {
	return new VercelBlobStorage(resolveBlobConfig(config));
}
