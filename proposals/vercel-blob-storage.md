---
title: Vercel Blob storage adapter
type: feature-plan
status: proposed
authors:
  - Ahmed Aleryani (@Ahmed-aleryani)
discussion: null
created: 2026-10-11
---

# Vercel Blob storage adapter

## Problem and user case

EmDash sites deployed to Vercel have no durable place to store media. The serverless filesystem is ephemeral and per-instance, so `local()` loses uploads between invocations. Vercel's own object store, Vercel Blob, has no S3-compatible API, so `s3()` cannot target it either. A Vercel deployment today has to use a storage provider outside Vercel (S3, R2) even when the project already has a Blob store connected.

I run a production EmDash site on Vercel that stores its media in Vercel Blob. The adapter described here has been in use there as a workspace package against EmDash 0.35, and I have ported it to the current `Storage` contract. This plan proposes publishing it from the monorepo as `@emdash-cms/vercel`.

## Proposed behavior

A new package, `@emdash-cms/vercel`, exports a config-time `vercelBlob()` function that returns a `StorageDescriptor`. It follows the same split as `@emdash-cms/cloudflare`'s `r2()`: the config entry never imports `@vercel/blob`, and the runtime implementation lives at the `@emdash-cms/vercel/storage/blob` entrypoint.

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import vercel from "@astrojs/vercel";
import emdash from "emdash/astro";
import { vercelBlob } from "@emdash-cms/vercel";

export default defineConfig({
	output: "server",
	adapter: vercel(),
	integrations: [
		emdash({
			// Private store connected to the Vercel project.
			// Media is served through /_emdash/api/media/file/<key>.
			storage: vercelBlob({ access: "private" }),

			// Or a public store served straight from the Blob CDN:
			// storage: vercelBlob({
			// 	access: "public",
			// 	publicUrl: "https://<store-id>.public.blob.vercel-storage.com",
			// }),
		}),
	],
});
```

Options:

- `access` (required): `"public"` or `"private"`. Must match the Blob store, since Vercel fixes the access mode when the store is created.
- `publicUrl` (optional, public stores only): an http or https prefix, such as the store origin or a CDN in front of it.
- `tokenEnvVar` (optional): the name of an environment variable holding a Blob read/write token, read from `process.env` at runtime.
- `storeId` (optional): the Blob store ID for OIDC authentication when `BLOB_STORE_ID` is not set.

Credentials are never part of the serialized descriptor. Without `tokenEnvVar`, `@vercel/blob` resolves credentials itself: `VERCEL_OIDC_TOKEN` when a store ID is set in `BLOB_STORE_ID` or `storeId`, then `BLOB_READ_WRITE_TOKEN`. Connecting a store to a Vercel project sets `BLOB_READ_WRITE_TOKEN`, so a site with a connected store needs no extra configuration beyond `access`.

Runtime behavior of each `Storage` method:

- `upload` buffers the body and calls `put` with `addRandomSuffix: false` and `allowOverwrite: true`, so keys are stored exactly as EmDash names them and media can be replaced in place. `contentType` is passed through. `cacheControl` is mapped to Blob's `cacheControlMaxAge`: Blob only stores a max-age with a 60 second floor, so `no-store`, `no-cache` and `max-age` below 60 become 60, and a header with no max-age keeps the Blob default of one month. It returns `getPublicUrl(key)`.
- `download` on a private store bypasses the Blob cache (`useCache: false`), so a replaced file is read back at once, matching S3, R2 and local. Public stores always read through the Blob CDN, which can return the previous file for up to 60 seconds after a replace.
- `download` sends a `Range` header for ranged reads and reports the served range from `Content-Range`. If the ranged read fails or the response is not a usable range, it falls back to the whole file. It returns `lastModified` from `Last-Modified` and the true whole-file size, calling `head()` when a chunked response has no `Content-Length`.
- `delete` succeeds when the key does not exist, as on S3.
- `exists` uses `head()`. `list` maps Blob's cursor pagination to `ListResult`.
- `getPublicUrl` returns `publicUrl` plus the key with each path segment encoded, or `/_emdash/api/media/file/<key>` when no `publicUrl` is set.
- `getSignedUploadUrl` throws `NOT_SUPPORTED`, and the admin falls back to uploading through the server.

## Goals

- Durable media storage for EmDash on Vercel using Vercel Blob, with both public and private stores.
- Zero credential configuration for the common case of a Blob store connected to the Vercel project.
- Full conformance with the current `Storage` contract, including ranged downloads used for media streaming.
- No changes to `emdash` core or other packages.

## Non-goals

- Signed or direct client uploads. A follow-up could implement `getSignedUploadUrl` with `@vercel/blob`'s client token APIs (`issueSignedToken` / `presignUrl`) together with `getClientUploadOrigin`. Until then uploads go through the server and are bounded by the Vercel Function request body limit.
- Multipart uploads for files over 100 MB.
- A Vercel deployment guide in the docs site. That can follow separately once the package is published.
- An S3-compatibility shim or changes to `s3()`.

## Interfaces and compatibility

- New package `@emdash-cms/vercel` in `packages/vercel`, with exports `.` (config-time `vercelBlob()` and `VercelBlobStorageConfig`) and `./storage/blob` (runtime `createStorage()` and `VercelBlobStorage`). This mirrors the `@emdash-cms/cloudflare` config/runtime split.
- No changes to core interfaces, configuration, stored data, or existing adapters. Existing sites are unaffected.
- New `EmDashStorageError` codes used only by this adapter: `INVALID_BLOB_CONFIG` (bad `access` or `publicUrl`) and `MISSING_BLOB_CONFIG` (`tokenEnvVar` names an unset variable). It also uses the existing codes `INVALID_PATH`, `UPLOAD_FAILED`, `DOWNLOAD_FAILED`, `NOT_FOUND`, `DELETE_FAILED`, `HEAD_FAILED`, `LIST_FAILED` and `NOT_SUPPORTED`.
- `access` is required rather than defaulted. A mismatch with the store fails every write, and a silent default of `"public"` would expose EmDash backups, which are written to the same storage, to anyone who knows their URL. Requiring the choice makes the exposure explicit. See open questions.
- New runtime dependency on `@vercel/blob` (^2.8.0). Installing it requires three `trustPolicyExclude` entries in `pnpm-workspace.yaml`: `@vercel/oidc@3.8.10`, `@vercel/cli-exec@1.0.1` and `@vercel/cli-config@0.3.1`. Each was reviewed: they are still published from GitHub Actions trusted publishers, and the trust downgrade comes from a change in the trusted-publisher config id format or provenance metadata, not a change of publisher.

## Errors and edge cases

- Keys that are empty, start with `/`, or contain empty, `.` or `..` segments are rejected with `INVALID_PATH`, because Blob would store them under a different pathname than EmDash requested or they could address another object.
- `publicUrl` with `access: "private"`, or a `publicUrl` that is not a valid http or https URL, fails at startup with `INVALID_BLOB_CONFIG`.
- `tokenEnvVar` naming an unset or empty variable fails with `MISSING_BLOB_CONFIG`, rather than silently falling back to other credentials.
- A ranged read past the end of the file (416) or any other ranged-read failure falls back to the full file instead of failing the request.
- Chunked responses without `Content-Length`, where the SDK reports size 0, use `head()` to get the real size.
- Not-found errors are detected by class and by error name, so a duplicated copy of `@vercel/blob` in the bundle still maps to `NOT_FOUND`.
- Uploads are buffered in memory before `put`. Large files are bounded by the function memory and body limits; multipart is a non-goal.
- `cacheControl` values Blob cannot represent are rounded up to the 60 second floor, so `no-store` media is still cached for 60 seconds at the Blob CDN.

## Verification

- Unit tests in `packages/vercel/tests` against an in-memory fake of `@vercel/blob` that honors `Range` and returns `Content-Range`. Cover config validation and error codes, key validation, cache-control mapping, upload options, ranged and whole-file downloads including the fallbacks and chunked size, delete of a missing key, `exists`, `list` pagination, `getPublicUrl` encoding, and `NOT_SUPPORTED` for signed uploads.
- `publint` and `attw` checks on the built package, plus typecheck and lint.
- A live test against a real public store and a real private store: upload, ranged and whole download, overwrite, list, delete, and serving through both the Blob CDN and `/_emdash/api/media/file`.
- A demo deployment on Vercel using a connected Blob store with OIDC credentials and no token configured, exercising media upload and display in the admin and on the site. A production site provides additional evidence on the 0.35 contract.

## Open questions

- Should `access` default to `"private"` instead of being required? A private default is safe for backups but fails confusingly against a public store.
- Should `@emdash-cms/vercel` join the changesets `fixed` group with `emdash` and `@emdash-cms/cloudflare`, or version independently?
- Is `@emdash-cms/vercel` the right home, or should a Blob adapter live in core next to `s3()` and `local()`? A separate package keeps `@vercel/blob` out of core installs and leaves room for other Vercel adapters.
- Should signed client uploads be in the first version, given the server upload path is bounded by the function request body limit?
