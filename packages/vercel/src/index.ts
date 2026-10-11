/**
 * @emdash-cms/vercel
 *
 * Vercel adapters for EmDash.
 *
 * This is the CONFIG-TIME entry point. It returns serializable descriptors and
 * never imports @vercel/blob, so it is safe to use in astro.config.mjs. The
 * runtime storage implementation lives at @emdash-cms/vercel/storage/blob.
 *
 * @example
 * ```ts
 * import emdash from "emdash/astro";
 * import { vercelBlob } from "@emdash-cms/vercel";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       storage: vercelBlob({ access: "private" }),
 *     }),
 *   ],
 * });
 * ```
 */

import type { StorageDescriptor } from "emdash";

/**
 * Vercel Blob storage configuration
 *
 * Credentials are never part of this config. At runtime the adapter reads the
 * token from the environment variable named by `tokenEnvVar`, or lets
 * `@vercel/blob` resolve credentials itself: a Vercel OIDC token with
 * `BLOB_STORE_ID`, then `BLOB_READ_WRITE_TOKEN`.
 */
export interface VercelBlobStorageConfig {
	/**
	 * Access mode of the Blob store. It must match the store: Vercel fixes it
	 * when the store is created.
	 *
	 * Use `"private"` unless media must be served straight from the Blob CDN.
	 * EmDash writes backups to the same storage, and every object in a public
	 * store can be read by anyone who knows its URL.
	 */
	access: "public" | "private";
	/**
	 * Public URL prefix for media, such as the store's
	 * `https://<store-id>.public.blob.vercel-storage.com` origin or a CDN in
	 * front of it. Only valid with `access: "public"`. When omitted, EmDash
	 * serves files through `/_emdash/api/media/file`.
	 */
	publicUrl?: string;
	/**
	 * Name of an environment variable that holds a Blob read/write token. Read
	 * from `process.env` at runtime. When omitted, `@vercel/blob` resolves
	 * credentials from its default environment variables.
	 */
	tokenEnvVar?: string;
	/**
	 * Blob store ID for OIDC authentication, when `BLOB_STORE_ID` is not set.
	 * Ignored when `tokenEnvVar` supplies a read/write token.
	 */
	storeId?: string;
}

/**
 * Vercel Blob storage adapter
 *
 * @example
 * ```ts
 * // Private store, credentials from the project's connected Blob store
 * storage: vercelBlob({ access: "private" })
 *
 * // Public store served from the Blob CDN
 * storage: vercelBlob({
 *   access: "public",
 *   publicUrl: "https://abc123.public.blob.vercel-storage.com",
 * })
 * ```
 */
export function vercelBlob(config: VercelBlobStorageConfig): StorageDescriptor {
	return {
		entrypoint: "@emdash-cms/vercel/storage/blob",
		config: {
			access: config.access,
			publicUrl: config.publicUrl,
			tokenEnvVar: config.tokenEnvVar,
			storeId: config.storeId,
		},
	};
}
