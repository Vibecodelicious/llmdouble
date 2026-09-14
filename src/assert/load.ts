// `load(path)` (epic C4): parse a C3 recording file into a `Recording`.
//
// The reader tolerates a missing `summary` line, so a recording written by a
// run that crashed still loads (`summary.complete === false`, counts computed
// from the request lines). A file whose first line is not a `run` line with
// `format: 1`, or that has any malformed line, is rejected with the line
// number.

import { readRecording } from '../core/recording.js';
import { Recording } from './recording.js';

/** Parse a recording file. */
export function load(path: string): Recording {
  return new Recording(readRecording(path), path);
}
