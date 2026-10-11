import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/storage/blob.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
});
