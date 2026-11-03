#!/usr/bin/env node
import { createProgram } from './program.js';

createProgram()
  .parseAsync(process.argv)
  .catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
