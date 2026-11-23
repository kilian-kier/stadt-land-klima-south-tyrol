import { z } from "zod";

/**
 * GET /api/version
 *
 * Returns the current release version information.
 * This endpoint is populated at build time from environment variables.
 */

const VersionResponseSchema = z.object({
  commit: z.string(),
  release: z.string(),
  builtAt: z.string(),
});

export type VersionResponse = z.infer<typeof VersionResponseSchema>;

export default defineEventHandler((event): VersionResponse => {
  const config = useRuntimeConfig(event);

  const response = {
    commit: config.public.releaseCommit,
    release: config.public.releaseTag,
    builtAt: config.public.releaseBuiltAt,
  };

  // Validate response schema
  const validated = VersionResponseSchema.parse(response);

  // Set caching headers - no-store for always fresh version info
  setHeader(event, "Cache-Control", "no-store");

  return validated;
});
