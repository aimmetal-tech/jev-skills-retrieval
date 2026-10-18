import { resolve } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ConversationTurn } from "../src/context.ts";

/** Synthetic metadata only: route evaluation does not read any skill bodies. */
export const catalog: Skill[] = [
  ["pdf", "Read, extract, create and verify PDF documents."],
  [
    "spreadsheets",
    "Analyze and edit Excel spreadsheets and CSV files, formulas and charts.",
  ],
  [
    "frontend",
    "Build React interfaces, components, responsive layouts and web dashboards.",
  ],
  ["browser", "Navigate websites and interact with browser forms and pages."],
  [
    "testing",
    "Write and run meaningful regression tests for software changes.",
  ],
  ["git-review", "Review Git diffs and changes for bugs and regression risks."],
  [
    "translation",
    "Translate text between Chinese and English while preserving meaning.",
  ],
  [
    "slides",
    "Create and edit PowerPoint presentation decks and slide layouts.",
  ],
].map(([name = "", description = ""]) => {
  const filePath = resolve("eval", "synthetic-skills", name, "SKILL.md");
  return {
    name,
    description,
    filePath,
    baseDir: resolve(filePath, ".."),
    disableModelInvocation: false,
    sourceInfo: {
      path: filePath,
      source: "synthetic-evaluation",
      scope: "temporary",
      origin: "top-level",
    },
  };
});

export interface EvaluationCase {
  id: string;
  prompt: string;
  required: string[];
  allowed: string[];
  history?: ConversationTurn[];
  previous?: string[];
}

export const cases: EvaluationCase[] = [
  {
    id: "pdf-cn",
    prompt: "从本地 PDF 合同中提取付款条款，并生成带页码的摘要 PDF。",
    required: ["pdf"],
    allowed: ["pdf"],
  },
  {
    id: "sheet-en",
    prompt:
      "Open sales.xlsx, repair the total revenue formulas and add a monthly revenue chart.",
    required: ["spreadsheets"],
    allowed: ["spreadsheets"],
  },
  {
    id: "multi-skill",
    prompt: "实现一个 React 收入看板，并为筛选逻辑添加自动回归测试。",
    required: ["frontend", "testing"],
    allowed: ["frontend", "testing"],
  },
  {
    id: "zero-hit",
    prompt: "2 加 3 等于多少？请只回答数字，不使用工具。",
    required: [],
    allowed: [],
  },
  {
    id: "continuation",
    prompt: "继续修复刚才发现的回归，并给出测试用例。",
    history: [
      {
        user: "Review this Git diff for bugs in revenue filtering.",
        assistant:
          "The filter fails when the date interval crosses a year boundary.",
      },
    ],
    previous: ["git-review"],
    required: ["testing"],
    allowed: ["testing", "git-review"],
  },
  {
    id: "switch-task",
    prompt: "现在换个任务：把这段中文产品介绍翻译为自然的英文。",
    previous: ["spreadsheets"],
    required: ["translation"],
    allowed: ["translation"],
  },
  {
    id: "browser",
    prompt: "打开供应商网站，在搜索框输入型号，然后读取页面显示的库存。",
    required: ["browser"],
    allowed: ["browser"],
  },
  {
    id: "slides",
    prompt: "把这些项目要点制作成可编辑的 PowerPoint 演示文稿。",
    required: ["slides"],
    allowed: ["slides"],
  },
];
