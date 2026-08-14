// Single inbox-watcher owner for concurrent serve:runtime children. Inbox claims are already
// fenced, but two chokidar processes still double-drain and double-retry. The winner watches;
// a loser retries on the same 5-minute cadence as maintenance takeover. The lock lives in the
// app-role child (not the supervisor) so filing stays off the owner DSN.

import { Cron } from "croner";
import { type WatcherLockHandle, releaseWatcherLock, tryAcquireWatcherLock } from "../db/repo";
import { config } from "../util/config";
import { startWatcher } from "./watcher";

const WATCHER_RETRY_CRON = "*/5 * * * *";

export interface InboxWatcherSchedule {
  close(): Promise<void>;
}

export interface InboxWatcherCron {
  stop(): void;
}

export type InboxWatcherCronFactory = (
  pattern: string,
  options: { timezone: string },
  callback: () => void,
) => InboxWatcherCron;

export type InboxWatcherStarter = () => Promise<{ close: () => Promise<void> }>;

const defaultCron: InboxWatcherCronFactory = (pattern, options, callback) =>
  new Cron(pattern, options, callback);

export async function startOwnedInboxWatcher(
  createCron: InboxWatcherCronFactory = defaultCron,
  start: InboxWatcherStarter = startWatcher,
): Promise<InboxWatcherSchedule> {
  const crons: InboxWatcherCron[] = [];
  const active = new Set<Promise<unknown>>();
  let lock: WatcherLockHandle | null = null;
  let watcher: { close: () => Promise<void> } | undefined;
  let retry: InboxWatcherCron | undefined;

  const run = (work: () => Promise<unknown>) => {
    const task = work().catch(() => {});
    active.add(task);
    void task.finally(() => active.delete(task));
  };

  const becomeOwner = async (): Promise<void> => {
    watcher = await start();
    console.error("[minime] inbox watcher started");
  };

  const attemptTakeover = async (): Promise<void> => {
    const handle = await tryAcquireWatcherLock();
    if (!handle) return;
    lock = handle;
    retry?.stop();
    try {
      await becomeOwner();
    } catch (error) {
      lock = null;
      await releaseWatcherLock(handle);
      throw error;
    }
  };

  const initial = await tryAcquireWatcherLock();
  if (initial) {
    lock = initial;
    try {
      await becomeOwner();
    } catch (error) {
      lock = null;
      await releaseWatcherLock(initial);
      throw error;
    }
  } else {
    console.error("[minime] inbox watcher owned by another process");
    retry = createCron(WATCHER_RETRY_CRON, { timezone: config.tz }, () => run(attemptTakeover));
    crons.push(retry);
  }

  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        retry?.stop();
        await Promise.allSettled([...active]);
        for (const cron of crons) cron.stop();
        await Promise.allSettled([watcher?.close()]);
        if (lock) {
          const handle = lock;
          lock = null;
          await releaseWatcherLock(handle);
        }
      })();
      return closing;
    },
  };
}
