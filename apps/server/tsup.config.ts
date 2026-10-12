import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    "main-api": "src/main-api.ts",
    "main-worker": "src/main-worker.ts",
    migrate: "src/scripts/migrate.ts",
    "grant-admin": "src/scripts/grant-admin.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle the workspace package (source-only TS); keep npm deps external.
  noExternal: [/^@notetaker\//],
});
