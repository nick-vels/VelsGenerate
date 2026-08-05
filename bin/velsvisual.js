#!/usr/bin/env node
import { main } from "../src/cli.js";

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((exc) => {
    console.error(`Неожиданная ошибка: ${exc.stack || exc}`);
    process.exitCode = 1;
  });
