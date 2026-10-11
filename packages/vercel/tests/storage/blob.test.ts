import { EmDashStorageError } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * In-memory stand-in for the Blob service behind @vercel/blob. It follows the
 * service and SDK behaviour the adapter depends on, so these tests fail when
 * the adapter stops handling it:
 *
 * - put() refuses to overwrite without allowOverwrite and adds a random suffix
 *   unless addRandomSuffix is false.
 * - get() builds a URL from the pathname, so an unencoded `#` or `?` cuts it.
 * - get() answers Range with 206 and Content-Range, like the Blob CDN.
 * - get() serves the copy the CDN cached at the first read, unless the store
 *   is private and useCache is false.
 * - get() gzips text unless asked for identity, and Content-Length is then the
 *   compressed length while the SDK streams the decompressed body.
 * - An explicit token must be the store's token.
 * - head() throws BlobNotFoundError, whose `name` is the default "Error".
 */
const blob = vi.hoisted(() => {
	class BlobNotFoundError extends Error {}
	interface Stored {
		bytes: Uint8Array;
		contentType: string;
		uploadedAt: Date;
	}
	const store = new Map<string, Stored>();
	const cdn = new Map<string, Stored>();
	const behaviour = { chunked: false, rangeFails: false, failAll: false, badContentRange: false };
	const RANGE = /^bytes=(\d*)-(\d*)$/;
	const STORE_TOKEN = "fake-store-token";

	function check(options: Record<string, unknown> = {}) {
		if (behaviour.failAll) throw new Error("Blob service unavailable");
		if (options.token !== undefined && options.token !== STORE_TOKEN) {
			throw new Error("Access denied, please provide a valid token for this resource.");
		}
	}

	function pathnameFromUrl(pathname: string): string {
		// The SDK concatenates the pathname into a URL; `#` and `?` end the path.
		const path = pathname.split(/[#?]/)[0] ?? "";
		return path.split("/").map(decodeURIComponent).join("/");
	}

	return {
		STORE_TOKEN,
		store,
		behaviour,
		reset() {
			store.clear();
			cdn.clear();
			Object.assign(behaviour, {
				chunked: false,
				rangeFails: false,
				failAll: false,
				badContentRange: false,
			});
		},
		module: {
			BlobNotFoundError,
			async put(pathname: string, body: Buffer, options: Record<string, unknown>) {
				check(options);
				if (options.access !== "public" && options.access !== "private") {
					throw new Error("access must be public or private");
				}
				const key = options.addRandomSuffix === false ? pathname : `${pathname}-r4nd0m`;
				if (store.has(key) && options.allowOverwrite !== true) {
					throw new Error("This blob already exists");
				}
				store.set(key, {
					bytes: new Uint8Array(body),
					contentType: String(options.contentType),
					uploadedAt: new Date("2026-10-01T12:00:00Z"),
				});
				return { pathname: key };
			},
			async get(pathname: string, options: Record<string, unknown>) {
				check(options);
				const key = pathnameFromUrl(pathname);
				const origin = store.get(key);
				if (!origin) return null;
				const bypassCache = options.access === "private" && options.useCache === false;
				if (!bypassCache && !cdn.has(key)) cdn.set(key, origin);
				const object = bypassCache ? origin : cdn.get(key)!;

				const requestHeaders = (options.headers as Record<string, string> | undefined) ?? {};
				const size = object.bytes.byteLength;
				let start = 0;
				let end = size - 1;
				let partial = false;
				if (requestHeaders.Range) {
					if (behaviour.rangeFails) throw new Error("Failed to fetch blob: 416");
					const match = requestHeaders.Range.match(RANGE);
					if (match && match[1] === "") {
						start = Math.max(0, size - Number(match[2]));
					} else if (match) {
						start = Number(match[1]);
						if (match[2] !== "") end = Math.min(Number(match[2]), size - 1);
					}
					if (start >= size) throw new Error("Failed to fetch blob: 416");
					partial = true;
				}
				const bytes = object.bytes.slice(start, end + 1);
				const compressed =
					object.contentType.startsWith("text/") &&
					requestHeaders["Accept-Encoding"] !== "identity";
				const length = compressed ? Math.ceil(bytes.byteLength / 2) : bytes.byteLength;
				const headers = new Headers({
					"content-type": object.contentType,
					"last-modified": object.uploadedAt.toUTCString(),
				});
				if (!behaviour.chunked) headers.set("content-length", String(length));
				if (compressed) headers.set("content-encoding", "gzip");
				if (partial) {
					headers.set(
						"content-range",
						behaviour.badContentRange ? "bytes */10" : `bytes ${start}-${end}/${size}`,
					);
				}
				return {
					statusCode: 200,
					stream: new Blob([bytes]).stream(),
					headers,
					blob: { contentType: object.contentType, size: behaviour.chunked ? 0 : length },
				};
			},
			async head(pathname: string, options: Record<string, unknown> = {}) {
				check(options);
				const object = store.get(pathname);
				if (!object) throw new BlobNotFoundError("The requested blob does not exist");
				return { pathname, size: object.bytes.byteLength, uploadedAt: object.uploadedAt };
			},
			async del(pathname: string, options: Record<string, unknown> = {}) {
				check(options);
				store.delete(pathname);
				cdn.delete(pathname);
			},
			async list(options: { prefix?: string; limit?: number; cursor?: string; token?: string }) {
				check(options);
				const keys = [...store.keys()]
					.filter((key) => key.startsWith(options.prefix ?? ""))
					.toSorted();
				const from = options.cursor ? Number(options.cursor) : 0;
				const limit = options.limit ?? 1000;
				const page = keys.slice(from, from + limit);
				const hasMore = from + limit < keys.length;
				return {
					blobs: page.map((key) => ({
						pathname: key,
						size: store.get(key)!.bytes.byteLength,
						uploadedAt: store.get(key)!.uploadedAt,
						etag: `"etag-${key}"`,
					})),
					hasMore,
					cursor: hasMore ? String(from + limit) : undefined,
				};
			},
		},
	};
});

vi.mock("@vercel/blob", () => blob.module);

import { vercelBlob } from "../../src/index.js";
import { cacheMaxAge, createStorage, resolveBlobConfig } from "../../src/storage/blob.js";

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

function storageError(fn: () => unknown): EmDashStorageError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(EmDashStorageError);
		return error as EmDashStorageError;
	}
	throw new Error("expected an EmDashStorageError");
}

const bytes = (value: string) => new TextEncoder().encode(value);

beforeEach(() => blob.reset());

afterEach(() => {
	delete process.env.MEDIA_BLOB_TOKEN;
});

describe("vercelBlob descriptor", () => {
	it("points at the runtime entry that createStorage is exported from", () => {
		expect(vercelBlob({ access: "private" }).entrypoint).toBe("@emdash-cms/vercel/storage/blob");
	});
});

describe("resolveBlobConfig", () => {
	it("requires the store's access mode", () => {
		expect(storageError(() => resolveBlobConfig({})).code).toBe("INVALID_BLOB_CONFIG");
		expect(storageError(() => resolveBlobConfig({ access: "open" })).code).toBe(
			"INVALID_BLOB_CONFIG",
		);
	});

	it("rejects a public URL for a private store", () => {
		const error = storageError(() =>
			resolveBlobConfig({ access: "private", publicUrl: "https://cdn.example.com" }),
		);
		expect(error.code).toBe("INVALID_BLOB_CONFIG");
	});

	it("rejects a public URL that is not http or https", () => {
		expect(
			storageError(() =>
				resolveBlobConfig({ access: "public", publicUrl: "ftp://cdn.example.com" }),
			).code,
		).toBe("INVALID_BLOB_CONFIG");
		expect(
			storageError(() => resolveBlobConfig({ access: "public", publicUrl: "not a url" })).code,
		).toBe("INVALID_BLOB_CONFIG");
	});

	it("fails clearly when the named token variable is empty", () => {
		process.env.MEDIA_BLOB_TOKEN = "";
		const error = storageError(() =>
			resolveBlobConfig({ access: "private", tokenEnvVar: "MEDIA_BLOB_TOKEN" }),
		);
		expect(error.code).toBe("MISSING_BLOB_CONFIG");
		expect(error.message).toContain("MEDIA_BLOB_TOKEN");
	});
});

describe("cacheMaxAge", () => {
	it("maps Cache-Control onto Blob's max-age with its 60 second floor", () => {
		expect(cacheMaxAge(undefined)).toBeUndefined();
		expect(cacheMaxAge("public")).toBeUndefined();
		expect(cacheMaxAge("public, max-age=31536000, immutable")).toBe(31536000);
		expect(cacheMaxAge("public, max-age=0, must-revalidate")).toBe(60);
		expect(cacheMaxAge("no-store")).toBe(60);
		expect(cacheMaxAge("Public, Max-Age=120")).toBe(120);
	});
});

describe("VercelBlobStorage", () => {
	const privateStorage = () => createStorage({ access: "private" });

	it("round-trips a streamed upload under the exact key", async () => {
		const storage = privateStorage();
		const result = await storage.upload({
			key: "01J9MEDIA.bin",
			body: new Blob(["hello blob"]).stream(),
			contentType: "application/octet-stream",
		});

		expect(result).toEqual({
			key: "01J9MEDIA.bin",
			url: "/_emdash/api/media/file/01J9MEDIA.bin",
			size: 10,
		});
		expect([...blob.store.keys()]).toEqual(["01J9MEDIA.bin"]);
		const download = await storage.download("01J9MEDIA.bin");
		expect(await text(download.body)).toBe("hello blob");
		expect(download.size).toBe(10);
		expect(download.contentType).toBe("application/octet-stream");
		expect(download.lastModified).toEqual(new Date("2026-10-01T12:00:00Z"));
		expect(download.range).toBeUndefined();
	});

	it("shows replaced bytes at once on a private store", async () => {
		const storage = privateStorage();
		await storage.upload({ key: "a.png", body: bytes("old"), contentType: "image/png" });
		await storage.download("a.png");
		await storage.upload({
			key: "a.png",
			body: bytes("new!"),
			contentType: "image/png",
			cacheControl: "public, max-age=0, must-revalidate",
		});

		const download = await storage.download("a.png");
		expect(await text(download.body)).toBe("new!");
		expect(download.size).toBe(4);
	});

	it("reports the stored size of a text file", async () => {
		const storage = privateStorage();
		await storage.upload({
			key: "notes.txt",
			body: bytes("plain text body"),
			contentType: "text/plain",
		});

		const download = await storage.download("notes.txt");
		expect(await text(download.body)).toBe("plain text body");
		expect(download.size).toBe(15);
	});

	it("reads back keys that contain URL delimiters", async () => {
		const storage = privateStorage();
		await storage.upload({ key: "01J9MEDIA.png#1", body: bytes("hash"), contentType: "image/png" });

		expect(await text((await storage.download("01J9MEDIA.png#1")).body)).toBe("hash");
	});

	it("returns the public URL for uploads to a public store with publicUrl", async () => {
		const storage = createStorage({
			access: "public",
			publicUrl: "https://store.public.blob.vercel-storage.com/",
		});
		const result = await storage.upload({
			key: "media/hero image#1.jpg",
			body: bytes("x"),
			contentType: "image/jpeg",
		});

		expect(result.url).toBe(
			"https://store.public.blob.vercel-storage.com/media/hero%20image%231.jpg",
		);
	});

	it("authenticates with the token from tokenEnvVar", async () => {
		process.env.MEDIA_BLOB_TOKEN = `${blob.STORE_TOKEN}\n`;
		const storage = createStorage({ access: "private", tokenEnvVar: "MEDIA_BLOB_TOKEN" });
		await storage.upload({ key: "a.png", body: bytes("ok"), contentType: "image/png" });
		expect(await storage.exists("a.png")).toBe(true);

		process.env.MEDIA_BLOB_TOKEN = "fake-other-store-token";
		const wrongStore = createStorage({ access: "private", tokenEnvVar: "MEDIA_BLOB_TOKEN" });
		await expect(wrongStore.exists("a.png")).rejects.toMatchObject({ code: "HEAD_FAILED" });
	});

	describe("ranged download", () => {
		beforeEach(async () => {
			await privateStorage().upload({
				key: "clip.mp4",
				body: bytes("0123456789"),
				contentType: "video/mp4",
			});
		});

		it("serves an offset and length", async () => {
			const result = await privateStorage().download("clip.mp4", {
				range: { offset: 2, length: 3 },
			});
			expect(await text(result.body)).toBe("234");
			expect(result.size).toBe(10);
			expect(result.range).toEqual({ offset: 2, length: 3 });
		});

		it("serves an open-ended range clamped to the file", async () => {
			const result = await privateStorage().download("clip.mp4", { range: { offset: 7 } });
			expect(await text(result.body)).toBe("789");
			expect(result.range).toEqual({ offset: 7, length: 3 });
		});

		it("serves a suffix range", async () => {
			const result = await privateStorage().download("clip.mp4", { range: { suffix: 4 } });
			expect(await text(result.body)).toBe("6789");
			expect(result.size).toBe(10);
			expect(result.range).toEqual({ offset: 6, length: 4 });
		});

		it("returns the whole file when the range cannot be served", async () => {
			const result = await privateStorage().download("clip.mp4", { range: { offset: 50 } });
			expect(await text(result.body)).toBe("0123456789");
			expect(result.size).toBe(10);
			expect(result.range).toBeUndefined();
		});

		it("returns the whole file when the ranged request fails", async () => {
			blob.behaviour.rangeFails = true;
			const result = await privateStorage().download("clip.mp4", { range: { offset: 2 } });
			expect(await text(result.body)).toBe("0123456789");
			expect(result.range).toBeUndefined();
		});

		it("returns the whole file when Content-Range cannot be read", async () => {
			blob.behaviour.badContentRange = true;
			const result = await privateStorage().download("clip.mp4", { range: { offset: 2 } });
			expect(await text(result.body)).toBe("0123456789");
			expect(result.size).toBe(10);
			expect(result.range).toBeUndefined();
		});
	});

	it("reports the whole-file size for a chunked response", async () => {
		await privateStorage().upload({
			key: "big.bin",
			body: new Uint8Array(4096),
			contentType: "application/octet-stream",
		});
		blob.behaviour.chunked = true;

		expect((await privateStorage().download("big.bin")).size).toBe(4096);
	});

	it("maps missing files to NOT_FOUND", async () => {
		await expect(privateStorage().download("missing.png")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(await privateStorage().exists("missing.png")).toBe(false);
		await expect(privateStorage().delete("missing.png")).resolves.toBeUndefined();
	});

	it("wraps service failures in EmDash storage error codes", async () => {
		blob.behaviour.failAll = true;
		const storage = privateStorage();

		await expect(
			storage.upload({ key: "a.png", body: bytes("x"), contentType: "image/png" }),
		).rejects.toMatchObject({ code: "UPLOAD_FAILED" });
		await expect(storage.download("a.png")).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
		await expect(storage.exists("a.png")).rejects.toMatchObject({ code: "HEAD_FAILED" });
		await expect(storage.delete("a.png")).rejects.toMatchObject({ code: "DELETE_FAILED" });
		await expect(storage.list()).rejects.toMatchObject({ code: "LIST_FAILED" });
	});

	it("rejects keys that would address another object", async () => {
		const storage = privateStorage();
		for (const key of ["", "/abs.png", "a/../b.png", "a//b.png", "./a.png"]) {
			await expect(
				storage.upload({ key, body: bytes("x"), contentType: "image/png" }),
			).rejects.toMatchObject({ code: "INVALID_PATH" });
		}
		expect(blob.store.size).toBe(0);
	});

	it("lists by prefix and pages with a cursor", async () => {
		const storage = privateStorage();
		for (const key of ["media/a.png", "media/b.png", "media/c.png", "backups/x.json"]) {
			await storage.upload({ key, body: bytes("ab"), contentType: "image/png" });
		}

		const first = await storage.list({ prefix: "media/", limit: 2 });
		expect(first.files.map((file) => file.key)).toEqual(["media/a.png", "media/b.png"]);
		expect(first.files[0]).toMatchObject({ size: 2, etag: '"etag-media/a.png"' });
		expect(first.files[0]?.lastModified).toBeInstanceOf(Date);

		const second = await storage.list({ prefix: "media/", limit: 2, cursor: first.nextCursor });
		expect(second.files.map((file) => file.key)).toEqual(["media/c.png"]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("does not sign uploads, so the admin uploads through the server", async () => {
		await expect(
			privateStorage().getSignedUploadUrl({ key: "a.png", contentType: "image/png", size: 1 }),
		).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
	});
});
