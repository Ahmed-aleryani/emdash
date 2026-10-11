---
"@emdash-cms/vercel": minor
---

Adds the `@emdash-cms/vercel` package with a `vercelBlob()` storage adapter, so sites can store media in a Vercel Blob store.

```ts
import { vercelBlob } from "@emdash-cms/vercel";

storage: vercelBlob({ access: "private" });
```

`access` is required and must match the store. On Vercel, the adapter uses the credentials of the Blob store connected to the project; on other hosts, set `BLOB_READ_WRITE_TOKEN` or name another variable with `tokenEnvVar`. Public stores can serve media from the Blob CDN with `publicUrl`; private stores serve it through EmDash's media route. The adapter supports byte-range downloads. It does not support signed upload URLs, so the admin uploads files through the server.
