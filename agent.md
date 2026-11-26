# 项目 Agent

本项目使用 GitHub Spec Kit v1.4.5 和 Codex 集成，脚本选用 PowerShell。项目级 Agent `spec_agent` 负责起草或检查指定的规范、计划或任务。

## 文件结构

```text
codex_bridge/
├── agent.md
├── AGENTS.md
├── .codex/
│   └── agents/
│       └── spec_agent.toml
├── .agents/
│   └── skills/
│       └── speckit-*/SKILL.md
└── .specify/
    ├── memory/constitution.md
    ├── scripts/powershell/
    ├── templates/
    ├── workflows/
    ├── integrations/
    ├── integration.json
    └── init-options.json
```

- `AGENTS.md` 是 Codex 读取的项目指引，链接到本文件与项目章程。
- `.codex/agents/spec_agent.toml` 定义项目 Agent 的名称、职责和指令。
- `.agents/skills/` 和 `.specify/` 由 Spec Kit 初始化，包含核心技能、脚本、模板和管理文件。项目原则写在 `.specify/memory/constitution.md`。
- 创建第一个功能时，Spec Kit 会建立 `specs/<feature>/`。规范、计划和任务分别写入 `spec.md`、`plan.md` 和 `tasks.md`。

## 使用方法

先安装同版本的 CLI，让项目脚本可以调用 `specify`。已安装同版本时可直接运行检查。

```powershell
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@v1.4.5
specify check
```

从项目根目录打开 Codex。如果 Codex 提示信任此项目，请确认后再继续。在对话中依次调用以下技能，并检查每一步生成的文件。

1. `$speckit-specify <功能描述>` 生成需求与验收标准。
2. `$speckit-plan` 生成实施计划。
3. `$speckit-tasks` 生成实施任务。
4. `$speckit-implement` 执行任务。
5. `$speckit-converge` 核对实现与验收标准。

需要将某一步委派给项目 Agent 时，可以在 Codex 对话里输入「请让 `spec_agent` 检查当前功能的规范和任务是否一致」。

## 初始化记录

下面的命令用于在空目录复现本项目的 Spec Kit 脚手架。该配置使用内置工作流，关闭 Codex 运行时事件。

```powershell
uvx --from git+https://github.com/github/spec-kit.git@v1.4.5 specify init --here --integration codex --script ps --non-interactive '--integration-options=--events false'
```

[Spec Kit v1.4.5](https://github.com/github/spec-kit/releases/tag/v1.4.5) · [Spec Kit 的 Codex 集成](https://github.github.com/spec-kit/integrations/codex.html) · [Codex 自定义 Agent](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)
