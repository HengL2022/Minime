// Single inbox-watcher owner: two runtime children must not both chokidar the same inbox.
// Injects a fake cron + fake startWatcher so takeover is deterministic (same pattern as
// test/maintenance-lock.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { startOwnedInboxWatcher } from "../src/pipeline/watcher-owner";
import { resetDb } from "./helpers";

interface FakeCronRegistration {
  pattern: string;
  fire: () => void;
  stopped: boolean;
}

function fakeCronFactory() {
  const registrations: FakeCronRegistration[] = [];
  const factory = (pattern: string, _options: { timezone: string }, callback: () => void) => {
    const entry: FakeCronRegistration = {
      pattern,
      fire: () => callback(),
      stopped: false,
    };
    registrations.push(entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
    };
  };
  return { factory, registrations };
}

function fakeWatcherStarter() {
  let starts = 0;
  let live = 0;
  const start = async () => {
    starts += 1;
    live += 1;
    return {
      close: async () => {
        live -= 1;
      },
    };
  };
  return {
    start,
    counts: () => ({ starts, live }),
  };
}

describe("single inbox watcher owner", () => {
  const live: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    await resetDb();
  });

  afterEach(async () => {
    await Promise.all(live.splice(0).map((s) => s.close()));
  });

  function track<T extends { close: () => Promise<void> }>(schedule: T): T {
    live.push(schedule);
    return schedule;
  }

  test("a second child does not start a watcher while the first holds the lock", async () => {
    const cronA = fakeCronFactory();
    const watchA = fakeWatcherStarter();
    track(await startOwnedInboxWatcher(cronA.factory, watchA.start));
    expect(watchA.counts()).toEqual({ starts: 1, live: 1 });
    expect(cronA.registrations).toHaveLength(0);

    const cronB = fakeCronFactory();
    const watchB = fakeWatcherStarter();
    track(await startOwnedInboxWatcher(cronB.factory, watchB.start));
    expect(watchB.counts()).toEqual({ starts: 0, live: 0 });
    expect(cronB.registrations).toHaveLength(1);
    expect(cronB.registrations[0]!.pattern).toBe("*/5 * * * *");
  });

  test("the loser takes over after the winner closes", async () => {
    const cronA = fakeCronFactory();
    const watchA = fakeWatcherStarter();
    const scheduleA = track(await startOwnedInboxWatcher(cronA.factory, watchA.start));

    const cronB = fakeCronFactory();
    const watchB = fakeWatcherStarter();
    const scheduleB = track(await startOwnedInboxWatcher(cronB.factory, watchB.start));
    expect(watchB.counts().starts).toBe(0);

    await scheduleA.close();
    expect(watchA.counts().live).toBe(0);

    cronB.registrations[0]!.fire();
    await scheduleB.close();
    expect(watchB.counts()).toEqual({ starts: 1, live: 0 });
  });

  test("close releases the lock so the next child acquires it immediately", async () => {
    const first = fakeWatcherStarter();
    const scheduleA = track(await startOwnedInboxWatcher(fakeCronFactory().factory, first.start));
    await scheduleA.close();

    const second = fakeWatcherStarter();
    track(await startOwnedInboxWatcher(fakeCronFactory().factory, second.start));
    expect(second.counts()).toEqual({ starts: 1, live: 1 });
  });
});
