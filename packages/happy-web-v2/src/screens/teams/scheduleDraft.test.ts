import { describe, expect, it } from "vitest";
import { scheduleAction } from "./scheduleDraft";
const draft = {
  name: " reminder ",
  botId: "bot",
  body: " Review results ",
  localTime: "2026-09-12T10:30",
  intervalMinutes: "",
};
describe("schedule input", () => {
  it("converts local time once and keeps one-shot schedules non-recurring", () => {
    expect(scheduleAction(draft)).toEqual({
      type: "schedule-create",
      name: "reminder",
      botId: "bot",
      body: "Review results",
      runAt: new Date(draft.localTime).getTime(),
    });
  });
  it("converts whole minutes while rejecting invalid or sub-minute recurrence", () => {
    expect(
      scheduleAction({ ...draft, intervalMinutes: "10" })?.intervalMs,
    ).toBe(600000);
    for (const intervalMinutes of ["0", "-1", "0.5", "NaN", "527041"])
      expect(scheduleAction({ ...draft, intervalMinutes })).toBeNull();
  });
  it("rejects invalid dates and missing recipient instead of submitting NaN", () => {
    expect(scheduleAction({ ...draft, localTime: "bad" })).toBeNull();
    expect(scheduleAction({ ...draft, botId: "" })).toBeNull();
  });
});
