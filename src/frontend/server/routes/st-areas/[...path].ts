import { stAreasResponse } from "~/server/utils/stAreas";

/** South Tyrol areas in the Stadt.Land.Zahl API format (server/utils/stAreas.ts). */
export default defineEventHandler((event) => {
  const { status, body } = stAreasResponse(event.method, event.path);
  setResponseStatus(event, status);
  setResponseHeader(event, "cache-control", status === 200 ? "public, max-age=3600" : "no-store");
  return body;
});
