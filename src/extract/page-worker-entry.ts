import { parentPort } from 'node:worker_threads';
import { LurkdError } from '../errors.js';
import { readabilityThread } from './generic.js';
import type { PageTask, ThreadPageResult, WorkerReply } from './page-worker.js';
import { pageFingerprint, parseSelectorPage, parseThreadList, selectorPosts } from './selectors.js';

// The worker side of src/extract/page-worker.ts: one page task, one reply, then the parent
// terminates the worker. Errors go back as code, message and details; a LurkdError keeps its code.

function run(task: PageTask): unknown {
  switch (task.kind) {
    case 'thread': {
      const page = parseSelectorPage(task.html, task.pageUrl, task.sel, task.source);
      const result: ThreadPageResult = {
        title: page.title,
        next: page.next,
        posts: selectorPosts(page, task.pageNo, task.source, task.previous),
        fingerprint: pageFingerprint(page.posts),
      };
      return result;
    }
    case 'list':
      return parseThreadList(task.html, task.pageUrl, task.sel, task.source);
    case 'readability':
      return readabilityThread(task.html, task.url);
  }
}

const port = parentPort;
if (port !== null) {
  port.on('message', (task: PageTask) => {
    let reply: WorkerReply;
    try {
      reply = { ok: true, result: run(task) };
    } catch (e) {
      reply =
        e instanceof LurkdError
          ? { ok: false, code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) }
          : { ok: false, code: 'extraction_failed', message: `Reading the page failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
    }
    port.postMessage(reply);
  });
  port.postMessage({ ready: true } satisfies WorkerReply);
}
