import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { SCHEMA_REGISTRY, type SchemaName } from "./schemas.ts";

export interface SchemaPaths {
  /** Absolute path to the schemas directory on disk. */
  dir: string;
  /** Map of schema name → absolute file path. */
  files: Record<SchemaName, string>;
  /** Map of schema name → file:// URL embedded into output YAML. */
  urls: Record<SchemaName, string>;
}

const SCHEMAS_DIR_NAME = "schemas";

export async function writeJsonSchemas(cwd: string = process.cwd()): Promise<SchemaPaths> {
  const dir = resolve(cwd, SCHEMAS_DIR_NAME);
  await mkdir(dir, { recursive: true });

  const files = {} as Record<SchemaName, string>;
  const urls = {} as Record<SchemaName, string>;

  for (const [name, entry] of Object.entries(SCHEMA_REGISTRY) as Array<[
    SchemaName,
    (typeof SCHEMA_REGISTRY)[SchemaName],
  ]>) {
    // io: "input" — fields with .default() are NOT marked required in the
    // generated JSON Schema, so the YAML extension doesn't complain when a
    // user (or our pull's strip-defaults) omits them.
    const jsonSchema = z.toJSONSchema(entry.schema, { target: "draft-7", io: "input" });
    const filePath = join(dir, entry.fileName);
    await Bun.write(filePath, JSON.stringify(jsonSchema, null, 2) + "\n");
    files[name] = filePath;
    urls[name] = pathToFileURL(filePath).toString();
  }

  return { dir, files, urls };
}
