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
         · audience=user：把 payload 的 question/options 問使用者；
           使用者答完後執行 sdd-graph approve --task <taskName> --payload '<json>'
         · audience=host：依 payload.role 與 payload.prompt，用本會話工具完成 payload.outputs；
           完成後執行 sdd-graph complete --task <taskName> --result '<json>'
     - exit 1：讀 stderr，向使用者回報錯誤，結束
  3. 回到步驟 1

禁止：跳過 complete/approve 自己推進階段、手動改 workflow-state.json、在工作單之外改檔案

<!--
  這個 LOOP 跟 `commands/start.md` 的 LOOP 是同一份（只有第 1 步的指令不同）。
  命令 markdown 是各自獨立載入的，所以兩邊都要有一份；**改一邊就要改另一邊**，
  否則兩個命令會對同一張工作單講不同的話。
-->
