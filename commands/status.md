---
description: 看 SDD 這輪跑到哪（用法：/sdd-graph:status --task <taskName>）
argument-hint: --task <taskName>
---

本指令**不會推進任何階段**。它只回報現況：

1. 執行 sdd-graph status --task <taskName>（<taskName> 取自本指令的引數），讀 stdout 的 JSON 信封。
2. 把下列三件事回報給使用者：
   - **階段**：信封的 `stage`（目前圖停在哪一個階段）。
   - **待處理的中斷**：信封的 `pending` —— `null` 表示沒有待處理的單；
     否則是 `{ audience, type }`：`audience=user` 是要問使用者的閘口，
     `audience=host` 是要本會話做的工作單。
   - **分支鎖**：信封的 `lock` —— `path` 是那把鎖的檔案（就地模式在
     `<業務倉庫>/.sdd/branch-lock.json`、克隆模式在
     `<外掛根>/runtime/branch-runtime-lock.json`）；`running` 是它有沒有被握著，
     被握著時還有 `taskName`、`branch`、`startedAt`（誰握著它、在哪條分支上、
     什麼時候開始的）。
3. **需求文件**：`docs/<taskName>/workflow-state.json` 是給人看的鏡像，
   跟 checkpoint 對不上時以 checkpoint（`sdd-graph status` 的輸出）為準。

禁止：為了「順便推進一下」而執行 start／resume／complete／approve。
本指令只讀；要推進請用 `/sdd-graph:start` 或 `/sdd-graph:resume`。
