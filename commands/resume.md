---
description: 從 checkpoint 重發未完成的工作單（用法：/sdd-graph:resume --task <taskName>）
argument-hint: --task <taskName>
---

被重發的工作單是圖從 checkpoint 重發的：**同一張單、同一個 id、同一組 outputs**。
拿到之後先把這張單印出來（id／role／outputs）讓使用者知道要幹嘛，再開始做。
工作者要重讀工作單 `inputs` 列出的絕對路徑 —— 換會話之後不能靠上一段對話的記憶，
上一個會話做了什麼不是這張單的依據。

LOOP:
  1. 執行 sdd-graph resume --task <taskName>（<taskName> 取自本指令的引數）
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

**關於 collect_prd 這個閘門**（換會話之後也可能停在這裡）：它的 payload 帶著三個
問題（PRD／設計／其他文件）與答案的形狀。使用者可以給**路徑**（圖自己去讀）或
**文字**。照答案的形狀原封不動傳回去 —— 路徑就傳路徑。

**關於長答案**：`approve --payload` 接受 `@<file>`（JSON 檔案的路徑）。
PRD 很長時把 payload 寫成檔案再傳，避免命令列的長度與引號問題。

禁止：跳過 complete/approve 自己推進階段、手動改 workflow-state.json、在工作單之外改檔案

<!--
  這個 LOOP 跟 `commands/start.md` 的 LOOP 是同一份（只有第 1 步的指令不同）。
  命令 markdown 是各自獨立載入的，所以兩邊都要有一份；**改一邊就要改另一邊**，
  否則兩個命令會對同一張工作單講不同的話。
-->
