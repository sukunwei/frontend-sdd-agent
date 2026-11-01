---
description: 停掉 SDD 這輪並釋放分支鎖（用法：/sdd-graph:stop --task <taskName>）
argument-hint: --task <taskName>
---

1. 執行 sdd-graph stop --task <taskName>（<taskName> 取自本指令的引數）。
2. 把結果回報給使用者：**分支鎖已經釋放**，別的 task 可以接手同一個倉庫。

**鎖與 checkpoint 的位置依模式而不同**：

| | 就地模式（預設） | 克隆模式（`--repo <url>`） |
|---|---|---|
| 分支鎖 | `<業務倉庫>/.sdd/branch-lock.json` | `<外掛根>/runtime/branch-runtime-lock.json` |
| checkpoint | `<業務倉庫>/.sdd/checkpoints.sqlite` | `<外掛根>/runtime/checkpoints.sqlite` |

就地模式的鎖是**按倉庫**的（同一個倉庫裡一次只有一輪能跑，不同倉庫互不影響）；
克隆模式的鎖是**全域**的（所有倉庫共用一把）。`stop` 找鎖的順序是：先找「握著這個
task 的鎖」，找不到才找「存在的那一把」——**要停哪一輪，就在那一輪所在的目錄裡執行**。

`stop` **只釋放分支鎖**：

- **checkpoint 保留** —— 這一輪的進度還在，之後用 `/sdd-graph:resume --task <taskName>`
  可以從 checkpoint 拿到同一張未完成的工作單。
- **工作區保留**，但兩種模式留下的東西不同：
  - **就地模式沒有 workspace 副本** —— 留下來的是你業務倉庫裡**已經寫出的檔案**
    （程式碼、`docs/<taskName>/`）。插件**不會**刪它們。
  - **克隆模式**留下 `workspace/tasks/<taskName>/`（複製出來的 repo 與已寫出的需求文件）。
- 想從頭再來一輪（連 checkpoint 與工作區一起丟掉），要用 reset：
  在 `start` 的 `already_exists` 閘口選 `reset`，而不是刪檔案。
  **就地模式的 reset 只清 `.sdd/` 底下這個 task 的運行時狀態** —— `docs/<taskName>/`、
  分支與程式碼都不動，那些產物要你自己收拾。

**`--force` 不再能搶別的 task 的鎖**（行為變更）：別的活著的 task 握著那把鎖時，
`stop` 會報錯（`lock_not_owned`）——請先把那個 task 停掉：
`sdd-graph stop --task <那個 task>`。以前 `--force` 能把別的 task 的鎖刪掉，那等於
替別人中止了他正在跑的那一輪；而鎖現在是**按倉庫**的，搶錯倉庫的鎖更危險。
`--force` 留給「已經沒有活著的持有者」的鎖（自己的、壞掉的、已停的）。

禁止：手動改 `workflow-state.json`、手動刪 checkpoint、手動改 lock 檔。
