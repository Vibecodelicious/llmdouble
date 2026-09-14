// `differential` (epic C5, design §5.7): the same scenario run twice, once
// with the feature on and once with it off, on separate servers with
// separate recordings, sequentially. Nothing is shared between the arms at
// run time; only the option defaults are.
//
// Each arm takes its own `setup`, because "turn the feature off" is not
// always an environment variable, and its own `scenario`, for an off arm
// where the scripted tool is not registered.

import type { Scenario } from '../core/scenario.js';
import { run, type Exec, type RunResult } from './run.js';

/** One arm's overrides. `env` merges over the shared `env`; the rest replace the shared value. */
export interface Arm {
  exec?: Exec;
  env?: Record<string, string>;
  setup?: string;
  scenario?: string | Scenario;
}

export interface DifferentialOptions {
  on: Arm;
  off: Arm;
  /** Shared defaults, each overridable per arm. */
  exec?: Exec;
  env?: Record<string, string>;
  setup?: string;
  /** Shared by both arms. */
  cwd?: string;
  timeoutMs?: number;
}

export interface DifferentialResult {
  on: RunResult;
  off: RunResult;
}

/** Run the on arm, then the off arm, and return both recordings. */
export async function differential(scenario: string | Scenario, options: DifferentialOptions): Promise<DifferentialResult> {
  const on = await run(...armRun('on', scenario, options));
  const off = await run(...armRun('off', scenario, options));
  return { on, off };
}

/** The `run` arguments for one arm: per-arm `env` merged over shared `env`, other per-arm fields replacing shared ones. */
export function armRun(
  name: 'on' | 'off',
  scenario: string | Scenario,
  options: DifferentialOptions,
): [string | Scenario, Parameters<typeof run>[1]] {
  const arm = options[name];
  const exec = arm.exec ?? options.exec;
  if (exec === undefined) throw new Error(`differential: the ${name} arm has no exec and none is shared`);
  const setup = arm.setup ?? options.setup;
  return [
    arm.scenario ?? scenario,
    {
      exec,
      env: { ...options.env, ...arm.env },
      ...(setup === undefined ? {} : { setup }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
  ];
}
