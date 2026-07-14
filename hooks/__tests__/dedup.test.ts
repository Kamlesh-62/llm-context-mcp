import { describe, it, expect } from "vitest";
import { classifyCandidate, jaccardSimilarity } from "../dedup.js";

describe("jaccardSimilarity", () => {
  it("is 1 for identical strings and 0 for disjoint", () => {
    expect(jaccardSimilarity("added dependency zod", "added dependency zod")).toBe(1);
    expect(jaccardSimilarity("alpha beta", "gamma delta")).toBe(0);
  });

  it("ignores empty tokens", () => {
    expect(jaccardSimilarity("", "")).toBe(0);
  });
});

describe("classifyCandidate", () => {
  it("ADDs when nothing similar exists", () => {
    const d = classifyCandidate(
      [{ title: "Chose vitest", type: "decision" }],
      { title: "node version: 24.0.0", type: "fact" },
    );
    expect(d.action).toBe("add");
  });

  it("SKIPs a near-identical candidate", () => {
    const d = classifyCandidate(
      [{ title: "Added dependency: zod", type: "fact" }],
      { title: "Added dependency: zod", type: "fact" },
    );
    expect(d.action).toBe("skip");
  });

  it("UPDATEs a moderately similar candidate of the same type", () => {
    const d = classifyCandidate(
      [{ title: "node version is 22.1.0 here", type: "fact" }],
      { title: "node version is 24.0.0 here", type: "fact" },
    );
    expect(d).toEqual({ action: "update", index: 0 });
  });

  it("does not UPDATE across differing types", () => {
    const d = classifyCandidate(
      [{ title: "use redis for caching now", type: "decision" }],
      { title: "use redis for caching now", type: "fact" },
    );
    // identical title -> >=0.9 -> skip regardless of type
    expect(d.action).toBe("skip");
  });

  it("picks the closest existing item to update", () => {
    const d = classifyCandidate(
      [
        { title: "totally unrelated topic here", type: "fact" },
        { title: "postgres connection pool size setting", type: "fact" },
      ],
      { title: "postgres connection pool size limit", type: "fact" },
    );
    expect(d).toEqual({ action: "update", index: 1 });
  });
});
