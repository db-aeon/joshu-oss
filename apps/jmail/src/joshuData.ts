/**
 * jMail platform data client — single entry for connectors, Nylas, identity.
 */
import { createJoshuPlatformData } from "@joshu/platform-data";

export const platform = createJoshuPlatformData({ apiBase: "/joshu/api" });
