---
description: 停掉 SDD 這輪並釋放分支鎖（用法：/sdd-graph:stop --task <taskName>）
argument-hint: --task <taskName>
---

1. 執行 sdd-graph stop --task <taskName>（<taskName> 取自本指令的引數）。
2. 把結果回報給使用者：分支鎖（`runtime/branch-runtime-lock.json`）已經釋放，
   別的 task 可以接手同一個 repo。

`stop` **只釋放分支鎖**：

- **checkpoint 保留**（`runtime/checkpoints.sqlite`）—— 這一輪的進度還在，
  之後用 `/sdd-graph:resume --task <taskName>` 可以從 checkpoint 拿到同一張未完成的工作單。
- **工作區保留**（`workspace/tasks/<taskName>/`）—— 複製出來的 repo 與已寫出的需求文件都還在。
- 想從頭再來一輪（連 checkpoint 與工作區一起丟掉），要用 reset：
  在 `start` 的 `already_exists` 閘口選 `reset`，而不是刪檔案。

禁止：手動改 `workflow-state.json`、手動刪 checkpoint、手動改 lock 檔。
