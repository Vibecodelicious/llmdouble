// `run` (epic C5): start the server on an ephemeral port, substitute `$URL`,
// execute the system under test, stop the server, and hand back the loaded
// recording with the process's exit code.
//
// A string `exec` runs under `sh -c` in its own process group, so a timeout
// can kill everything it started; a function `exec` is called with the url
// and awaited, for drivers that run several processes against one server.
// A non-zero exit is data (`exitCode`), never an exception. A timeout kills
// the process group, closes the server so the recording is complete, and
// throws with the recording path. A server failure (core/server.ts) aborts
// the run the moment it happens rather than at the timeout.

import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import type { Recording } from '../assert/recording.js';
import type { Scenario } from '../core/scenario.js';
import { startServer } from '../core/server.js';

/** The default `timeoutMs`: two minutes for `setup` and `exec` together. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** How long a killed process group gets to leave on SIGTERM before SIGKILL. */
const TERM_GRACE_MS = 1000;

/** A shell command (`sh -c`, `$URL` substituted) or a function called with the server's url and awaited. */
export type Exec = string | ((ctx: { url: string }) => Promise<void>);

export interface RunOptions {
  /** What to execute against the server. */
  exec: Exec;
  /** Environment for `setup` and `exec`, over the current process's; `$URL` is substituted in every value. */
  env?: Record<string, string>;
  /**
   * A shell command run before `exec` with the same env and cwd; `$URL` substituted. A non-zero exit fails the run.
   * Its process group is swept when it exits, like `exec`'s: anything that must outlive `setup` belongs in `exec`
   * (or a function `exec`).
   */
  setup?: string;
  /** Working directory for `setup` and `exec`; default the current directory. */
  cwd?: string;
  /** Wall-clock budget for `setup` and `exec` together; default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** The recording path; default a file under the OS temp directory. */
  record?: string;
}

/** The recording, plus the exit code of `exec`: null for a function `exec` or a process that ended by signal. */
export type RunResult = Recording & { exitCode: number | null };

/** Replace every `$URL` (a whole token: `$URLS` and `$URL_X` are left alone) with the server's url. */
export function substituteUrl(text: string, url: string): string {
  return text.replace(/\$URL\b/g, url);
}

/** `substituteUrl` over every value. */
export function substituteEnv(env: Record<string, string>, url: string): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, substituteUrl(value, url)]));
}

/** Where `run` writes the command's stdout and stderr: next to the recording. */
export function logPaths(recordPath: string): { stdout: string; stderr: string } {
  const base = recordPath.replace(/\.jsonl$/, '');
  return { stdout: `${base}.stdout.log`, stderr: `${base}.stderr.log` };
}

/** Run the system under test against a live server and return what it sent (epic C5). */
export async function run(scenario: string | Scenario, options: RunOptions): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const control = new AbortController();
  const state: { failure: Error | null } = { failure: null };
  const server = await startServer({
    scenario,
    record: options.record,
    onError: (error) => {
      state.failure = error;
      control.abort();
    },
  });
  const deadline = Date.now() + timeoutMs;
  const logs = logPaths(server.recordPath);
  const shell: ShellOptions = {
    cwd: options.cwd,
    env: { ...process.env, ...substituteEnv(options.env ?? {}, server.url) },
    logs,
    deadline,
    signal: control.signal,
  };
  let exitCode: number | null = null;
  let error: unknown = null;
  try {
    // Written fresh by each run, like the recording; setup and exec then append to them in order.
    writeFileSync(logs.stdout, '');
    writeFileSync(logs.stderr, '');
    if (options.setup !== undefined) {
      const setup = await runShell(substituteUrl(options.setup, server.url), shell);
      if (setup.timedOut) throw new TimedOut();
      if (setup.exitCode !== 0) throw new Error(`setup exited with ${setup.exitCode ?? 'a signal'} (recording: ${server.recordPath})`);
    }
    if (typeof options.exec === 'function') {
      await within(options.exec({ url: server.url }), deadline, control.signal);
    } else {
      const result = await runShell(substituteUrl(options.exec, server.url), shell);
      if (result.timedOut) throw new TimedOut();
      exitCode = result.exitCode;
    }
  } catch (caught) {
    error = caught;
  }
  if (state.failure !== null) {
    await server.close().catch(() => undefined);
    throw new Error(`llmdouble server failed during the run: ${state.failure.message} (recording: ${server.recordPath})`, {
      cause: state.failure,
    });
  }
  if (error instanceof TimedOut) {
    await server.close().catch(() => undefined);
    throw new Error(`run timed out after ${timeoutMs} ms; the process group was killed (recording: ${server.recordPath})`);
  }
  if (error !== null) {
    await server.close().catch(() => undefined);
    throw error;
  }
  const recording = await server.close();
  return Object.assign(recording, { exitCode });
}

class TimedOut extends Error {}

interface ShellOptions {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  logs: { stdout: string; stderr: string };
  deadline: number;
  signal: AbortSignal;
}

interface ShellResult {
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * `sh -c command` in its own process group, stdout and stderr appended to the log files. The group is killed
 * (SIGTERM, then SIGKILL after a grace period) at the deadline or on abort; whatever the command left behind
 * in its group when it exited is killed too, so a run never leaves stragglers.
 */
function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const stdout = openSync(options.logs.stdout, 'a');
    const stderr = openSync(options.logs.stderr, 'a');
    const child = spawn('sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', stdout, stderr],
      detached: true,
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const kill = (): void => {
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), TERM_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(0, options.deadline - Date.now()));
    options.signal.addEventListener('abort', kill, { once: true });
    if (options.signal.aborted) kill();
    const done = (): void => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      options.signal.removeEventListener('abort', kill);
      closeSync(stdout);
      closeSync(stderr);
    };
    child.once('error', (error) => {
      done();
      reject(error);
    });
    child.once('exit', (code) => {
      done();
      killGroup(child.pid, 'SIGKILL');
      resolve({ exitCode: code, timedOut });
    });
  });
}

/** Signal a whole process group; a group that no longer exists is not an error. */
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}

/** Settle with `promise`, or reject at the deadline or on abort. The work itself cannot be cancelled. */
function within<T>(promise: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut()), Math.max(0, deadline - Date.now()));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('run aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
