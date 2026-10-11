/**
 * Live tests against a real Vercel Blob store. Skipped unless
 * EMDASH_TEST_BLOB_ACCESS is set to the store's access mode ("public" or
 * "private") and Blob credentials are in the environment: either
 * BLOB_READ_WRITE_TOKEN, or VERCEL_OIDC_TOKEN with BLOB_STORE_ID.
 *
 * Every object is written under a unique prefix and deleted afterwards.
 */

import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createStorage } from "../../src/storage/blob.js";

const access = process.env.EMDASH_TEST_BLOB_ACCESS;
const live = access === "public" || access === "private";
const prefix = `emdash-live-test/${randomUUID()}/`;

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
	return new Response(stream).text();
}

describe.skipIf(!live)(`VercelBlobStorage against a live ${access} store`, () => {
	// Vitest collects skipped suites too, so only build the adapter when live.
	const storage = live ? createStorage({ access }) : undefined!;
	const key = `${prefix}clip.bin`;

	afterAll(async () => {
		if (!live) return;
		const { files } = await storage.list({ prefix });
		await Promise.all(files.map((file) => storage.delete(file.key)));
	});

	it("uploads and reads back the whole file", async () => {
		const result = await storage.upload({
			key,
			body: new TextEncoder().encode("0123456789"),
			contentType: "application/octet-stream",
		});
		expect(result.size).toBe(10);
		expect(await storage.exists(key)).toBe(true);

		const download = await storage.download(key);
		expect(await text(download.body)).toBe("0123456789");
		expect(download.size).toBe(10);
		expect(download.lastModified).toBeInstanceOf(Date);
	});

	it("serves byte ranges with the whole-file size", async () => {
		const middle = await storage.download(key, { range: { offset: 2, length: 3 } });
		expect(await text(middle.body)).toBe("234");
		expect(middle).toMatchObject({ size: 10, range: { offset: 2, length: 3 } });

		const tail = await storage.download(key, { range: { suffix: 4 } });
		expect(await text(tail.body)).toBe("6789");
		expect(tail).toMatchObject({ size: 10, range: { offset: 6, length: 4 } });

		const open = await storage.download(key, { range: { offset: 7 } });
		expect(await text(open.body)).toBe("789");
		expect(open.range).toEqual({ offset: 7, length: 3 });
	});

	it("returns the whole file for a range past the end", async () => {
		const result = await storage.download(key, { range: { offset: 50 } });
		expect(await text(result.body)).toBe("0123456789");
		expect(result.range).toBeUndefined();
	});

	it("replaces a file in place", async () => {
		await storage.upload({
			key,
			body: new TextEncoder().encode("replaced"),
			contentType: "application/octet-stream",
			cacheControl: "public, max-age=0, must-revalidate",
		});
		const download = await storage.download(key);
		expect(await text(download.body)).toBe("replaced");
		expect(download.size).toBe(8);
	});

	it("reads back a key that contains a URL delimiter", async () => {
		const hashKey = `${prefix}photo.png#1`;
		await storage.upload({
			key: hashKey,
			body: new TextEncoder().encode("hash"),
			contentType: "image/png",
		});
		expect(await text((await storage.download(hashKey)).body)).toBe("hash");
		await storage.delete(hashKey);
	});

	it("reports the stored size of a text file", async () => {
		const textKey = `${prefix}notes.txt`;
		const body = "plain text ".repeat(200);
		await storage.upload({
			key: textKey,
			body: new TextEncoder().encode(body),
			contentType: "text/plain",
		});
		const download = await storage.download(textKey);
		expect(await text(download.body)).toBe(body);
		expect(download.size).toBe(body.length);
		await storage.delete(textKey);
	});

	it("lists, deletes, and reports missing files", async () => {
		const { files } = await storage.list({ prefix });
		expect(files.map((file) => file.key)).toEqual([key]);

		await storage.delete(key);
		expect(await storage.exists(key)).toBe(false);
		await expect(storage.download(key)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(storage.delete(key)).resolves.toBeUndefined();
	});
});
