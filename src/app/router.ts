const ROUTE_NAMES = ["recording", "list", "settings"] as const;

export type RouteName = (typeof ROUTE_NAMES)[number];
export type TabRouteName = "list" | "recording";
export type AppRoute =
  | { name: "recording"; recordingId: string | null }
  | { name: "list" }
  | { name: "settings" };

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isRouteName(value: string | undefined): value is RouteName {
  return value !== undefined && ROUTE_NAMES.includes(value as RouteName);
}

export function isTabRouteName(
  value: string | undefined,
): value is TabRouteName {
  return value === "list" || value === "recording";
}

export function parseRoute(hash: string): AppRoute {
  const value = hash.replace(/^#/, "").trim();
  if (!value) {
    return { name: "list" };
  }

  const parts = value.split("/");
  const [rawName, rawId] = parts;
  if (!isRouteName(rawName)) {
    return { name: "list" };
  }
  if (rawName !== "recording") {
    if (parts.length > 1) {
      return { name: "list" };
    }
    return { name: rawName };
  }

  if (parts.length === 1) {
    return { name: "recording", recordingId: null };
  }
  if (parts.length !== 2 || !rawId || !SAFE_ID.test(rawId)) {
    return { name: "list" };
  }
  return { name: "recording", recordingId: rawId };
}

export function routeToHash(route: AppRoute): string {
  if (route.name !== "recording") {
    return `#${route.name}`;
  }
  if (!route.recordingId) {
    return "#recording";
  }
  return `#recording/${route.recordingId}`;
}

export function routeKey(route: AppRoute): string {
  if (route.name !== "recording") {
    return route.name;
  }
  return route.recordingId ? `recording:${route.recordingId}` : "recording";
}
