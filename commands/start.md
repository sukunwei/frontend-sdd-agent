---
description: 啟動 SDD 工作單循環（用法：/sdd-graph:start --task <taskName> [--repo <url>]）
argument-hint: --task <taskName> [--repo <url>]
---

這個指令是**一次新的需求**。圖會先問使用者要什麼（PRD、設計、其他文件），
然後一階段一階段往下走；每一段要你決定的時候會停下來問你。

**必須在業務代碼倉庫的目錄裡執行。** 兩種模式由 `--repo` 決定：

- **省略 `--repo`（預設）＝ 就地工作**：程式碼與 `docs/<taskName>/` **直接寫進你
  現在所在的這個倉庫**；運行時狀態（checkpoint、分支鎖）在 `<倉庫>/.sdd/` 之下。
- **`--repo <url>`（含 `file://`）＝ 克隆模式**（舊的用法）：把倉庫複製一份到外掛的
  workspace 裡，在副本裡幹活；運行時狀態在外掛根的 `runtime/` 之下。
- **`--repo <本地路徑>` 只接受 cwd 所在的那個倉庫**（`--repo .` 可以）。指向別的
  倉庫會被拒絕（錯誤訊息：「就地模式要求在業務倉庫目錄裡執行」）。

**為什麼不讓 `--repo` 指向別的倉庫**：那條路徑會造成「啟動了卻再也找不到」的 run ——
在 repo A 啟動、在 repo B 裡 resume，這輪 run 會被綁到 B 的同名 task 上（模式跟
`start` 設的不一樣），而 A 裡再也沒有它。

**就地模式不會替你做的事**（跑完的樣子；細節見 README 的「就地模式不做的事」）：

- **不自動 commit / push**：外掛自己**不會** `git commit`、**不會** `git push`；跑完停在
  `task/<taskName>` 分支上，產物留在那裡等你 review 之後自己提交、合併。
  （工作單的工人會照 `prompts/developer.md` 的規則把自己的改動 commit 在那條分支上。）
- **不自動回滾**：task 連續失敗兩次時，圖**不會**把你的程式碼還原（就地模式也不打
  `sdd/task/*` tag）——**壞代碼原樣留在你的倉庫裡**，由你手動收拾；閘門只會問你
  接下來怎麼走。
- **不 stash 你的改動**：工作區有**已跟蹤文件**被改過時會停下來問使用者；未跟蹤的
  檔案不算髒，不攔。
- **不改你的 `.gitignore`**（只在輸出裡給一行提示）、**不刪你的東西**。

第 1 步的 `--repo` 是**選用的**：**本指令的引數沒有 `--repo` 時就不要帶它**執行
（那就是就地模式）。`start` 的輸出可能帶著一行提示，要你把 `/.sdd/` 加進 `.gitignore`
——那是提示不是錯誤，照樣轉達給使用者（插件不改他的 .gitignore）。

LOOP:
  1. 執行 sdd-graph start --task <taskName> --repo <repoUrl>（<taskName> 與 <repoUrl> 取自本指令的引數）
  2. 依退出碼分支：
     - exit 0：階段已完成，向使用者回報，結束
     - exit 2：讀 stdout 的 JSON 信封，依 audience 分支
         · audience=user：把 payload 的 question（有的話）與 options 問使用者；
           payload 的 answer 說明答案的形狀 —— **照那個形狀組成 payload**，
           不要自己改字段名，也不要把答案改寫成摘要；
           使用者答完後執行 sdd-graph approve --task <taskName> --payload '<json>'
         · audience=host：依 payload.role 與 payload.prompt，用本會話工具完成 payload.outputs；
           完成後執行 sdd-graph complete --task <taskName> --result '<json>'
     - exit 1：讀 stderr，向使用者回報錯誤，結束
  3. 回到步驟 1

**關於 collect_prd 這個閘門**：它的 payload 帶著三個問題（PRD／設計／其他文件）與
答案的形狀。使用者可以給**路徑**（圖自己去讀）或**文字**。照答案的形狀原封不動
傳回去 —— 路徑就傳路徑，不要自己去讀了再改寫成文字。

**關於 dirty_worktree 這個閘門**（就地模式才有）：工作區有已跟蹤文件的改動時，
圖會停下來問使用者。`proceed` = **留在當前分支上繼續**（插件不切分支，使用者的
改動原封不動）；`abort` = 中止這一輪（checkpoint 留著，之後還能 resume）。

**關於長答案**：`approve --payload` 接受 `@<file>`（JSON 檔案的路徑）。
PRD 很長時把 payload 寫成檔案再傳，避免命令列的長度與引號問題。

禁止：跳過 complete/approve 自己推進階段、手動改 workflow-state.json、在工作單之外改檔案

<!--
  這個 LOOP 跟 `commands/resume.md` 的 LOOP 是同一份（只有第 1 步的指令不同）。
  命令 markdown 是各自獨立載入的，所以兩邊都要有一份；**改一邊就要改另一邊**，
  否則兩個命令會對同一張工作單講不同的話。
-->
