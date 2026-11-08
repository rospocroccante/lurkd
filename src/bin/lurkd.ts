#!/usr/bin/env node
import { EXIT_CODE } from '../errors.js';
import { VERSION } from '../paths.js';

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--version') {
  console.log(VERSION);
} else {
  console.error('Usage: lurkd --version');
  process.exitCode = EXIT_CODE.invalid_request;
}
