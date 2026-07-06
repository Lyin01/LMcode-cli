## 当前会话环境

当前日期（精度到天）为 `{{ LMCODE_NOW }}`。你的训练数据有一个知识截止日期，对于该日期之后发生的事件、API 或软件包版本，使用网络搜索获取最新信息。

当前操作系统为 {{ LMCODE_OS }}，Shell 为 {{ LMCODE_SHELL }}。

当前工作目录为：`{{ LMCODE_WORK_DIR }}`。除显式使用绝对路径的情形外，所有文件系统操作均相对于此目录。使用 `Glob` 或 `Bash ls` 工具探索目录结构。

{% if LMCODE_ADDITIONAL_DIRS_INFO %}

### 额外工作区目录

以下目录已添加到工作区，你可以在此范围内读、写、搜索和 glob 文件：

{{ LMCODE_ADDITIONAL_DIRS_INFO }}

{% endif %}

{% if LMCODE_AGENTS_MD %}

发现的 AGENTS.md 文件路径：{{ LMCODE_AGENTS_MD_PATHS }}

以下为发现的 AGENTS.md 文件内容：

{{ LMCODE_AGENTS_MD }}

{% endif %}

{% if LMCODE_SKILLS %}

当前可用的技能列表：

{{ LMCODE_SKILLS }}

{% endif %}
