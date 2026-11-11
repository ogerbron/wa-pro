import { describe, it, expect } from "vitest";
import { startObserverMonitor } from "../src/observer/monitor.js";

describe("Observer Monitor", () => {
  describe("safety guarantees", () => {
    it("startObserverMonitor is a function", () => {
      expect(typeof startObserverMonitor).toBe("function");
    });

    it("module exports no send methods", async () => {
      const monitorModule = await import("../src/observer/monitor.js");
      const exportedNames = Object.keys(monitorModule);

      // Verify NO send-related exports exist
      const sendRelated = exportedNames.filter(
        (name) =>
          name.toLowerCase().includes("send") ||
          name.toLowerCase().includes("reply") ||
          name.toLowerCase().includes("respond"),
      );

      expect(sendRelated).toEqual([]);
    });

    it("exports only expected functions", async () => {
      const monitorModule = await import("../src/observer/monitor.js");
      const exportedNames = Object.keys(monitorModule).sort();
      expect(exportedNames).toEqual(["attachObserverListeners", "getObserverSocket", "processObserverMessage", "requestBackfill", "startObserverMonitor"]);
    });
  });
});
