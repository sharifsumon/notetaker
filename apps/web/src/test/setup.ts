import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";
import { setCsrfToken } from "../lib/api";
import { server } from "./harness";

// jsdom lacks media playback; stub it so <audio> renders without errors.
Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => undefined });
Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: () => Promise.resolve() });
Element.prototype.scrollIntoView = () => undefined;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  setCsrfToken(null);
});
afterAll(() => server.close());
